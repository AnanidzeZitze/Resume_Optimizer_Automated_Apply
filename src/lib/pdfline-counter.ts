import { execFile } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

const execFilePromise = util.promisify(execFile);

const SECTION_HEADERS = [
  'Professional Summary',
  'Skills & Certifications',
  'Experience',
  'Projects',
  'Education',
];

export interface SectionBaseline {
  type: 'section';
  total: number;
  fillBaseline?: Record<string, number>;
}

export interface BulletsBaseline {
  type: 'bullets';
  per_bullet: number[];
  total: number;
  fillBaseline?: Record<string, number>;
}

export type SlotBaseline = SectionBaseline | BulletsBaseline;
export type BaselineData = Record<string, SlotBaseline>;

export interface SlotDef {
  slotName: string;
  type: 'section' | 'bullets';
  anchor: string;
}

async function findPdftotextBin(): Promise<string> {
  const candidates = [
    '/opt/homebrew/bin/pdftotext',
    '/usr/local/bin/pdftotext',
    '/usr/bin/pdftotext',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  try {
    const { stdout } = await execFilePromise('which', ['pdftotext'], { timeout: 3000 });
    const found = stdout.trim();
    if (found) return found;
  } catch {}
  throw new Error(
    'pdftotext not found. Install with: brew install poppler (macOS) or apt install poppler-utils (Linux)'
  );
}

export async function runPdfToText(pdfBuffer: Buffer): Promise<string> {
  const runId = uuidv4();
  const tempDir = path.join(os.tmpdir(), `pdftext-${runId}`);
  await fs.promises.mkdir(tempDir, { recursive: true });
  const pdfPath = path.join(tempDir, 'input.pdf');
  const txtPath = path.join(tempDir, 'output.txt');
  try {
    await fs.promises.writeFile(pdfPath, pdfBuffer);
    const bin = await findPdftotextBin();
    await execFilePromise(bin, ['-layout', pdfPath, txtPath], { timeout: 15000 });
    return await fs.promises.readFile(txtPath, 'utf8');
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

function isSectionHeader(line: string): boolean {
  return SECTION_HEADERS.includes(line.trim());
}

export function extractSectionLines(lines: string[], sectionHeaderText: string): string[] {
  const headerIdx = lines.findIndex(l => l.trim() === sectionHeaderText);
  if (headerIdx === -1) return [];
  const collected: string[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (isSectionHeader(lines[i])) break;
    if (lines[i].trim() !== '') collected.push(lines[i]);
  }
  return collected;
}

export function extractBulletGroups(
  lines: string[],
  anchorCompany: string,
  allCompanyAnchors: string[]
): string[][] {
  // Step 1: Exact match (trimmed equality)
  let anchorIdx = lines.findIndex(l => l.trim() === anchorCompany.trim());

  // Step 2: Filtered contains match (no bullets, no metrics)
  if (anchorIdx === -1) {
    anchorIdx = lines.findIndex(l => {
      const trimmed = l.trim();
      return trimmed.includes(anchorCompany)
        && !trimmed.startsWith('•')
        && !trimmed.startsWith('∙')
        && !trimmed.startsWith('·')
        && !/\d+[%$]/.test(trimmed);
    });
  }

  if (anchorIdx === -1) {
    throw new Error(
      `ANCHOR_NOT_FOUND: Cannot locate company anchor "${anchorCompany}" in pdftotext output. First 10 lines: ${JSON.stringify(lines.slice(0, 10))}`
    );
  }

  const collected: string[] = [];
  for (let i = anchorIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (isSectionHeader(line)) break;
    // Stop at another company anchor line (but not if inside a bullet)
    if (
      allCompanyAnchors.some(
        c => c !== anchorCompany && line.includes(c) && !trimmed.startsWith('•')
      )
    )
      break;
    if (trimmed === '') continue;

    // Look-ahead: if the next non-empty line is a job-title anchor, this non-bullet line
    // is the company+dates header of the next \job entry leaking in — stop before it.
    // We only break on anchor-type stops (not section headers), because section headers
    // are already caught above and a bullet continuation line may legitimately appear
    // immediately before a section header (e.g. last job before "Projects").
    if (!trimmed.startsWith('•') && !trimmed.startsWith('∙') && !trimmed.startsWith('·')) {
      const nextNonEmpty = lines.slice(i + 1).find(l => l.trim() !== '');
      if (nextNonEmpty) {
        const nextTrimmed = nextNonEmpty.trim();
        const nextIsAnchorStop = allCompanyAnchors.some(
          c => c !== anchorCompany && nextNonEmpty.includes(c) && !nextTrimmed.startsWith('•')
        );
        if (nextIsAnchorStop) break;
      }
    }

    collected.push(line);
  }

  const groups: string[][] = [];
  let current: string[] = [];
  for (const line of collected) {
    const trimmed = line.trim();
    if (trimmed.startsWith('•') || trimmed.startsWith('∙') || trimmed.startsWith('·')) {
      if (current.length > 0) groups.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export function buildSlotDefs(texContent: string, slotNames: string[]): SlotDef[] {
  const defs: SlotDef[] = [];
  for (const name of slotNames) {
    const slotMarker = `% SLOT: ${name}`;
    const slotIdx = texContent.indexOf(slotMarker);
    if (slotIdx === -1) continue;

    const afterSlot = texContent.substring(slotIdx, slotIdx + 300);
    const beforeSlot = texContent.substring(0, slotIdx);

    if (afterSlot.includes('\\begin{itemize}')) {
      const jobMatches = [...beforeSlot.matchAll(/\\job\{[^}]+\}\s*\{([^}]+)\}/g)];
      const lastJob = jobMatches[jobMatches.length - 1];
      if (lastJob) {
        defs.push({ slotName: name, type: 'bullets', anchor: lastJob[1].trim() });
        continue;
      }
    }

    const sectionMatches = [...beforeSlot.matchAll(/\\sectiontitle\{([^}]+)\}/g)];
    const lastSection = sectionMatches[sectionMatches.length - 1];
    if (lastSection) {
      const rendered = lastSection[1]
        .replace(/\\&/g, '&')
        .replace(/\\\\/g, '')
        .replace(/\\[a-zA-Z]+\s*/g, '')
        .trim();
      defs.push({ slotName: name, type: 'section', anchor: rendered });
      continue;
    }

    console.warn(`[buildSlotDefs] Could not determine type/anchor for slot "${name}"`);
  }
  return defs;
}

/**
 * Measure a single specific slot from pdftotext output.
 * Used for isolated compile measurement (FIX 12).
 */
export function measureSpecificSlot(
  pdftextOutput: string,
  slotDef: SlotDef
): SlotBaseline | undefined {
  const lines = pdftextOutput.split('\n');
  const allAnchors = [slotDef.anchor];

  if (slotDef.type === 'section') {
    const contentLines = extractSectionLines(lines, slotDef.anchor);
    if (contentLines.length === 0) return undefined;
    return { type: 'section', total: contentLines.length };
  } else {
    try {
      const groups = extractBulletGroups(lines, slotDef.anchor, allAnchors);
      const perBullet = groups.map(g => g.length);
      if (perBullet.length === 0) return undefined;
      return {
        type: 'bullets',
        per_bullet: perBullet,
        total: perBullet.reduce((a, b) => a + b, 0),
      };
    } catch (e) {
      if ((e as Error).message.startsWith('ANCHOR_NOT_FOUND')) {
        console.warn(`[measureSpecificSlot] ${(e as Error).message}`);
        return undefined;
      }
      throw e;
    }
  }
}

export function measureSlotsFromText(pdftextOutput: string, slotDefs: SlotDef[]): BaselineData {
  const lines = pdftextOutput.split('\n');
  const allCompanyAnchors = slotDefs.filter(d => d.type === 'bullets').map(d => d.anchor);
  const result: BaselineData = {};

  for (const def of slotDefs) {
    if (def.type === 'section') {
      const contentLines = extractSectionLines(lines, def.anchor);
      result[def.slotName] = { type: 'section', total: contentLines.length };
    } else {
      try {
        const groups = extractBulletGroups(lines, def.anchor, allCompanyAnchors);
        const perBullet = groups.map(g => g.length);
        result[def.slotName] = {
          type: 'bullets',
          per_bullet: perBullet,
          total: perBullet.reduce((a, b) => a + b, 0),
        };
      } catch (e) {
        if ((e as Error).message.startsWith('ANCHOR_NOT_FOUND')) {
          console.warn(`[pdfline-counter] ${(e as Error).message}`);
          // Don't add to result — caller handles missing entries
        } else {
          throw e;
        }
      }
    }
  }
  return result;
}
