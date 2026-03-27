/**
 * Fixes single-backslash LaTeX commands in JSON string values BEFORE parsing.
 * AI often emits \textbf, \item, \begin etc as single-backslash in JSON.
 *
 * Root cause: JSON.parse treats \t→tab, \n→newline, \b→backspace, etc., so
 * \textbf becomes [TAB]extbf (visible as "extbf"). Removing those letters from
 * VALID_ESCAPES causes them to be doubled: \textbf → \\textbf → JSON.parse → \textbf.
 *
 * Also handles literal control characters (actual newlines, tabs) inside JSON
 * string values — these cause "Bad control character" parse errors.
 */
export function fixJsonBackslashes(input: string): string {
  // Only structural JSON escapes: quote, slash, backslash, unicode.
  // Deliberately excludes n/r/t/b/f so that \textbf, \begin, \noindent etc.
  // are doubled rather than converted to tab/newline/backspace.
  // \n in the raw AI response becomes \\n after doubling; the pipeline's
  // .replace(/\\n/g, '\n') call then converts it to an actual newline.
  const VALID_ESCAPES = new Set(['"', '/', '\\', 'u']);
  let result = '';
  let inString = false;
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (!inString) {
      result += ch;
      if (ch === '"') inString = true;
      i++;
      continue;
    }

    // Inside a JSON string
    if (ch === '\\') {
      const next = input[i + 1];
      if (next !== undefined && VALID_ESCAPES.has(next)) {
        // Valid JSON escape — leave untouched
        result += ch + next;
        i += 2;
      } else {
        // Bare backslash (LaTeX command start) — double it
        result += '\\\\';
        i++;
      }
    } else if (ch === '"') {
      result += ch;
      inString = false;
      i++;
    } else if (ch.charCodeAt(0) < 0x20) {
      // Literal control character inside string — escape it so JSON.parse doesn't reject it
      if (ch === '\n') result += '\\n';
      else if (ch === '\r') result += '\\r';
      else if (ch === '\t') result += '\\t';
      else result += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
      i++;
    } else {
      result += ch;
      i++;
    }
  }

  return result;
}
