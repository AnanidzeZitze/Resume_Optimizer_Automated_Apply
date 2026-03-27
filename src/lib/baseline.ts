import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { compileLatexToPdf } from './latex-utils';
import {
  runPdfToText,
  buildSlotDefs,
  measureSlotsFromText,
  BaselineData,
  SlotDef,
} from './pdfline-counter';
import { parseSlots } from './latex-parser';
import {
  buildFillConfig,
  measureLineFill,
  fillMeasurementToBaseline,
  validateFill,
  FillServer,
} from './fill-measurement';

// ─── Race-condition mutex ──────────────────────────────────────────────────────

const baselineCreationLocks = new Map<string, Promise<BaselineData>>();

// ─── Public API ────────────────────────────────────────────────────────────────

export async function loadBaseline(baselinePath: string): Promise<BaselineData | null> {
  try {
    const raw = await fs.promises.readFile(baselinePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveBaseline(data: BaselineData, baselinePath: string): Promise<void> {
  // Atomic write: write to temp file then rename to final path
  const tempPath = `${baselinePath}.tmp.${process.pid}`;
  await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
  await fs.promises.rename(tempPath, baselinePath);
}

export async function measureBaseline(
  texContent: string,
  slotNames: string[],
  baselinePath: string,
  fillServer?: FillServer
): Promise<BaselineData> {
  console.log('[Baseline] Compiling original resume...');
  const pdfBuffer = await compileLatexToPdf(texContent);

  console.log('[Baseline] Running pdftotext -layout...');
  const pdftextOutput = await runPdfToText(pdfBuffer);

  const slotDefs = buildSlotDefs(texContent, slotNames);
  console.log('[Baseline] Slot defs:', JSON.stringify(slotDefs));

  const baseline = measureSlotsFromText(pdftextOutput, slotDefs);
  console.log('[Baseline] Measured:', JSON.stringify(baseline, null, 2));

  // Run fill measurement for each slot and attach fillBaseline
  const parsedSlots: Array<{ name: string; originalContent: string }> = parseSlots(texContent);
  for (const def of slotDefs) {
    const parsedSlot = parsedSlots.find(s => s.name === def.slotName);
    if (!parsedSlot) continue;
    try {
      const fillConfig = buildFillConfig(def, parsedSlot.originalContent, slotDefs);
      const fillMeasurement = fillServer
        ? await measureLineFill(pdfBuffer, fillConfig, fillServer)
        : await measureLineFill(pdfBuffer, fillConfig);
      if (fillMeasurement) {
        baseline[def.slotName].fillBaseline = fillMeasurementToBaseline(fillMeasurement);
        const fillValidation = validateFill(fillMeasurement);
        if (!fillValidation.passed) {
          console.warn(
            `[Baseline] Fill WARNING for "${def.slotName}" — original already below threshold:`,
            fillValidation.failingResults.map(r => `${r.identifier}: ${r.lastLineFill}% < ${r.threshold}%`)
          );
        }
        console.log(`[Baseline] Fill measured for "${def.slotName}":`, baseline[def.slotName].fillBaseline);
      }
    } catch (e) {
      console.warn(`[Baseline] Fill measurement failed for "${def.slotName}" (non-fatal):`, e);
    }
  }

  return baseline;
}

export async function getOrCreateBaseline(
  texContent: string,
  slotNames: string[],
  baselinePath: string,
  slotDefs?: SlotDef[],
  fillServer?: FillServer
): Promise<BaselineData> {
  // Check if another request is already creating this baseline
  if (baselineCreationLocks.has(baselinePath)) {
    console.log('[Baseline] Waiting for concurrent baseline creation...');
    return baselineCreationLocks.get(baselinePath)!;
  }

  const creationPromise = (async (): Promise<BaselineData> => {
    const currentHash = crypto.createHash('sha256').update(texContent).digest('hex');
    const existing = await loadBaseline(baselinePath);

    if (existing) {
      // Stale baseline invalidation
      const meta = (existing as any)._meta;
      if (!meta) {
        console.warn('[Baseline] Legacy baseline without _meta — regenerating');
        // fall through to measureBaseline
      } else if (meta.resumeHash !== currentHash) {
        console.log('[Baseline] Resume file has changed since baseline was created. Regenerating baseline.');
        try {
          await fs.promises.unlink(baselinePath);
        } catch {}
        // fall through to measureBaseline
      } else {
        // Check for missing fill baselines
        const effectiveSlotDefs = slotDefs ?? buildSlotDefs(texContent, slotNames);
        const missingSlots = effectiveSlotDefs.filter(def => !(existing as any)[def.slotName]);
        if (missingSlots.length > 0) {
          console.log(`[Baseline] Missing slots in baseline: ${missingSlots.map(d => d.slotName).join(', ')}. Regenerating...`);
          // fall through to measureBaseline below — handled after this block
        } else {
          const missingFill = effectiveSlotDefs.some(
            (def) => !(existing as any)[def.slotName]?.fillBaseline
          );

          if (missingFill) {
            console.log('[Baseline] fillBaseline missing for some slots — running fill backfill...');
            const pdfBuffer = await compileLatexToPdf(texContent);
            const parsedSlots: Array<{ name: string; originalContent: string }> = parseSlots(texContent);
            for (const def of effectiveSlotDefs) {
              if ((existing as any)[def.slotName]?.fillBaseline) continue;
              const parsedSlot = parsedSlots.find(s => s.name === def.slotName);
              if (!parsedSlot) continue;
              try {
                const fillConfig = buildFillConfig(def, parsedSlot.originalContent, effectiveSlotDefs);
                const fillMeasurement = fillServer
                  ? await measureLineFill(pdfBuffer, fillConfig, fillServer)
                  : await measureLineFill(pdfBuffer, fillConfig);
                if (fillMeasurement) {
                  (existing as any)[def.slotName].fillBaseline = fillMeasurementToBaseline(fillMeasurement);
                }
              } catch (e) {
                console.warn(`[Baseline] Fill backfill failed for "${def.slotName}" (non-fatal):`, e);
              }
            }
            await saveBaseline(existing, baselinePath);
            console.log('[Baseline] Fill backfill complete and saved.');
          }

          console.log('[Baseline] Loaded from', baselinePath);
          return existing;
        }
      }
    }

    console.log('[Baseline] No baseline found — measuring from compile...');
    const baseline = await measureBaseline(texContent, slotNames, baselinePath, fillServer);

    // _meta used for stale detection
    const dataWithMeta: any = {
      _meta: {
        resumeHash: currentHash,
        createdAt: new Date().toISOString(),
        version: 1,
      },
      ...baseline,
    };

    // Atomic write
    const tempPath = `${baselinePath}.tmp.${process.pid}`;
    await fs.promises.writeFile(tempPath, JSON.stringify(dataWithMeta, null, 2), 'utf8');
    await fs.promises.rename(tempPath, baselinePath);
    console.log('[Baseline] Saved to', baselinePath);
    return baseline;
  })();

  baselineCreationLocks.set(baselinePath, creationPromise);
  try {
    return await creationPromise;
  } finally {
    baselineCreationLocks.delete(baselinePath);
  }
}
