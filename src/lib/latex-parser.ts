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
    const startMatch = line.match(/%\s*SLOT:\s*(.+)/i);
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
  let newLines = [...lines];

  // We need to apply changes from bottom to top to avoid line shift issues,
  // or just track the lines designated by the parser.
  // Since we rely on the parser's line numbers which are based on the original,
  // we should map modifications to slots.

  // Create a map of changes
  const modificationMap = new Map(modifications.map(m => [m.slotName, m.newContent]));

  // Process slots in reverse order to keep line numbers valid
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i];
    if (modificationMap.has(slot.name)) {
      const newContent = modificationMap.get(slot.name)!;
      // Replace lines between startLine and endLine with new content
      // The content is at startLine + 1 to endLine - 1
      const contentStart = slot.startLine + 1;
      const contentEnd = slot.endLine; // exclusive of endLine? lines[endLine] is % END_SLOT
      
      // We want to preserve the markers
      // So we replace lines from contentStart to contentEnd - 1
      // If contentStart == contentEnd, it's empty, insert there.

      // Actually, array splice is easier.
      // But we need to handle multi-line new content.
      
      // Let's constructing the new file content.
      // Actually, easier way:
    }
  }
  
  // Re-approach:
  // Iterate lines, if line is start of slot, check if we have a mod.
  // If so, output start marker, output new content, skip to end marker, output end marker.
  // Else output line.
  
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
        // Note: loop continues, next iteration i+1 check against skipUntil?
        // Wait, if skipUntil is 10, next loop i=...
        // We need to skip lines from i+1 to slot.endLine - 1.
        // And then at slot.endLine we push that line.
      } else {
        resultLines.push(lines[i]);
      }
    } else {
      resultLines.push(lines[i]);
    }
  }

  return resultLines.join('\n');
}
