export interface PersonalInfo {
  name: string;
  email: string;
  phone: string;
  linkedin: string;
  website: string;
  address: string;
}

/**
 * Extracts personal info from the LaTeX header block.
 */
export function parsePersonalInfo(content: string): PersonalInfo {
  // Only search AFTER \begin{document} to skip preamble \newcommand definitions
  const docPart = content.split('\\begin{document}')[1] || content;

  // First \begin{center}...\end{center} after \begin{document} is the resume header
  const headerCenter = docPart.match(/\\begin\{center\}([\s\S]*?)\\end\{center\}/)?.[1] || '';

  // Name: first \textbf{...} in the header that has no # (not a LaTeX argument placeholder)
  const name = headerCenter.match(/\\textbf\{([^}#]+)\}/)?.[1]?.trim() || '';

  // Email: \href{mailto:email}{...}
  const email = headerCenter.match(/\\href\{mailto:([^}]+)\}/)?.[1]?.trim() || '';

  // LinkedIn URL: \href{url}{LinkedIn}
  const linkedin = headerCenter.match(/\\href\{([^}]+)\}\{LinkedIn\}/i)?.[1]?.trim() || '';

  // Website URL: \href{url}{Website}
  const website = headerCenter.match(/\\href\{([^}]+)\}\{Website\}/i)?.[1]?.trim() || '';

  // Phone: first standalone phone-number-shaped token (digits + separators, 7+ chars)
  const phone = headerCenter.match(/(?<![.\d])(\d[\d\s\-().]{5,}\d)(?![.\d])/)?.[1]?.trim() || '';

  // Address: text on the line(s) between the name \\ and the first digit/\href
  // Strip the name line first, then grab everything up to phone or \href
  const afterName = headerCenter.replace(/\{[^}]*\\textbf[^}]*\}[^\\]*\\\\[^\n]*\n?/, '');
  const addrRaw = afterName.split(/\d{3}[\s\-]\d{3}|\\href\{/)[0];
  const address = addrRaw
    .replace(/\\;?\s*\|\s*\\;?/g, '')   // remove \;|\; separators
    .replace(/\\[a-zA-Z]+\s*/g, '')      // remove remaining LaTeX commands
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { name, email, phone, linkedin, website, address };
}

export interface Slot {
  name: string;
  originalContent: string;
  startLine: number; // 0-indexed line number of the START marker
  endLine: number;   // 0-indexed line number of the END marker
}

/**
 * Parses LaTeX content for slots defined by:
 * % SLOT: <SlotName>
 * ... content ...
 * % END_SLOT
 */
export function parseSlots(content: string): Slot[] {
  const lines = content.split('\n');
  const slots: Slot[] = [];
  let currentSlot: Partial<Slot> | null = null;
  let contentBuffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const startMatch = line.match(/(?:%+|\\%)\s*SLOT:\s*(.*?)\s*%*$/i);
    const endMatch = line.match(/%\s*END_SLOT/i);

    if (startMatch) {
      if (currentSlot) {
        // Close previous slot implicitly? Or warn?
        // Let's assume strict closing for safety, but maybe close if new one starts.
        // For now, let's just ignore nested slots and assume first match wins or similar.
        // Actually, let's just start a new one and warn about the unclosed one.
        console.warn(`Unclosed slot "${currentSlot.name}" at line ${currentSlot.startLine}`);
      }
      currentSlot = {
        name: startMatch[1].trim(),
        startLine: i,
      };
      contentBuffer = [];
    } else if (endMatch) {
      if (currentSlot) {
        currentSlot.endLine = i;
        currentSlot.originalContent = contentBuffer.join('\n');
        slots.push(currentSlot as Slot);
        currentSlot = null;
        contentBuffer = [];
      }
    } else {
      if (currentSlot) {
        contentBuffer.push(line);
      }
    }
  }

  return slots;
}

/**
 * Replaces slot content in the original string.
 * This is naive and assumes slots are non-overlapping and sorted by line number if processing sequentially.
 * Better to reconstruct the string or use the line numbers carefully.
 */
export function applyChanges(original: string, modifications: { slotName: string; newContent: string }[]): string {
  const slots = parseSlots(original);
  const lines = original.split('\n');
  const modificationMap = new Map(modifications.map(m => [m.slotName, m.newContent]));
  const appliedSlots = new Set<string>();

  const resultLines: string[] = [];

  let skipUntil: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    if (skipUntil !== null) {
      if (i === skipUntil) {
        skipUntil = null;
        resultLines.push(lines[i]); // Push the % END_SLOT line
      }
      continue;
    }

    const startMatch = lines[i].match(/%\s*SLOT:\s*(.+)/i);
    if (startMatch) {
      const slotName = startMatch[1].trim();
      const slot = slots.find(s => s.name === slotName && s.startLine === i);

      if (slot && modificationMap.has(slotName)) {
        resultLines.push(lines[i]); // Keep start marker
        resultLines.push(modificationMap.get(slotName)!); // Insert new content
        skipUntil = slot.endLine; // Skip original content until end marker
        appliedSlots.add(slotName);
      } else {
        resultLines.push(lines[i]);
      }
    } else {
      resultLines.push(lines[i]);
    }
  }

  // Throw if a slot modification was never applied — indicates a slot name mismatch
  for (const mod of modifications) {
    if (!appliedSlots.has(mod.slotName)) {
      throw new Error(
        `SLOT_NOT_FOUND: Slot "${mod.slotName}" not found in LaTeX source. Verify the % SLOT: ${mod.slotName} marker exists and is correctly formatted.`
      );
    }
  }

  return resultLines.join('\n');
}

/**
 * Post-processes AI-generated LaTeX content to ensure common special characters are escaped.
 * AIs often miss these or only partially escape them.
 * This is a "safety net" for the AI output.
 */
export function fixLatexOutput(text: string): string {
  if (!text) return "";
  
  let s = text;
  
  // Normalize then escape & and %
  // We use a placeholder for double backslashes to avoid the "line break" problem
  s = s.replace(/\\\\/g, '__DOUBLE_BACKSLASH__');
  
  s = s.replace(/\\&/g, '&');
  s = s.replace(/&/g, '\\&');
  
  s = s.replace(/\\%/g, '%');
  s = s.replace(/%/g, '\\%');
  
  s = s.replace(/__DOUBLE_BACKSLASH__/g, '\\\\');

  // Other chars
  s = s.replace(/(?<!\\)\$/g, '\\$');
  s = s.replace(/(?<!\\)_/g, '\\_');
  s = s.replace(/(?<!\\)#/g, '\\#');
  s = s.replace(/(?<!\\)\{/g, '\\{');
  s = s.replace(/(?<!\\)\}/g, '\\}');
  s = s.replace(/(?<!\\)~/g, '\\textasciitilde ');
  // Handle ^ which was missing its implementation
  s = s.replace(/(?<!\\)\^/g, '\\textasciicircum ');

  // Stray \ removal: remove single backslashes that aren't starting a command or escaping a char
  s = s.replace(/(?<!\\)\\(?![&%$_#{}~^\\a-zA-Z])/g, '');

  // Blank line collapsing
  s = s.replace(/\n\s*\n\s*\n+/g, '\n\n');

  return s.trim();
}

/**
 * Strips common LaTeX commands to return a plain-text version of the content.
 * Useful for providing context to LLM prompts without token waste or formatting noise.
 */
export function stripLatex(text: string): string {
    if (!text) return "";
    
    return text
        // 1. Handle commands with arguments
        // Handle \href{url}{text} -> text
        .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, '$1')
        // Handle \section{Title}, \textbf{Bold} etc -> Title, Bold
        .replace(/\\(?:section|subsection|subsubsection|paragraph|subparagraph|textbf|textit|underline|emph|textsc|texttt|item)\*?\{([^}]*)\}/g, '$1')
        
        // 2. Remove structural commands
        .replace(/\\(?:begin|end|documentclass|usepackage|geometry|hypersetup|pagestyle|setlength|definecolor)\{[^}]*\}/g, '')
        
        // 3. Remove single backslash commands like \\, \vfill, \noindent etc
        .replace(/\\[a-zA-Z]+\s*/g, ' ')
        .replace(/\\\\/g, '\n')
        
        // 4. Clean up remaining braces and excessive whitespace
        .replace(/\{|\}/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*(\n\s*)+/g, '\n\n') // Keep double newlines but remove triple+
        .trim();
}

/**
 * Specifically for budgeting and validation: strips commands BUT keeps inner text.
 * \textbf{X} -> X, remove all other \commands, remove {}, trim.
 */
export function stripLatexToVisible(text: string): string {
  if (!text) return "";
  let s = text;
  
  // 1. Handle common escaped special characters: \&, \%, \$, \_, \#, \{, \}
  s = s.replace(/\\&/g, '&');
  s = s.replace(/\\%/g, '%');
  s = s.replace(/\\\$/g, '$');
  s = s.replace(/\\_/g, '_');
  s = s.replace(/\\#/g, '#');
  s = s.replace(/\\\{/g, '{');
  s = s.replace(/\\\}/g, '}');

  // 2. Handle specific commands that preserve text (innermost first or non-greedy)
  // Handle \href{url}{text} -> text
  s = s.replace(/\\href\{[^}]*\}\{([^}]*)\}/g, '$1');
  // Handle \textbf{X}, \textit{X}, \emph{X}, \underline{X}, \section{X}, \subsection{X} -> X
  s = s.replace(/\\(?:textbf|textit|emph|underline|section|subsection|subsubsection)\{([^}]*)\}/g, '$1');
  
  // 3. Remove structural environments, skillbreak, and \item
  s = s.replace(/\\begin\{[^}]*\}|\\end\{[^}]*\}|\\skillbreak|\\item/g, '');
  
  // 4. Remove all other backslash commands (word characters only, to avoid catching escaped chars already handled)
  s = s.replace(/\\[a-zA-Z]+/g, ' ');
  
  // 5. Remove remaining braces
  s = s.replace(/[{}]/g, '');
  
  // 6. Handle double backslash (line break)
  s = s.replace(/\\\\/g, ' ');
  
  // 7. Cleanup: strip trailing/leading whitespace, collapse multiple spaces
  return s.replace(/\s+/g, ' ').trim();
}

