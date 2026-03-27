import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { generateJSON } from '@/lib/ai-client';
import { applyChanges, stripLatexToVisible } from '@/lib/latex-parser';
import { compileLatex, compileLatexToPdf } from '@/lib/latex-utils';
import { extractPreamble } from '@/lib/layout-probe';
import { fixJsonBackslashes } from '@/lib/json-utils';
import {
  runPdfToText,
  buildSlotDefs,
  measureSlotsFromText,
  measureSpecificSlot,
  SlotDef,
  SlotBaseline,
  BulletsBaseline,
  BaselineData,
} from '@/lib/pdfline-counter';
import {
  measureLineFill,
  validateFill,
  buildFillConfig,
  buildFillFailureMessage,
  fillMeasurementToBaseline,
  FillMeasurement,
  FillValidationResult,
  FillServer,
  createFillServer,
} from '@/lib/fill-measurement';
import { RunLogger } from './logger';

export { RunLogger } from './logger';
export type { BaselineData, SlotBaseline } from '@/lib/pdfline-counter';

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

type MismatchResult = 'PASS' | 'MISMATCH' | 'UNMEASURABLE';

interface ValidationResult {
  pass: boolean;
  reason?: string;
}

interface FailingSlot {
  slotName: string;
  expected: SlotBaseline;
  actual: SlotBaseline | undefined;
  mismatchType: MismatchResult | 'VALIDATION_FAILED' | 'FILL_TOO_LOW';
  validationReason?: string;
  escalationNote?: string;
  suggestion: any;
  originalContent: string;
  fillMeasurement?: FillMeasurement;
  fillValidation?: FillValidationResult;
}

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function getNonCommentPortion(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) {
      return line.slice(0, i);
    }
  }
  return line;
}

function stripLatexForWordCount(latex: string): string {
  return latex
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1') // \cmd{text} → text
    .replace(/\\[a-zA-Z]+/g, ' ')              // remove remaining \cmds
    .replace(/[{}\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(latex: string): number {
  const stripped = stripLatexForWordCount(latex);
  return stripped.split(/\s+/).filter(w => w.length > 0).length;
}

function splitIntoBullets(latexContent: string): string[] {
  return latexContent
    .split(/(?=\\item\b)/)
    .filter(p => p.trim().startsWith('\\item'));
}

// Guard against empty per_bullet array in corrupted baseline
function getExpectedBulletCount(slotName: string, baseline: BaselineData): number {
  const entry = baseline[slotName];
  if (!entry || entry.type !== 'bullets') return 0; // not a bullets slot
  const pb = (entry as BulletsBaseline).per_bullet;
  if (!Array.isArray(pb) || pb.length === 0) {
    throw new Error(`BASELINE_ERROR: Slot "${slotName}" has empty per_bullet array in baseline. Delete the baseline file and re-run to regenerate.`);
  }
  return pb.length;
}

// ─────────────────────────────────────────────────────────────

export const fixLatexOutput = (content: string): string =>
  content
    .replace(/\r\n/g, '\n')          // normalize Windows line endings
    .replace(/[ \t]+$/gm, '')        // strip trailing whitespace per line
    .replace(/\n{4,}/g, '\n\n');     // collapse 4+ consecutive blank lines to 2

// ─────────────────────────────────────────────────────────────
// Validates LaTeX content for structural integrity before compilation
// ─────────────────────────────────────────────────────────────

const BASE_COMMAND_WHITELIST = new Set([
  'textbf', 'textit', 'emph', 'underline', 'textsc', 'texttt',
  'item', 'begin', 'end',
  'hfill', 'par', 'noindent', 'vspace', 'hspace',
  'href', 'url',
  'skillbreak', 'sectiontitle', 'job',
  'LaTeX', 'TeX',
]);

export function validateLatexContent(
  content: string,
  originalContent: string,
  expectedBulletCount?: number
): ValidationResult {
  const lines = content.split('\n');

  // Extend whitelist with every command already used in the original slot
  const commandWhitelist = new Set(BASE_COMMAND_WHITELIST);
  for (const m of originalContent.matchAll(/\\([a-zA-Z]+)/g)) {
    commandWhitelist.add(m[1]);
  }

  // Check 1 — Brace balance (skip comment lines; skip escaped \{ \})
  let braceBalance = 0;
  for (const line of lines) {
    if (line.trimStart().startsWith('%')) continue;
    const nc = getNonCommentPortion(line);
    for (let i = 0; i < nc.length; i++) {
      if (nc[i] === '\\' && (nc[i + 1] === '{' || nc[i + 1] === '}')) {
        i++; // skip escaped brace
        continue;
      }
      if (nc[i] === '{') braceBalance++;
      else if (nc[i] === '}') braceBalance--;
    }
  }
  if (braceBalance !== 0) {
    return { pass: false, reason: `Unbalanced braces (net ${braceBalance > 0 ? '+' : ''}${braceBalance})` };
  }

  // Check 2 — Unescaped special characters in non-comment text
  const SPECIALS = ['&', '$', '_', '#'];
  for (let li = 0; li < lines.length; li++) {
    if (lines[li].trimStart().startsWith('%')) continue;
    const nc = getNonCommentPortion(lines[li]);
    for (const ch of SPECIALS) {
      for (let i = 0; i < nc.length; i++) {
        if (nc[i] === ch && (i === 0 || nc[i - 1] !== '\\')) {
          return { pass: false, reason: `Unescaped special character: ${ch} at line ${li + 1}` };
        }
      }
    }
  }

  // Check 3 — Bullet count preservation
  if (expectedBulletCount !== undefined && expectedBulletCount > 0) {
    const itemCount = (content.match(/\\item\b/g) ?? []).length;
    if (itemCount !== expectedBulletCount) {
      return { pass: false, reason: `Bullet count changed: expected ${expectedBulletCount}, got ${itemCount}` };
    }
  }

  // Check 4 — Known command integrity (letter-only commands)
  for (const m of content.matchAll(/\\([a-zA-Z]+)/g)) {
    if (!commandWhitelist.has(m[1])) {
      return { pass: false, reason: `Unknown LaTeX command: \\${m[1]}` };
    }
  }

  return { pass: true };
}

// ─────────────────────────────────────────────────────────────

function isMismatch(
  expected: SlotBaseline,
  actual: SlotBaseline | undefined
): MismatchResult {
  if (!actual) return 'UNMEASURABLE';
  if (expected.type === 'section' && actual.type === 'section') {
    return expected.total === actual.total ? 'PASS' : 'MISMATCH';
  }
  if (expected.type === 'bullets' && actual.type === 'bullets') {
    if (expected.per_bullet.length !== actual.per_bullet.length) return 'MISMATCH';
    return expected.per_bullet.every((e, i) => e === actual.per_bullet[i]) ? 'PASS' : 'MISMATCH';
  }
  return 'UNMEASURABLE';
}

// ─────────────────────────────────────────────────────────────

function buildFailureDescription(
  slotName: string,
  expected: SlotBaseline,
  actual: SlotBaseline | undefined,
  mismatchType: MismatchResult | 'VALIDATION_FAILED' | 'FILL_TOO_LOW',
  currentContent: string,
  originalContent: string,
  fillMeasurement?: FillMeasurement,
  fillValidation?: FillValidationResult
): string {
  if (mismatchType === 'FILL_TOO_LOW') {
    if (!fillValidation || !fillMeasurement) {
      return `Slot "${slotName}" failed fill validation — last-line fill percentage is below threshold.`;
    }
    return fillValidation.failingResults
      .map(r => buildFillFailureMessage(r, fillMeasurement, currentContent, r.totalLines))
      .join('\n\n');
  }

  if (mismatchType === 'VALIDATION_FAILED') {
    return `Slot "${slotName}" failed structural validation before compilation — this is a LaTeX syntax error in the AI output, not a line-count issue. Fix the LaTeX structure first.`;
  }

  if (mismatchType === 'UNMEASURABLE') {
    return `Slot "${slotName}" could not be located in the compiled PDF output at all. This usually means a structural LaTeX error — a missing \\begin{itemize}, a mismatched \\end{itemize}, or a broken command that prevented the slot from rendering entirely. Rebuild the structure carefully. Do not add or remove \\item entries.`;
  }

  if (!actual) return `Could not measure rendered lines for slot "${slotName}".`;

  if (expected.type === 'section' && actual.type === 'section') {
    const dir = actual.total > expected.total ? 'Too long — shorten it.' : 'Too short — expand it slightly.';
    const curWords = countWords(currentContent);
    const origWords = countWords(originalContent);
    return `Section rendered to ${actual.total} lines but must be exactly ${expected.total} lines. ${dir}\nCurrent word count (approx, LaTeX stripped): ~${curWords} words. Original word count: ~${origWords} words. This is an approximation — use as a calibration signal only, not a hard constraint. ${actual.total > expected.total ? `Remove approximately ${curWords - origWords} words without removing any injected keywords.` : `Add approximately ${origWords - curWords} words.`}`;
  }

  if (expected.type === 'bullets' && actual.type === 'bullets') {
    const currentBullets = splitIntoBullets(currentContent);
    const originalBullets = splitIntoBullets(originalContent);
    const issues: string[] = [];
    const maxLen = Math.max(expected.per_bullet.length, actual.per_bullet.length);

    for (let i = 0; i < maxLen; i++) {
      const exp = expected.per_bullet[i] ?? 0;
      const act = actual.per_bullet[i] ?? 0;
      if (exp !== act) {
        const curWc = countWords(currentBullets[i] ?? '');
        const origWc = countWords(originalBullets[i] ?? '');
        const lineDiff = exp - act;
        let dir: string;
        if (act > exp) {
          const wordsToRemove = Math.round((act - exp) * 10);
          dir = `Too long — remove approximately ${wordsToRemove} words. Cut the least important clause or qualifier. Do not remove injected keywords.`;
        } else {
          const wordsToAdd = Math.round(lineDiff * 10);
          dir = `Too short — you must add approximately ${wordsToAdd} words to push onto ${lineDiff} more rendered line${lineDiff > 1 ? 's' : ''}. Extend the FINAL sentence with a qualifying clause, tool name, scope detail, or outcome phrase. Do NOT just rephrase existing words — you must add new content that increases physical length.`;
        }
        issues.push(
          `Bullet ${i + 1} rendered to ${act} lines but must be exactly ${exp} lines. ${dir}\n  Word count — current: ~${curWc} words, original: ~${origWc} words. Use these as calibration: the original hit the target, so matching its word count is a strong signal.`
        );
      }
    }

    const passing = expected.per_bullet.filter((e, i) => e === (actual.per_bullet[i] ?? 0)).length;
    if (passing > 0) issues.push(`${passing} other bullet(s) passed — do not change those.`);
    return issues.join('\n');
  }

  return 'Type mismatch between expected and actual baseline.';
}

// ─────────────────────────────────────────────────────────────
// Isolated compilation helpers — compile one slot in a minimal wrapper document
// ─────────────────────────────────────────────────────────────

function buildIsolatedWrapper(
  texContent: string,
  slotDef: SlotDef,
  currentSlotContent: string
): string | null {
  const preamble = extractPreamble(texContent); // everything before \begin{document}
  const slotMarker = `% SLOT: ${slotDef.slotName}`;
  const slotIdx = texContent.indexOf(slotMarker);
  if (slotIdx === -1) return null;

  const beforeSlot = texContent.slice(0, slotIdx);

  if (slotDef.type === 'bullets') {
    const jobMatches = [...beforeSlot.matchAll(/\\job\s*\{[^}]*\}\s*\{[^}]*\}\s*\{[^}]*\}\s*\{[^}]*\}/g)];
    const lastJob = jobMatches[jobMatches.length - 1];
    if (!lastJob) {
      console.warn(`[Isolated] No \\job found before slot "${slotDef.slotName}" — falling back to full compile`);
      return null;
    }
    return `${preamble}\\begin{document}\n${lastJob[0]}\n${currentSlotContent}\n\\end{document}`;
  }

  if (slotDef.type === 'section') {
    const sectionMatches = [...beforeSlot.matchAll(/\\sectiontitle\{[^}]+\}/g)];
    const lastSection = sectionMatches[sectionMatches.length - 1];
    if (!lastSection) {
      console.warn(`[Isolated] No \\sectiontitle found before slot "${slotDef.slotName}" — falling back to full compile`);
      return null;
    }
    return `${preamble}\\begin{document}\n${lastSection[0]}\n${currentSlotContent}\n\\end{document}`;
  }

  return null;
}

async function compileAndMeasureIsolated(
  texContent: string,
  slotDef: SlotDef,
  currentSlotContent: string
): Promise<{ lineBaseline: SlotBaseline | undefined; pdfBuffer: Buffer | undefined }> {
  const wrapper = buildIsolatedWrapper(texContent, slotDef, currentSlotContent);
  if (!wrapper) return { lineBaseline: undefined, pdfBuffer: undefined };

  try {
    const { pdf } = await compileLatex(wrapper, { runs: 1, timeout: 30000 });
    if (!pdf) return { lineBaseline: undefined, pdfBuffer: undefined };
    const pdftextOutput = await runPdfToText(pdf);
    // Use measureSpecificSlot for isolated compilation (single-slot accuracy)
    const lineBaseline = measureSpecificSlot(pdftextOutput, slotDef);
    return { lineBaseline, pdfBuffer: pdf };
  } catch (e) {
    console.warn(`[Isolated] Compile/measure failed for "${slotDef.slotName}":`, e);
    return { lineBaseline: undefined, pdfBuffer: undefined };
  }
}

// ─────────────────────────────────────────────────────────────

function countConsecutiveStuck(history: unknown[]): number {
  if (history.length < 2) return 0;
  let count = 0;
  for (let i = history.length - 1; i >= 1; i--) {
    if (JSON.stringify(history[i]) === JSON.stringify(history[i - 1])) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// ─────────────────────────────────────────────────────────────
// Adds escalation instructions when a slot produces the same wrong output repeatedly
// ─────────────────────────────────────────────────────────────

function addEscalationIfNeeded(
  failing: FailingSlot[],
  measurementHistory: Map<string, (SlotBaseline | undefined)[]>,
  fillHistory: Map<string, number[]>
): FailingSlot[] {
  return failing.map(f => {
    let escalationNote = f.escalationNote ?? '';

    // Line count escalation — if same wrong count repeated, force a complete rewrite
    const history = measurementHistory.get(f.slotName) ?? [];
    if (history.length >= 2) {
      const last = history[history.length - 1];
      const prev = history[history.length - 2];
      if (JSON.stringify(last) === JSON.stringify(prev)) {
        const consecutiveStuck = countConsecutiveStuck(history);
        escalationNote += `\n\nESCALATION: This slot has produced the same incorrect line count for ${consecutiveStuck + 1} consecutive round(s) despite receiving fix instructions. The previous attempts made surface edits that did not change the rendered output. You must fundamentally restructure the content, not just rephrase it. Start from the original content below and rewrite from scratch, keeping the injected keywords but rebuilding the sentence structure entirely to hit the line count target.`;
      }
    }

    // Fill escalation: if fill improvement < 5% across last 2 rounds
    if (f.mismatchType === 'FILL_TOO_LOW') {
      const fHistory = fillHistory.get(f.slotName) ?? [];
      if (fHistory.length >= 2) {
        const lastFill = fHistory[fHistory.length - 1];
        const prevFill = fHistory[fHistory.length - 2];
        if (lastFill - prevFill < 5) {
          const lastLineSnippet = f.fillValidation?.failingResults[0]?.lastLineText ?? '';
          escalationNote += `\n\nFILL ESCALATION: The last-line fill percentage has not improved by more than 5% despite previous attempts. Simply rephrasing is not working. You must identify a completely different way to extend the final sentence or clause — consider a different concluding thought, a scope qualifier (region, scale, timeline), or a secondary metric. The current last line ends with: "${lastLineSnippet}".`;
        }
      }
    }

    return escalationNote !== (f.escalationNote ?? '') ? { ...f, escalationNote } : f;
  });
}

// ─────────────────────────────────────────────────────────────
// Batched retry — sends all failing slots to AI in a single call
// ─────────────────────────────────────────────────────────────

async function retryFailingSlots(
  failing: FailingSlot[],
  allSuggestions: any[],
  logger: RunLogger
): Promise<any[]> {
  const slotBlocks = failing.map(f => {
    const isFillOnly = f.mismatchType === 'FILL_TOO_LOW';
    const failureDesc =
      buildFailureDescription(
        f.slotName, f.expected, f.actual, f.mismatchType,
        f.suggestion.suggestedContent, f.originalContent,
        f.fillMeasurement, f.fillValidation
      ) + (f.escalationNote ?? '');

    const instruction = isFillOnly
      ? 'The line count is correct — do NOT change the number of rendered lines. Only extend the final sentence or clause to push the last line past the fill threshold. Inject additional words at the END of the last sentence only. Do not restructure.'
      : 'Stay as close as possible to the current content for bullets/parts that passed. For failing parts, use the original content as your structural reference, not the failed content. Do not fabricate metrics or change dates, company names, or job titles.';

    return `FAILING SLOT: ${f.slotName}
Failure type: ${isFillOnly ? 'FILL_TOO_LOW (line count is already correct)' : 'LINE_COUNT_MISMATCH'}
Failure: ${failureDesc}

1. Original content (reference for sentence structure and length):
${f.originalContent}

2. Current failed content (what was just compiled and measured wrong):
${f.suggestion.suggestedContent}

Instruction: ${instruction}`;
  }).join('\n\n──────────────────────────────\n\n');

  const prompt = `You are a LaTeX resume editor. The following slots failed line-count validation after PDF compilation. Fix each one independently — do not change anything in a slot not listed here.

LaTeX constraints (violations break compilation):
- Allowed commands: \\textbf{}, \\begin{itemize}, \\end{itemize}, \\item, \\\\, \\&, \\%, \\$, \\skillbreak
- Write with single backslashes. Do NOT double-escape.
- Never place \\\\ at start of content, after \\begin{itemize}, before \\end{itemize}, or at very end.
- Do not add or remove \\item entries. Do not change company names, job titles, or dates.

${slotBlocks}

Return ONLY this JSON structure with no markdown fences:
{
  "slots": {
    ${failing.map(f => `"${f.slotName}": "[corrected LaTeX content]"`).join(',\n    ')}
  }
}`;

  logger.log('RETRY_API_CALL', {
    slotCount: failing.length,
    slotNames: failing.map(f => f.slotName),
  });

  try {
    const raw = await generateJSON(prompt, 'gemini-2.0-flash');
    const parsed = JSON.parse(fixJsonBackslashes(raw));
    const slots: Record<string, string> = parsed.slots ?? {};

    // Immutable update — produce new array, touch only failing slots
    return allSuggestions.map(s => {
      if (slots[s.slotName] !== undefined) {
        let newContent = fixLatexOutput(String(slots[s.slotName]).replace(/\\n/g, '\n'));
        // For section slots, strip forced line breaks and trim trailing newlines
        if (failing.find(f => f.slotName === s.slotName)?.expected.type === 'section') {
          newContent = newContent.replace(/\\\\/g, '').trimEnd();
        }
        logger.log('RETRY_APPLIED', { slotName: s.slotName });
        return { ...s, suggestedContent: newContent };
      }
      return s;
    });
  } catch (e) {
    logger.log('RETRY_API_FAIL', { error: String(e) });
    return allSuggestions; // unchanged on parse failure
  }
}

// ─────────────────────────────────────────────────────────────
// Final full-resume compile to check page overflow and log fill status
// ─────────────────────────────────────────────────────────────

async function finalValidationPass(
  resumeContent: string,
  suggestions: any[],
  slotMetadata: any[],
  baseline: BaselineData,
  slotDefs: SlotDef[],
  logger: RunLogger,
  fillServer: FillServer
): Promise<{ pageOverflow: boolean; compileDurationMs: number; skipped: boolean }> {
  logger.log('FINAL_VALIDATION_START');
  const startMs = Date.now();

  let modifiedResume: string;
  try {
    const mods = suggestions.map((s: any) => ({ slotName: s.slotName, newContent: s.suggestedContent }));
    modifiedResume = applyChanges(resumeContent, mods);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.startsWith('SLOT_NOT_FOUND')) {
      logger.log('APPLY_CHANGES_FAIL', { error: msg });
      return { pageOverflow: false, compileDurationMs: 0, skipped: false };
    }
    throw e;
  }

  // Skip final compile if no slots were actually changed
  const anyChanged = suggestions.some((s: any) => {
    const meta = slotMetadata.find((m: any) => m.name === s.slotName);
    return meta && s.suggestedContent !== meta.originalContent;
  });

  if (!anyChanged) {
    logger.log('FINAL_COMPILE_SKIPPED', { reason: 'NO_CHANGES_APPLIED' });
    return { pageOverflow: false, compileDurationMs: 0, skipped: true };
  }

  try {
    const { pdf, pages } = await compileLatex(modifiedResume, { runs: 1, timeout: 45000 });
    const durationMs = Date.now() - startMs;

    logger.log('FINAL_COMPILE_DONE', { pages, durationMs });
    logger.log('COMPILE_EVENT', { type: 'FULL', slot: 'ALL', round: 'final', duration_ms: durationMs });

    if (pages > 1) {
      logger.log('PAGE_OVERFLOW_CRITICAL', {
        pages,
        action: 'revert_all',
        message: `Resume overflows to ${pages} pages. All optimized slots will be reverted. A ${pages}-page resume is worse than an unoptimized 1-page resume.`,
      });
      return { pageOverflow: true, compileDurationMs: durationMs, skipped: false };
    }

    if (pdf) {
      const pdftextOutput = await runPdfToText(pdf);
      const measured = measureSlotsFromText(pdftextOutput, slotDefs);
      const slotStatuses: Record<string, string> = {};
      for (const s of suggestions) {
        const expected = baseline[s.slotName];
        if (!expected) { slotStatuses[s.slotName] = 'no_baseline'; continue; }
        slotStatuses[s.slotName] = isMismatch(expected, measured[s.slotName]);
      }
      logger.log('FINAL_SLOT_STATUS', { slotStatuses, pages });

      // Fill measurement for all slots — non-fatal, logged as FILL_WARNING
      for (const s of suggestions) {
        const slotDef = slotDefs.find(d => d.slotName === s.slotName);
        if (!slotDef) continue;
        try {
          const fillConfig = buildFillConfig(slotDef, s.suggestedContent, slotDefs);
          const fillMeasurement = await measureLineFill(pdf, fillConfig, fillServer);
          if (fillMeasurement) {
            const fillValidation = validateFill(fillMeasurement);
            logger.log('FINAL_FILL_STATUS', {
              slotName: s.slotName,
              passed: fillValidation.passed,
              results: fillMeasurement.results.map(r => ({
                id: r.identifier,
                fill: r.lastLineFill,
                threshold: r.threshold,
                passes: r.passes,
                exempt: r.exempt,
              })),
            });
            if (!fillValidation.passed) {
              logger.log('FILL_WARNING', {
                slotName: s.slotName,
                failingResults: fillValidation.failingResults.map(r =>
                  `${r.identifier}: ${r.lastLineFill}% (threshold ${r.threshold}%)`
                ),
              });
            }
          }
        } catch (e) {
          logger.log('FILL_MEASURE_FAIL', { slotName: s.slotName, error: String(e) });
        }
      }
    }

    return { pageOverflow: false, compileDurationMs: durationMs, skipped: false };
  } catch (err) {
    logger.log('FINAL_COMPILE_FAIL', { error: String(err) });
    return { pageOverflow: false, compileDurationMs: 0, skipped: false };
  }
}

// ─────────────────────────────────────────────────────────────
// MAIN VALIDATION + RETRY LOOP
// ─────────────────────────────────────────────────────────────

export async function validateAndRetrySlots(
  resumeContent: string,
  initialSuggestions: any[],
  slotMetadata: any[],
  baseline: BaselineData,
  slotDefs: SlotDef[],
  logger: RunLogger
): Promise<any[]> {
  const MAX_RETRIES = 3;
  const reverted = new Set<string>();
  const revertDueToConfigError = new Set<string>();
  // Per-slot history of measured baselines, one entry per round they were measured
  const measurementHistory = new Map<string, (SlotBaseline | undefined)[]>();
  // Per-slot fill history: worst (lowest) fill % among failing identifiers per round
  const fillHistory = new Map<string, number[]>();
  // Last content that passed line-count validation (even if fill failed).
  // Used as revert target instead of original when max retries exceeded.
  const lastLinecountPassContent = new Map<string, string>();
  let previousFailingSlotNames = new Set<string>();
  let currentSuggestions = [...initialSuggestions];

  // Track previous content per slot to skip recompiling unchanged slots
  const previousContent = new Map<string, string>();

  // Compilation statistics for COMPILATION_SUMMARY log
  const compilationStats = {
    full: 0,
    isolated: 0,
    skipped_unchanged: 0,
    total_duration_ms: 0,
  };

  // Persistent Python subprocess for fill measurement — reused across all slots in a run
  const fillServer = createFillServer();

  try {
    for (let round = 0; round <= MAX_RETRIES; round++) {
      logger.log('ROUND_START', { round });

      // Round 0: check all active slots. Rounds 1+: only re-check previously-failing slots.
      const slotsToCheck = currentSuggestions.filter(s =>
        !reverted.has(s.slotName) &&
        !revertDueToConfigError.has(s.slotName) &&
        (round === 0 || previousFailingSlotNames.has(s.slotName))
      );

      // Pre-compile structural validation
      const failing: FailingSlot[] = [];
      const validSlots: any[] = [];

      for (const s of slotsToCheck) {
        const meta = slotMetadata.find((m: any) => m.name === s.slotName);

        // Wrap in try-catch — a corrupted baseline throws BASELINE_ERROR
        let expectedBullets: number | undefined;
        try {
          const count = getExpectedBulletCount(s.slotName, baseline);
          expectedBullets = count > 0 ? count : undefined;
        } catch (e) {
          const msg = (e as Error).message;
          if (msg.startsWith('BASELINE_ERROR')) {
            logger.log('BASELINE_CONFIG_ERROR', { slotName: s.slotName, error: msg });
            revertDueToConfigError.add(s.slotName);
            continue; // skip validation for this slot
          }
          throw e;
        }

        const vResult = validateLatexContent(
          s.suggestedContent,
          meta?.originalContent ?? '',
          expectedBullets
        );

        if (!vResult.pass) {
          logger.log('VALIDATION_FAIL', { round, slotName: s.slotName, reason: vResult.reason });
          const expected = baseline[s.slotName];
          if (expected) {
            failing.push({
              slotName: s.slotName,
              expected,
              actual: undefined,
              mismatchType: 'VALIDATION_FAILED',
              validationReason: vResult.reason,
              suggestion: s,
              originalContent: meta?.originalContent ?? '',
            });
          }
        } else {
          validSlots.push(s);
        }
      }

      // ── Compile + measure validated slots ─────────────────
      if (round === 0) {
        // Round 0: full resume compile
        let modifiedResume: string;
        try {
          const mods = validSlots.map((s: any) => ({ slotName: s.slotName, newContent: s.suggestedContent }));
          modifiedResume = applyChanges(resumeContent, mods);
        } catch (e) {
          const msg = (e as Error).message;
          if (msg.startsWith('SLOT_NOT_FOUND')) {
            logger.log('APPLY_CHANGES_FAIL', { round, error: msg });
            break;
          }
          throw e;
        }

        try {
          const startMs = Date.now();
          const pdfBuffer = await compileLatexToPdf(modifiedResume);
          const round0DurationMs = Date.now() - startMs;
          logger.log('FULL_COMPILE_DONE', { round: 0, durationMs: round0DurationMs, slotCount: validSlots.length });
          logger.log('COMPILE_EVENT', { type: 'FULL', slot: 'ALL', round: 0, duration_ms: round0DurationMs });
          compilationStats.full += 1;
          compilationStats.total_duration_ms += round0DurationMs;

          const pdftextOutput = await runPdfToText(pdfBuffer);
          const measured = measureSlotsFromText(pdftextOutput, slotDefs);

          for (const s of validSlots) {
            const expected = baseline[s.slotName];
            if (!expected) continue;
            const actual = measured[s.slotName];
            const result = isMismatch(expected, actual);

            const history = measurementHistory.get(s.slotName) ?? [];
            history.push(actual);
            measurementHistory.set(s.slotName, history);

            logger.log('MEASURE', { round: 0, slotName: s.slotName, result, actual, expected });

            if (result !== 'PASS') {
              const meta = slotMetadata.find((m: any) => m.name === s.slotName);
              failing.push({ slotName: s.slotName, expected, actual, mismatchType: result, suggestion: s, originalContent: meta?.originalContent ?? '' });
            } else {
              // Line count passes — run fill measurement
              const slotDef = slotDefs.find(d => d.slotName === s.slotName);
              if (slotDef) {
                try {
                  const fillConfig = buildFillConfig(slotDef, s.suggestedContent, slotDefs);
                  const fillMeasurement = await measureLineFill(pdfBuffer, fillConfig, fillServer);
                  if (fillMeasurement) {
                    const fillValidation = validateFill(fillMeasurement);
                    logger.log('FILL_MEASURE', { round: 0, slotName: s.slotName, passed: fillValidation.passed,
                      fills: fillMeasurement.results.map(r => ({ id: r.identifier, fill: r.lastLineFill, passes: r.passes, exempt: r.exempt })) });
                    if (!fillValidation.passed) {
                      const meta = slotMetadata.find((m: any) => m.name === s.slotName);
                      const worstFill = Math.min(...fillValidation.failingResults.map(r => r.lastLineFill));
                      const fh = fillHistory.get(s.slotName) ?? [];
                      fh.push(worstFill);
                      fillHistory.set(s.slotName, fh);
                      lastLinecountPassContent.set(s.slotName, s.suggestedContent);
                      failing.push({
                        slotName: s.slotName, expected, actual, mismatchType: 'FILL_TOO_LOW',
                        suggestion: s, originalContent: meta?.originalContent ?? '',
                        fillMeasurement, fillValidation,
                      });
                    }
                  }
                } catch (e) {
                  logger.log('FILL_MEASURE_FAIL', { round: 0, slotName: s.slotName, error: String(e) });
                }
              }
            }
          }
        } catch (err) {
          logger.log('COMPILE_FAIL', { round: 0, error: String(err) });
          break;
        }
      } else {
        // Rounds 1+: isolated compile per failing slot
        for (const s of validSlots) {
          const slotDef = slotDefs.find(d => d.slotName === s.slotName);
          const expected = baseline[s.slotName];
          if (!slotDef || !expected) continue;

          const meta = slotMetadata.find((m: any) => m.name === s.slotName);

          // Skip compile if content unchanged since last round
          const prevContent = previousContent.get(s.slotName);
          if (prevContent !== undefined && prevContent === s.suggestedContent) {
            const lastMeasurement = measurementHistory.get(s.slotName);
            const actual = lastMeasurement ? lastMeasurement[lastMeasurement.length - 1] : undefined;
            logger.log('ISOLATED_SKIP_UNCHANGED', { round, slotName: s.slotName });
            logger.log('COMPILE_DECISION', { slot: s.slotName, round, content_changed: false, reason: 'CONTENT_UNCHANGED_SKIP' });
            compilationStats.skipped_unchanged += 1;
            const result = isMismatch(expected, actual);
            if (result !== 'PASS') {
              failing.push({ slotName: s.slotName, expected, actual, mismatchType: result, suggestion: s, originalContent: meta?.originalContent ?? '' });
            }
            continue;
          }
          previousContent.set(s.slotName, s.suggestedContent);

          logger.log('COMPILE_DECISION', { slot: s.slotName, round, content_changed: true, reason: 'CONTENT_CHANGED' });
          const isolatedStartMs = Date.now();
          const { lineBaseline: actual, pdfBuffer: isolatedPdf } =
            await compileAndMeasureIsolated(resumeContent, slotDef, s.suggestedContent);
          const durationMs = Date.now() - isolatedStartMs;
          logger.log('COMPILE_EVENT', { type: 'ISOLATED', slot: s.slotName, round, duration_ms: durationMs });
          compilationStats.isolated += 1;
          compilationStats.total_duration_ms += durationMs;

          const history = measurementHistory.get(s.slotName) ?? [];
          history.push(actual);
          measurementHistory.set(s.slotName, history);

          const result = isMismatch(expected, actual);
          logger.log('ISOLATED_MEASURE', { round, slotName: s.slotName, result, durationMs, actual });

          if (result !== 'PASS') {
            failing.push({ slotName: s.slotName, expected, actual, mismatchType: result, suggestion: s, originalContent: meta?.originalContent ?? '' });
          } else if (isolatedPdf) {
            // Line count passes — run fill measurement on isolated PDF
            try {
              const fillConfig = buildFillConfig(slotDef, s.suggestedContent, slotDefs);
              const fillMeasurement = await measureLineFill(isolatedPdf, fillConfig, fillServer);
              if (fillMeasurement) {
                const fillValidation = validateFill(fillMeasurement);
                logger.log('FILL_MEASURE', { round, slotName: s.slotName, passed: fillValidation.passed,
                  fills: fillMeasurement.results.map(r => ({ id: r.identifier, fill: r.lastLineFill, passes: r.passes, exempt: r.exempt })) });
                if (!fillValidation.passed) {
                  const worstFill = Math.min(...fillValidation.failingResults.map(r => r.lastLineFill));
                  const fh = fillHistory.get(s.slotName) ?? [];
                  fh.push(worstFill);
                  fillHistory.set(s.slotName, fh);
                  lastLinecountPassContent.set(s.slotName, s.suggestedContent);
                  failing.push({
                    slotName: s.slotName, expected, actual, mismatchType: 'FILL_TOO_LOW',
                    suggestion: s, originalContent: meta?.originalContent ?? '',
                    fillMeasurement, fillValidation,
                  });
                }
              }
            } catch (e) {
              logger.log('FILL_MEASURE_FAIL', { round, slotName: s.slotName, error: String(e) });
            }
          }
        }
      }

      // ── Exit / revert / retry ──────────────────────────────
      if (failing.length === 0) {
        logger.log('ALL_PASS', { round });
        break;
      }

      if (round === MAX_RETRIES) {
        for (const f of failing) {
          const meta = slotMetadata.find((m: any) => m.name === f.slotName);
          const savedPassingContent = lastLinecountPassContent.get(f.slotName);
          if (savedPassingContent) {
            // A previous round passed line-count validation; keep that version rather than
            // reverting to original (content was optimised, only fill fell short).
            logger.log('REVERT_TO_LAST_PASSING', { slotName: f.slotName, reason: `Max retries (${MAX_RETRIES}) exceeded`, mismatchType: f.mismatchType });
            currentSuggestions = currentSuggestions.map(s =>
              s.slotName === f.slotName
                ? { ...s, suggestedContent: savedPassingContent }
                : s
            );
          } else {
            reverted.add(f.slotName);
            logger.log('REVERT', { slotName: f.slotName, reason: `Max retries (${MAX_RETRIES}) exceeded`, mismatchType: f.mismatchType });
            currentSuggestions = currentSuggestions.map(s =>
              s.slotName === f.slotName
                ? { ...s, suggestedContent: meta?.originalContent ?? s.suggestedContent }
                : s
            );
          }
        }
        break;
      }

      previousFailingSlotNames = new Set(failing.map(f => f.slotName));

      // Add escalation notes for slots stuck at the same incorrect count or fill
      const failingWithEscalation = addEscalationIfNeeded(failing, measurementHistory, fillHistory);

      logger.log('RETRY_ROUND', {
        nextRound: round + 1,
        failingSlots: failing.map(f => ({ slotName: f.slotName, mismatchType: f.mismatchType })),
      });

      // Single batched API call for all failing slots
      currentSuggestions = await retryFailingSlots(failingWithEscalation, currentSuggestions, logger);
    }

    // Final full-resume validation
    const { pageOverflow, compileDurationMs: finalDurationMs, skipped: finalSkipped } = await finalValidationPass(
      resumeContent, currentSuggestions, slotMetadata, baseline, slotDefs, logger, fillServer
    );

    if (!finalSkipped) {
      compilationStats.full += 1;
      compilationStats.total_duration_ms += finalDurationMs;
    }

    if (pageOverflow) {
      currentSuggestions = currentSuggestions.map(s => {
        const meta = slotMetadata.find((m: any) => m.name === s.slotName);
        return { ...s, suggestedContent: meta?.originalContent ?? s.suggestedContent };
      });
      logger.log('ALL_REVERTED_DUE_TO_OVERFLOW');
    }

    // Final summary
    logger.log('FINAL_SUMMARY', {
      slots: currentSuggestions.map(s => ({
        slotName: s.slotName,
        status: reverted.has(s.slotName) ? 'reverted' : 'optimized',
      })),
    });

    // Compilation summary
    const totalCompiles = compilationStats.full + compilationStats.isolated;
    const avgDuration = totalCompiles > 0 ? Math.round(compilationStats.total_duration_ms / totalCompiles) : 0;
    logger.log('COMPILATION_SUMMARY', {
      total: totalCompiles,
      full: compilationStats.full,
      isolated: compilationStats.isolated,
      skipped_unchanged: compilationStats.skipped_unchanged,
      duration_total_ms: compilationStats.total_duration_ms,
      duration_avg_ms: avgDuration,
    });

    await logger.flush();
    return currentSuggestions;
  } finally {
    fillServer.terminate();
  }
}

// ─────────────────────────────────────────────────────────────
// PASS 1 — STRATEGIC ANALYSIS
// ─────────────────────────────────────────────────────────────

export async function performStrategicAnalysis(
  jobDescription: string,
  linkedinContent: string,
  slotMetadata: any[],
  logger: RunLogger
) {
  // Per-run random boundary to prevent prompt injection via slot content
  const SLOT_BOUNDARY = `===SLOT_BOUNDARY_${crypto.randomBytes(8).toString('hex')}===`;
  const safeContent = (content: string) => content.replace(new RegExp(SLOT_BOUNDARY, 'g'), '[BOUNDARY_REMOVED]');

  const pass1Prompt = `
You are a Senior Recruiter and Resume Strategist who deeply understands both ATS mechanics and what hiring managers actually want to see. Analyze the resume against the job description and produce a structured strategic plan.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL ATS FACTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Greenhouse Talent Filtering uses EXACT-MATCH boolean logic only. "SEO" will NOT match "Search Engine Optimization." Every critical keyword must appear in its exact JD form — both abbreviation and full form, always.
Lever's native search is also exact-match. Its Talent Fit semantic feature is opt-in and not universal.
The three real optimization targets are: (1) exact keyword presence, (2) semantic relevance to the JD, (3) human readability in under 8 seconds.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — DETECT ROLE TYPE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Classify the target role into exactly one of:
MARKETING_ANALYTICS — SQL, data modeling, attribution, dashboards, statistical analysis. Hard/soft ratio: 85/15.
DIGITAL_MARKETING — Paid channels, SEO/SEM, content, email, social. Hard/soft ratio: 70/30.
GROWTH_MARKETING — Funnel optimization, A/B testing, acquisition, retention, experimentation. Hard/soft ratio: 75/25.
MARKETING_OPERATIONS — MAP platforms (Marketo, HubSpot, Pardot), CRM integration, lead scoring, data governance. Hard/soft ratio: 85/15. If a specific MAP is named in JD, flag as critical if missing from resume.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — JD DECONSTRUCTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Extract from the job description:
- REQUIRED skills: Terms under "Requirements," "Qualifications," "Must have," "Essential." Non-negotiable.
- PREFERRED skills: Terms under "Preferred," "Desired," "Nice to have," "Plus."
- HIGH-PRIORITY SIGNALS: Any skill/tool/term appearing more than once, or in both job title and responsibilities. These are what the employer cares most about.
- RESPONSIBILITY VERBS: Action verbs from the responsibilities section. The resume must mirror these.
- SENIORITY SIGNALS: How the JD describes the role level ("owns," "drives," "leads" vs. "supports," "assists"). Match exactly.
- COMPANY TYPE: STARTUP (terse, high-velocity, scrappy), ENTERPRISE (structured, formal, governance), or GENERAL.
- CULTURE KEYWORDS: Values-based adjectives (e.g., "data-driven," "cross-functional," "collaborative"). Extract top 2 to weave into the summary.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3 — GAP ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Compare every required and preferred skill against the resume content:
PRESENT_AND_STRONG: Clearly evidenced with a metric or achievement. Verify keyword form matches JD exactly.
PRESENT_BUT_WEAK: Exists but buried, unquantified, or named differently than the JD uses. Flag for rewrite with both terms.
MISSING: Not in the resume at all. Mark CRITICAL_GAP (required) or MINOR_GAP (preferred). For CRITICAL_GAPs, provide a reframeInstruction: how adjacent experience can demonstrate the skill without fabrication.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 4 — SLOT-LEVEL STRATEGY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For each resume slot, produce:
- strategy: A SPECIFIC rewrite instruction (not generic). Reference actual metrics, actual JD requirements, actual slot content. Example: "Lead with the $50K budget reallocation and connect explicitly to ROI by channel — mirrors JD's 'performance marketing budget ownership.' Inject 'marketing mix' and 'attribution' as the two highest-gap keywords."
- targetKeywords: Exact JD spellings and capitalizations. Include both forms if JD uses both (e.g., "Search Engine Optimization (SEO)").
- irrelevancyScores: For bullet slots only — rate each bullet 1–5 for JD relevance (5=directly required, 1=no connection). Bullets rated 1–2 should be reframed to transferable skills (leadership, budget management, data analysis, cross-functional coordination). Provide a note for 1–2 rated bullets explaining the reframe approach.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 5 — PRE-OPTIMIZATION SCORING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Score the resume as-is using these weights (each scored 0–1, then multiplied by weight):
Hard skills match:      40% — (JD required hard skills found in resume) / (total JD required hard skills)
Job title match:        15% — Exact=1.0, Partial=0.5, Missing=0
Soft skills match:      10% — (JD soft skills found) / (total JD soft skills)
Education alignment:    10% — Degree level matches JD requirement=1.0
Keyword distribution:   10% — Core keywords appearing 2–3x across different sections (capped)
Achievement density:    10% — (bullets with quantified metrics) / (total bullets)
Formatting compliance:   5% — Single column, selectable PDF, standard headers=1.0
Report total as 0–100. List the specific gaps pulling the score down.
Target post-optimization: 75–80%. Above 80% risks keyword stuffing. Below 65% = high rejection risk.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INPUTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Job Description:
${jobDescription}

Candidate Context (LinkedIn):
${linkedinContent || 'No additional context provided.'}

Resume Slots:
${slotMetadata.map((m: any) => `Slot: ${m.name}\nContent: ${safeContent(m.cleanText)}`).join(`\n${SLOT_BOUNDARY}\n`)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT JSON — return only raw JSON, no markdown fences
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "roleType": "MARKETING_ANALYTICS | DIGITAL_MARKETING | GROWTH_MARKETING | MARKETING_OPERATIONS",
  "overview": {
    "verdict": "string",
    "primaryGaps": ["string"],
    "companyType": "STARTUP | ENTERPRISE | GENERAL",
    "companyName": "exact company name from the job description"
  },
  "jdDeconstruction": {
    "requiredSkills": ["exact JD strings"],
    "preferredSkills": ["exact JD strings"],
    "highPrioritySignals": ["exact JD strings"],
    "responsibilityVerbs": ["string"],
    "seniorityLevel": "string — describe the expected ownership level",
    "cultureKeywords": ["string", "string"]
  },
  "gapAnalysis": {
    "presentAndStrong": [{ "skill": "string", "evidence": "string" }],
    "presentButWeak": [{ "skill": "string", "resumeTerm": "string", "jdTerm": "string" }],
    "missing": [{ "skill": "string", "type": "CRITICAL_GAP | MINOR_GAP", "reframeInstruction": "string" }]
  },
  "preOptimizationScore": {
    "total": 0,
    "breakdown": {
      "hardSkillsMatch": 0,
      "jobTitleMatch": 0,
      "softSkillsMatch": 0,
      "educationAlignment": 0,
      "keywordDistribution": 0,
      "achievementDensity": 0,
      "formattingCompliance": 0
    },
    "gaps": ["string"]
  },
  "changePlan": [
    {
      "slotName": "string",
      "strategy": "string",
      "targetKeywords": ["exact JD strings"],
      "irrelevancyScores": [
        { "bulletIndex": 0, "score": 1, "note": "reframe approach for score 1-2 bullets" }
      ]
    }
  ]
}
`;

  console.log('[Analyze] Pass 1 Starting');
  const analysisResponse = await generateJSON(pass1Prompt, 'gemini-2.0-flash');
  const analysisData = JSON.parse(analysisResponse);

  logger.log('PASS1_COMPLETE', {
    roleType: analysisData.roleType,
    companyType: analysisData.overview?.companyType,
    companyName: analysisData.overview?.companyName,
    preScore: analysisData.preOptimizationScore?.total,
    criticalGaps: (analysisData.gapAnalysis?.missing ?? [])
      .filter((g: any) => g.type === 'CRITICAL_GAP')
      .map((g: any) => g.skill),
  });

  console.log('[Analyze] Pass 1 Complete — roleType:', analysisData.roleType, '| preScore:', analysisData.preOptimizationScore?.total);
  return analysisData;
}

// ─────────────────────────────────────────────────────────────

function buildSlotPromptBlock(m: any, analysisData: any): string {
  const baseline: SlotBaseline | undefined = m.baseline;
  const strategy = analysisData.changePlan?.find((p: any) => p.slotName === m.name);
  const fillBaseline: Record<string, number> = (m.baseline as any)?.fillBaseline ?? {};

  let block = `Slot: ${m.name}\n`;
  block += `Strategy: ${strategy?.strategy || 'Optimize for relevance and keyword alignment.'}\n`;
  block += `Keywords to inject (exact JD form): ${(strategy?.targetKeywords || []).join(', ')}\n`;

  if (strategy?.irrelevancyScores && strategy.irrelevancyScores.length > 0) {
    block += `Bullet relevancy scores (1=low, 5=high — reframe bullets rated 1-2):\n`;
    strategy.irrelevancyScores.forEach((s: any) => {
      block += `  Bullet ${s.bulletIndex + 1}: score=${s.score}${s.note ? ` — ${s.note}` : ''}\n`;
    });
  }

  if (!baseline) {
    block += `Line constraint: preserve existing content length.\n`;
    return block;
  }

  if (baseline.type === 'section') {
    block += `Line constraint: The rewritten content must occupy EXACTLY ${baseline.total} physical rendered lines when compiled to PDF. A physical line is one rendered line in the PDF, not a source code line. Content that is too long wraps and produces more lines than allowed. Do not add blank lines.\n`;

    // Fill constraint for section slots
    const summaryFill = fillBaseline['summary'];
    if (summaryFill !== undefined) {
      block += `Fill constraint: optimised last line must be ≥80% filled. (Original was ${summaryFill}% — shown for calibration only; content must still be fully rewritten.)\n`;
    } else {
      // Skills rows
      const rowKeys = Object.keys(fillBaseline).filter(k => k.startsWith('skills_row_')).sort();
      if (rowKeys.length > 0) {
        const rowCalibration = rowKeys.map(k => `row ${k.replace('skills_row_', '')}: ${fillBaseline[k]}%`).join(', ');
        block += `Fill constraint: every optimised category row's last line must be ≥80% filled. Original fills (calibration only): ${rowCalibration}\n`;
      } else {
        block += `Fill constraint: last line must be ≥80% filled.\n`;
      }
    }
  } else {
    const pb = (baseline as BulletsBaseline).per_bullet;
    block += `Line constraint: This slot has ${pb.length} bullets. Preserve exactly ${pb.length} \\item entries. Per-bullet PDF line counts and fill requirements:\n`;
    pb.forEach((n, i) => {
      const threshold = n === 1 ? 80 : 60;
      const origFill = fillBaseline[`bullet_${i + 1}`];
      const calibration = origFill !== undefined ? ` (original fill: ${origFill}%)` : '';
      block += `  - Bullet ${i + 1}: exactly ${n} rendered PDF line${n !== 1 ? 's' : ''} | optimised last line must be ≥${threshold}% filled${calibration}\n`;
    });
    block += `A rendered line is a physical line in the compiled PDF, not a source code line.\n`;
    block += `Fill rule: ALL bullets must be rewritten for JD alignment. The fill % above is the REQUIRED threshold for the optimised output — it is not a signal to leave any bullet unchanged. Design each bullet so its last rendered line extends ≥60% across the page (≥80% for single-line bullets). End bullets with a tool name, outcome phrase, scope detail, or context clause — never leave a last line with 1–3 words.\n`;
  }

  return block;
}

// ─────────────────────────────────────────────────────────────
// PASS 2 — GENERATE OPTIMIZED CONTENT
// ─────────────────────────────────────────────────────────────

export async function generateOptimizedContent(
  analysisData: any,
  slotMetadata: any[],
  companyType: string,
  resumeContent: string,
  jobDescription: string,
  logger: RunLogger
): Promise<any[]> {
  const slotBlocks = slotMetadata.map(m => buildSlotPromptBlock(m, analysisData)).join('\n---\n');

  const roleType: string = analysisData.roleType || 'DIGITAL_MARKETING';
  const cultureKeywords: string[] = analysisData.jdDeconstruction?.cultureKeywords || [];
  const seniorityLevel: string = analysisData.jdDeconstruction?.seniorityLevel || '';
  const missingCritical = (analysisData.gapAnalysis?.missing || [])
    .filter((g: any) => g.type === 'CRITICAL_GAP')
    .map((g: any) => `${g.skill}: ${g.reframeInstruction}`)
    .join('\n');

  const toneInstruction =
    companyType === 'STARTUP'
      ? 'Terse, high-velocity. Ownership, speed, end-to-end accountability. Preferred verbs: Launched, Scaled, Built, Drove, Owned.'
      : companyType === 'ENTERPRISE'
      ? 'Structured, formal. Governance, process, large-scale coordination, cross-functional stakeholders. Preferred verbs: Led, Managed, Developed, Directed, Optimized.'
      : 'Balanced professional tone.';

  const prompt = `
You are a resume optimization engine. Strategic analysis (Pass 1) is complete — your ONLY job is to produce precisely formatted LaTeX content for each slot.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LATEX RULES — VIOLATIONS BREAK COMPILATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Allowed commands: \\textbf{}, \\begin{itemize}, \\end{itemize}, \\item, \\\\, \\&, \\%, \\$, \\skillbreak
NOTHING ELSE. No \\textit, \\emph, \\href, \\url, \\newline, \\medskip, \\vspace, \\hspace, \\noindent, \\par, \\smallskip, \\bigskip.
Write LaTeX with single backslashes. Do NOT double-escape backslashes.
Never place \\\\ at the start of content, directly after \\begin{itemize}, directly before \\end{itemize}, or at the very end of content.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GLOBAL RULES — APPLY TO ALL SLOTS WITHOUT EXCEPTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Role type: ${roleType}
Company type: ${companyType}
Tone: ${toneInstruction}
Seniority expectation: ${seniorityLevel || 'Mid-level — demonstrate initiative and ownership, not support.'}

LINE COUNT IS LAW. Each slot specifies the exact number of physical rendered lines in the compiled PDF. Exceeding the line count pushes the resume past 1 page. Going under wastes valuable space. Match exactly.

BULLET COUNT IS LOCKED. Never add or remove bullets from any bullet slot. Input count = output count, always.

VOICE: Implied first person. No pronouns. "Increased organic traffic 40%" not "I increased organic traffic 40%."

KEYWORD DISCIPLINE: Every injected keyword must appear in achievement context. A keyword with no surrounding result is forbidden. "Utilized Google Analytics" is a failure. "Cut CAC 22% by rebuilding GA4 attribution model" is correct.

EXACT FORM: Use the JD's exact spelling and capitalization for every keyword. If JD says "Google Analytics 4," write "Google Analytics 4" not "Google Analytics."

BOTH FORMS: Always include both abbreviation and full form for technical terms at least once per section they appear in. "Search Engine Optimization (SEO)" satisfies both Greenhouse exact-match filters simultaneously.

SENIORITY LANGUAGE: Replace every instance of "Assisted," "Supported," "Helped with," "Participated in," "Responsible for," "Worked on" with ownership verbs from this approved list:
Launched, Drove, Built, Cut, Scaled, Automated, Redesigned, Consolidated, Deployed, Reduced, Increased, Implemented, Integrated, Streamlined, Developed, Executed, Analyzed, Orchestrated, Led, Managed, Optimized, Accelerated, Pioneered, Generated, Grew, Forecasted, Segmented, Modeled.

BANNED WORDS (remove from all output): passionate, results-driven, team player, strong communication, detail-oriented, self-starter, proven, dynamic, innovative, synergy, leverage, utilize, responsible for, assisted with, worked on, helped with, participated in.

METRIC HIERARCHY (prioritize in this order):
  Tier 1: Revenue impact, ROI, ROAS, pipeline value, conversion rates.
  Tier 2: Traffic growth, CAC reduction, lead volume, engagement lifts.
  Tier 3: Campaign volume, budget managed, audience reach, team size.
Target 60–75% of all bullets containing a metric. For bullets without a metric, use scope signals: budget amount, team size, number of campaigns, geography, stakeholder level.

JD LANGUAGE MIRRORING — THE SINGLE MOST IMPACTFUL CHANGE:
  Rule 1: If the JD uses "demand generation," use "demand generation" — not "lead generation" or "pipeline generation."
  Rule 2: Mirror the JD's responsibility verbs ("spearhead" → "spearheaded" or "led").
  Rule 3: Use exact product names + versions from JD ("Salesforce Marketing Cloud," not "Salesforce").
  Rule 4: Mirror the JD's seniority framing — if JD says "own" and "drive," use ownership verbs throughout.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SLOT TYPE: PROFESSIONAL SUMMARY (PARAGRAPH)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Length: EXACTLY 3 sentences. 40–60 words total. Must be scannable in 2 seconds.

Sentence 1 — Credential opener: [Exact JD job title] + real years of experience calculated from resume dates (no rounding up) + core specialization using the JD's exact language.
  Example: "Marketing Analytics Manager with 4 years driving data-driven acquisition and retention strategies for B2B SaaS products."

Sentence 2 — Value proposition: 2 signature quantified achievements from the resume that most directly address the JD's highest-priority requirements. Both achievements must contain a specific number. This is the sentence a hiring manager reads — make it land.

Sentence 3 — Skills signal: 3–5 of the JD's highest-priority hard skills woven naturally (not as a list). End with the top 1–2 culture keywords identified in Pass 1${cultureKeywords.length > 0 ? ` ("${cultureKeywords.slice(0, 2).join('", "')}").` : '.'}

CRITICAL: Do NOT name the target company. Do NOT use first person. Do NOT use banned words. No bullet points. No \\begin{itemize}. Pure prose paragraph only.
CRITICAL: Do NOT use \\\\ (double backslash / forced line break) anywhere in the summary. All 3 sentences must flow as a continuous paragraph — source line breaks between sentences are fine, but absolutely no \\\\ between or after sentences.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SLOT TYPE: SKILLS & CERTIFICATIONS (PARAGRAPH)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Format — each sub-section on its own line:
\\textbf{Category One:} Skill1, Skill2, Skill3\\skillbreak
\\textbf{Category Two:} Skill4, Skill5, Skill6

Rules:
- EACH sub-section (category row) MUST start on a new line. Place \\skillbreak at the end of every row EXCEPT the last. Never place \\skillbreak after the final row. Do NOT add a blank line or any trailing whitespace after the last row.
- You MAY reorder sub-sections, rename them, merge or split them, and move individual skills from one sub-section to another. Do whatever produces the best JD alignment.
- Order sub-sections so the MOST JD-relevant appears FIRST.
- Within each sub-section, order skills: JD-required first, JD-preferred second, remaining original skills last.
- Bold each individual skill that appears in the JD using \\textbf{}: e.g. \\textbf{SQL}, \\textbf{HubSpot}. Bold only the skill name itself — not the comma, colon, or surrounding text. The category header \\textbf{Category:} is always bold regardless.
- Use the JD's exact spelling and capitalisation for every skill. Include both full form and abbreviation when the JD uses both: "Google Analytics 4 (GA4)."
- Name categories using the JD's own terminology where possible.

SKILL PRESERVATION RULE (CRITICAL):
- Keep EVERY skill from the original resume by default.
- LINE COUNT MUST EQUAL original exactly (enforced by the line constraint above).
- Only remove skills if keeping them would exceed the line count. Remove in this order ONLY:
    1. Jira  2. Trello  3. Slack  4. Microsoft Office  5. Adobe Suite  6. Salesforce  7. Canva
    Then: other non-JD skills, least relevant first. Never remove a primary JD keyword. Never remove certifications.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SLOT TYPE: EXPERIENCE / PROJECTS (BULLETS)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before rewriting each bullet, read its line count from the slot's line constraint block. Design sentence length to fit exactly.

Structure for every bullet:
  Pattern A (metric exists): \\item \\textbf{+34\\% ROAS improvement} Reallocated \\$50K annual budget across channels using \\textbf{multi-touch attribution} modeling to eliminate underperforming paid placements.
  Pattern B (no metric): \\item \\textbf{15+ end-to-end campaigns} Launched digital acquisition program across paid, email, and organic channels, increasing qualified B2B pipeline by 30\\% within 12 months.

BANNED PUNCTUATION: Do NOT use em dashes (—) or en dashes (–) anywhere in the output. Replace any dash-separated constructions with a comma, a colon, or a rewritten sentence.

Bolding rules: Bold the front metric or scale. Bold any injected JD keyword that is not already bold. Do not bold entire phrases, only the keyword or metric itself.

Keyword injection: Every bullet must contain at least 1 exact-match JD keyword bolded. Never insert a keyword without surrounding it with context that demonstrates competence.

Irrelevance handling: For bullets rated 1–2 by irrelevancyScore, reframe to highlight transferable elements (leadership, budget management, data analysis, cross-functional coordination). Do not fabricate — reframe genuinely adjacent skills only.

What CANNOT change: dates, company names, job titles, bullet count, bullet order.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PASS 1 ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Gap analysis summary:
${JSON.stringify(analysisData.gapAnalysis, null, 2)}

Critical gaps requiring reframe (do NOT fabricate — use adjacent experience):
${missingCritical || 'None identified.'}

Change plan per slot:
${JSON.stringify(analysisData.changePlan, null, 2)}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SLOTS TO REWRITE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${slotBlocks}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ORIGINAL RESUME (context only — do not copy unchanged)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${resumeContent}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
JOB DESCRIPTION (keyword source — mirror this language)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${jobDescription}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RETURN FORMAT — raw JSON only, no markdown fences, no preamble
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "suggestions": [
    {
      "slotName": "exact slot name",
      "originalContent": "original content unchanged",
      "suggestedContent": "your optimized LaTeX content",
      "reasoning": "1-2 sentences: what changed and why"
    }
  ],
  "postOptimizationScore": {
    "estimated": 0,
    "keywordsInjected": ["exact keyword strings successfully placed"],
    "criticalGapsRemaining": ["skills that could not be honestly addressed — need manual attention"],
    "difficultLineBullets": [{ "slotName": "string", "bulletIndex": 0 }]
  }
}
`;

  console.log('[Analyze] Pass 2 Generation');
  const generationResponse = await generateJSON(prompt, 'gemini-2.0-flash');
  const fixedJson = fixJsonBackslashes(generationResponse);
  const generationData = JSON.parse(fixedJson);

  const suggestions = generationData.suggestions.map((suggestion: any) => {
    let content = suggestion.suggestedContent.replace(/\\n/g, '\n');
    content = fixLatexOutput(content);
    const meta = slotMetadata.find((m: any) => m.name === suggestion.slotName);
    if (meta?.baseline?.type === 'section') {
      // Strip any \\ forced line breaks the AI may have inserted (prose sections only)
      content = content.replace(/\\\\/g, '');
      // Trim trailing whitespace/newlines so no blank line appears between content and % END_SLOT
      // (a trailing blank line in the LaTeX source creates extra paragraph space in the PDF)
      content = content.trimEnd();
    }
    return { ...suggestion, suggestedContent: content };
  });

  if (suggestions.length > 0 && generationData.postOptimizationScore) {
    suggestions[0].__postOptimizationScore = generationData.postOptimizationScore;
  }

  logger.log('PASS2_COMPLETE', {
    slotsGenerated: suggestions.length,
    slotNames: suggestions.map((s: any) => s.slotName),
    postScore: generationData.postOptimizationScore?.estimated,
    criticalGapsRemaining: generationData.postOptimizationScore?.criticalGapsRemaining ?? [],
  });

  return suggestions;
}
