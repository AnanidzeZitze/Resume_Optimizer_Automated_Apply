/**
 * fill-measurement.ts
 *
 * Second validation layer: measures last-line fill percentage for each slot
 * by calling scripts/measure_fill.py via Python subprocess.
 *
 * A slot passes fill validation when every non-exempt element's last line
 * meets its threshold:
 *   - Professional Summary last line  ≥ 80 %
 *   - Each Skills category row        ≥ 80 %
 *   - Each multi-line bullet          ≥ 60 %
 *   - Each single-line bullet         ≥ 80 %  (no exemptions)
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import type { SlotDef } from './pdfline-counter';

// Estimated average word width in points for the resume's font at ~10pt.
// Used only when a rendered line has fewer than 3 words (insufficient sample for per-line measurement).
// Calibrated against measured Helvetica 10pt at 0.2in margins.
const FALLBACK_AVG_WORD_WIDTH_PT = 45.0;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface FillResult {
  identifier: string;       // "summary" | "skills_row_1" | "bullet_1" | ...
  totalLines: number;
  lastLineText: string;
  lastLineX1: number;       // points
  lastLineFill: number;     // percentage 0–100
  avgWordWidth: number;     // estimated average word width in points
  threshold: number;        // 80 for sections, 60 for bullets
  passes: boolean;
  exempt: boolean;          // always false — no elements are exempt from fill validation
}

export interface FillMeasurement {
  slotName: string;
  slotType: 'section' | 'bullets';
  pageWidth: number;
  leftMargin: number;
  rightMargin: number;
  usableWidth: number;
  results: FillResult[];
}

export interface FillValidationResult {
  slotName: string;
  passed: boolean;
  failingResults: FillResult[];
  measurement: FillMeasurement;
}

export interface FillMeasureConfig {
  slotName: string;
  slotType: 'section' | 'bullets';
  sectionType: 'summary' | 'skills' | 'bullets';
  anchor: string;
  allAnchors: string[];
  categoryNames: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Infer section_type from SlotDef and slot name. */
export function determineSectionType(
  slotDef: SlotDef
): 'summary' | 'skills' | 'bullets' {
  if (slotDef.type === 'bullets') return 'bullets';
  const lower = slotDef.slotName.toLowerCase();
  if (lower.includes('summary')) return 'summary';
  if (lower.includes('skill')) return 'skills';
  return 'summary'; // default for other section types
}

/** Extract category header names from a LaTeX skills slot content. */
export function extractSkillCategories(latexContent: string): string[] {
  const matches = [...latexContent.matchAll(/\\textbf\{([^:}]+):/g)];
  return matches.map(m =>
    m[1]
      .replace(/\\&/g, '&')
      .replace(/\\[a-zA-Z]+\s*/g, '')
      .replace(/[{}]/g, '')
      .trim()
  );
}

/** Build the config object to pass to the Python script. */
export function buildFillConfig(
  slotDef: SlotDef,
  slotContent: string,
  allSlotDefs: SlotDef[]
): FillMeasureConfig {
  const sectionType = determineSectionType(slotDef);
  const allBulletAnchors = allSlotDefs
    .filter(d => d.type === 'bullets')
    .map(d => d.anchor);

  return {
    slotName:      slotDef.slotName,
    slotType:      slotDef.type,
    sectionType,
    anchor:        slotDef.anchor,
    allAnchors:    allBulletAnchors,
    categoryNames: sectionType === 'skills' ? extractSkillCategories(slotContent) : [],
  };
}

/** True if fill measurement should be run for this slot type. */
export function slotNeedsFillCheck(slotDef: SlotDef): boolean {
  const st = determineSectionType(slotDef);
  return st === 'summary' || st === 'skills' || st === 'bullets';
}

// ─── Persistent Python server ───────────────────────────────────────────────────

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'measure_fill.py');

export interface FillServer {
  sendRequest(config: object): Promise<FillMeasurement | null>;
  terminate(): void;
}

export function createFillServer(): FillServer {
  const TIMEOUT_MS = parseInt(process.env.FILL_MEASUREMENT_TIMEOUT_MS ?? '60000', 10);

  const proc = spawn('python3', [SCRIPT_PATH, '--server'], {
    env: { ...process.env },
  });

  let pendingResolve: ((result: FillMeasurement | null) => void) | null = null;
  let pendingReject: ((err: Error) => void) | null = null;
  let buffer = '';

  proc.stdout.on('data', (data: Buffer) => {
    buffer += data.toString();
    const newlineIdx = buffer.indexOf('\n');
    if (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (pendingResolve) {
        const resolve = pendingResolve;
        const reject = pendingReject!;
        pendingResolve = null;
        pendingReject = null;
        try {
          const parsed = JSON.parse(line);
          if (parsed.error) {
            console.warn('[Fill] Server returned error:', parsed.error);
            resolve(null);
          } else {
            resolve(parsed as FillMeasurement);
          }
        } catch (e) {
          reject(new Error(`Failed to parse fill server response: ${line}`));
        }
      }
    }
  });

  proc.stderr.on('data', (d: Buffer) => {
    console.warn('[Fill] Python stderr:', d.toString());
  });

  proc.on('close', (code) => {
    if (pendingReject) {
      pendingReject(new Error(`Fill server exited with code ${code}`));
      pendingResolve = null;
      pendingReject = null;
    }
  });

  return {
    sendRequest(config: object): Promise<FillMeasurement | null> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingResolve = null;
          pendingReject = null;
          reject(new Error(`Fill server timed out after ${TIMEOUT_MS}ms`));
        }, TIMEOUT_MS);

        pendingResolve = (result) => {
          clearTimeout(timer);
          resolve(result);
        };
        pendingReject = (err) => {
          clearTimeout(timer);
          reject(err);
        };

        proc.stdin.write(JSON.stringify(config) + '\n');
      });
    },

    terminate(): void {
      proc.stdin.end();
      proc.kill();
    },
  };
}

// ─── Single-shot Python subprocess (legacy, used when no FillServer) ──────────

function callPython(configJson: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [SCRIPT_PATH], {
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('measure_fill.py timed out after 30 s'));
    }, 30_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`measure_fill.py exited ${code}: ${stderr.trim()}`));
      } else {
        resolve(stdout);
      }
    });

    proc.stdin.write(configJson);
    proc.stdin.end();
  });
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Measure last-line fill for a slot.
 * @param pdfBuffer  Compiled PDF as a Buffer.
 * @param config     FillMeasureConfig built by buildFillConfig().
 * @param server     Optional FillServer for persistent process reuse.
 * @returns FillMeasurement or null if measurement fails (non-fatal).
 */
export async function measureLineFill(
  pdfBuffer: Buffer,
  config: FillMeasureConfig,
  server?: FillServer
): Promise<FillMeasurement | null> {
  if (!slotNeedsFillCheck({ slotName: config.slotName, type: config.slotType, anchor: config.anchor })) {
    return null;
  }

  const runId = uuidv4();
  const tempDir = path.join(os.tmpdir(), `fill-${runId}`);
  await fs.promises.mkdir(tempDir, { recursive: true });
  const pdfPath = path.join(tempDir, 'input.pdf');

  try {
    await fs.promises.writeFile(pdfPath, pdfBuffer);

    const scriptConfig = {
      pdf_path:       pdfPath,
      slot_name:      config.slotName,
      slot_type:      config.slotType,
      section_type:   config.sectionType,
      anchor:         config.anchor,
      all_anchors:    config.allAnchors,
      category_names: config.categoryNames,
    };

    if (server) {
      const result = await server.sendRequest(scriptConfig);
      return result;
    } else {
      const stdout = await callPython(JSON.stringify(scriptConfig));
      const result = JSON.parse(stdout.trim()) as FillMeasurement;
      return result;
    }
  } catch (e) {
    console.warn('[Fill] measureLineFill failed (non-fatal):', e);
    return null;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate all FillResults in a measurement. Returns failing (non-exempt) results.
 * Single-line elements are auto-exempt (fill is meaningless with one line).
 */
export function validateFill(
  measurement: FillMeasurement
): FillValidationResult {
  const failingResults = measurement.results.filter(r => {
    if (r.exempt) return false;
    if (r.passes) return false;
    return true;
  });
  return {
    slotName:       measurement.slotName,
    passed:         failingResults.length === 0,
    failingResults,
    measurement,
  };
}

// ─── Failure message helpers ──────────────────────────────────────────────────

function estimateWordsToAdd(r: FillResult, usableWidth: number): number {
  const fillGap = r.threshold - r.lastLineFill;
  const aw = r.avgWordWidth > 0 ? r.avgWordWidth : FALLBACK_AVG_WORD_WIDTH_PT;
  return Math.max(1, Math.round((fillGap / 100) * usableWidth / aw));
}

/**
 * Build a human+AI-readable failure message for a single failing FillResult.
 * Used by buildFailureDescription in pipeline.ts.
 */
export function buildFillFailureMessage(
  failingResult: FillResult,
  measurement: FillMeasurement,
  currentContent: string,
  currentLineCount: number
): string {
  const wordsToAdd = estimateWordsToAdd(failingResult, measurement.usableWidth);
  const id = failingResult.identifier;
  const fill = failingResult.lastLineFill;
  const threshold = failingResult.threshold;
  const lastText = failingResult.lastLineText.slice(-60);

  if (id === 'summary') {
    const wordCount = currentContent.trim().split(/\s+/).filter(w => w.length > 0).length;
    return (
      `Professional Summary passed line count validation (${currentLineCount} lines as required) ` +
      `but the last line is only ${fill}% filled, below the ${threshold}% threshold. ` +
      `The last line currently ends with "...${lastText}". ` +
      `Current word count: ~${wordCount} words. ` +
      `Extend the final sentence or add a short concluding clause to push the last line past ${threshold}% fill. ` +
      `Do not add a new line — the total must remain ${currentLineCount} lines. ` +
      `Add approximately ${wordsToAdd} words (this is an approximation, not an exact target).`
    );
  }

  if (id.startsWith('skills_row_')) {
    const rowNum = parseInt(id.replace('skills_row_', ''), 10);
    return (
      `Skills row ${rowNum} passed line count validation but its last line is only ${fill}% filled, ` +
      `below the ${threshold}% threshold. ` +
      `The last line of this category row currently ends with "...${lastText}". ` +
      `Add more skills from the JD to this category — the most JD-relevant skills not yet listed. ` +
      `Insert them at the END of the category row, comma-separated. ` +
      `The row must remain on the same number of lines. Do not remove any existing skills. ` +
      `Add approximately ${wordsToAdd} skill term(s) (approximation).`
    );
  }

  if (id.startsWith('bullet_')) {
    const bulletNum = parseInt(id.replace('bullet_', ''), 10);
    const stripLatex = (s: string) =>
      s.replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1').replace(/\\[a-zA-Z]+/g, ' ').replace(/[{}\\]/g, ' ').replace(/\s+/g, ' ').trim();
    const wordCount = currentContent
      .split(/(?=\\item\b)/)
      .filter(p => p.trim().startsWith('\\item'))
      [bulletNum - 1] ?? '';
    const wc = stripLatex(wordCount).split(/\s+/).filter(w => w.length > 0).length;

    return (
      `Bullet ${bulletNum} passed line count validation (${failingResult.totalLines} rendered lines as required) ` +
      `but the last line is only ${fill}% filled, below the ${threshold}% threshold. ` +
      `The last line currently ends with "...${lastText}". ` +
      `The bullet needs more content on its last line. ` +
      `Current word count (approx, LaTeX stripped): ~${wc} words. ` +
      `To reach ${threshold}% fill, add approximately ${wordsToAdd} words to the END of the bullet. ` +
      `The additional words must naturally extend the final thought — do not pad with filler. ` +
      `Do not change the number of rendered lines; keep the line count at exactly ${failingResult.totalLines}. ` +
      `Inject the additional words into the last clause of the sentence. ` +
      `If a relevant JD keyword is available that is not already in the bullet, include it. ` +
      `(Word and fill counts are approximations.)`
    );
  }

  return `Fill validation failed for ${id}: ${fill}% < ${threshold}% threshold.`;
}

// ─── Baseline fill helpers ────────────────────────────────────────────────────

/** Convert FillMeasurement.results to a flat Record<string, number> for baseline.json. */
export function fillMeasurementToBaseline(measurement: FillMeasurement): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of measurement.results) {
    out[r.identifier] = r.lastLineFill;
  }
  return out;
}
