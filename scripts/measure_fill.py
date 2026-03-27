#!/usr/bin/env python3
"""
measure_fill.py — Measure last-line fill percentage for resume slots using pdfplumber.

Input  (stdin): JSON config object (single-shot mode) or one JSON line per request (server mode)
Output (stdout): JSON FillMeasurement object
Exit 1 on unrecoverable error; partial results still written on soft errors.
"""

import sys
import json
import pdfplumber

# ─── Named constants ────────────────────────────────────────────────────────────

# pdfplumber word grouping tolerance in points.
# 3pt handles sub-pixel rendering differences between adjacent words on the same baseline
# without merging words from adjacent lines (minimum line spacing ~12pt at 10pt font size).
Y_TOLERANCE = 3
X_TOLERANCE = 2

# Points offset above left margin to identify centred section headers.
# Resume template uses \sectiontitle which centres text; content starts at left margin.
# 50pt chosen to reliably separate centred titles from left-aligned body text.
SECTION_HEADER_THRESHOLD_OFFSET = 50

BULLET_CHARS = {'•', '∙', '·', '–', '‣'}


# ─── Word grouping ────────────────────────────────────────────────────────────

def group_words_into_lines(words, y_tolerance=Y_TOLERANCE):
    """Sort words into rendered lines by y-coordinate."""
    if not words:
        return []
    lines = []
    current = [words[0]]
    for word in words[1:]:
        if abs(word['top'] - current[0]['top']) <= y_tolerance:
            current.append(word)
        else:
            current.sort(key=lambda w: w['x0'])
            lines.append(current)
            current = [word]
    if current:
        current.sort(key=lambda w: w['x0'])
        lines.append(current)
    lines.sort(key=lambda l: l[0]['top'])
    return lines


# ─── Margin detection ─────────────────────────────────────────────────────────

def detect_margins(words):
    """Detect left margin and right edge from all words on the page."""
    if not words:
        return 14.4, 597.6, 583.2   # letter page, 0.2in margins (fallback)
    left  = round(min(w['x0'] for w in words), 1)
    right = round(max(w['x1'] for w in words), 1)
    return left, right, round(right - left, 1)


# ─── Fill computation ─────────────────────────────────────────────────────────

def compute_fill(last_line_words, left_margin, usable_width):
    if not last_line_words or usable_width <= 0:
        return 0.0
    x1 = max(w['x1'] for w in last_line_words)
    return round(min((x1 - left_margin) / usable_width * 100, 100.0), 1)


def avg_word_width(line_words, left_margin):
    """Estimate average word width; default 45pt for Helvetica 10pt."""
    if len(line_words) < 3:
        return 45.0
    total = max(w['x1'] for w in line_words) - min(w['x0'] for w in line_words)
    return total / len(line_words)


# ─── Section-header detection ─────────────────────────────────────────────────

def is_section_header_line(line_words, left_margin):
    """True if this line is a centred section title (not left-aligned content)."""
    if not line_words:
        return False
    return min(w['x0'] for w in line_words) > left_margin + SECTION_HEADER_THRESHOLD_OFFSET


def starts_with_bullet(line_words):
    if not line_words:
        return False
    first = line_words[0]['text'].strip()
    return first in BULLET_CHARS or (len(first) > 0 and first[0] in BULLET_CHARS)


# ─── Slot-specific measurement routines ───────────────────────────────────────

def measure_summary(lines, left_margin, right_edge, usable_width):
    """
    Measure fill for the Professional Summary section.
    Returns a list with one FillResult dict.
    """
    header_idx = None
    for i, line in enumerate(lines):
        text = ' '.join(w['text'] for w in line)
        if 'Professional Summary' in text:
            header_idx = i
            break
    if header_idx is None:
        return []

    content = []
    for i in range(header_idx + 1, len(lines)):
        if is_section_header_line(lines[i], left_margin):
            break
        line_text = ' '.join(w['text'] for w in lines[i]).strip()
        if line_text:
            content.append(lines[i])

    if not content:
        return []

    last = content[-1]
    fill = compute_fill(last, left_margin, usable_width)
    last_x1 = round(max(w['x1'] for w in last), 1)
    total = len(content)
    return [{
        'identifier': 'summary',
        'totalLines': total,
        'lastLineText': ' '.join(w['text'] for w in last),
        'lastLineX1': last_x1,
        'lastLineFill': fill,
        'avgWordWidth': round(avg_word_width(last, left_margin), 1),
        'threshold': 80,
        'passes': fill >= 80,
        'exempt': False,
    }]


def measure_skills(lines, category_names, left_margin, right_edge, usable_width):
    """
    Measure fill for each category row in the Skills section.
    Returns one FillResult per category row found.
    """
    results = []
    n = len(category_names)
    for idx, cat in enumerate(category_names):
        # Find the line containing this category header text
        header_idx = None
        cat_lower = cat.lower()
        for i, line in enumerate(lines):
            text = ' '.join(w['text'] for w in line).lower()
            if cat_lower in text:
                header_idx = i
                break
        if header_idx is None:
            continue

        # Collect row lines until next category or section header
        next_cats = [category_names[j].lower() for j in range(idx + 1, n)]
        row_lines = [lines[header_idx]]
        for i in range(header_idx + 1, len(lines)):
            line_text = ' '.join(w['text'] for w in lines[i]).strip()
            if not line_text:
                continue
            if is_section_header_line(lines[i], left_margin):
                break
            if any(nc in line_text.lower() for nc in next_cats):
                break
            row_lines.append(lines[i])

        last = row_lines[-1]
        fill = compute_fill(last, left_margin, usable_width)
        last_x1 = round(max(w['x1'] for w in last), 1)
        total = len(row_lines)
        results.append({
            'identifier': f'skills_row_{idx + 1}',
            'totalLines': total,
            'lastLineText': ' '.join(w['text'] for w in last),
            'lastLineX1': last_x1,
            'lastLineFill': fill,
            'avgWordWidth': round(avg_word_width(last, left_margin), 1),
            'threshold': 80,
            'passes': fill >= 80,
            'exempt': False,
        })
    return results


def measure_bullets(lines, anchor_text, all_anchors, left_margin, right_edge, usable_width):
    """
    Measure fill for each bullet in a job/project slot.
    Returns one FillResult per bullet cluster.
    """
    anchor_idx = None
    for i, line in enumerate(lines):
        text = ' '.join(w['text'] for w in line)
        if anchor_text in text:
            anchor_idx = i
            break
    if anchor_idx is None:
        return []

    other_anchors = [a for a in all_anchors if a != anchor_text]
    collected = []
    for i in range(anchor_idx + 1, len(lines)):
        line = lines[i]
        line_text = ' '.join(w['text'] for w in line).strip()
        if not line_text:
            continue
        if is_section_header_line(line, left_margin):
            break
        if any(oa in line_text and not starts_with_bullet(line) for oa in other_anchors):
            break
        collected.append(line)

    # Group into bullet clusters: new cluster starts when line begins with bullet char
    bullets = []
    current = []
    for line in collected:
        if starts_with_bullet(line):
            if current:
                bullets.append(current)
            current = [line]
        else:
            if current:
                current.append(line)
            # lines before the first bullet (e.g. title lines) are skipped

    if current:
        bullets.append(current)

    results = []
    for bi, cluster in enumerate(bullets):
        last = cluster[-1]
        fill = compute_fill(last, left_margin, usable_width)
        last_x1 = round(max(w['x1'] for w in last), 1)
        total = len(cluster)
        results.append({
            'identifier': f'bullet_{bi + 1}',
            'totalLines': total,
            'lastLineText': ' '.join(w['text'] for w in last),
            'lastLineX1': last_x1,
            'lastLineFill': fill,
            'avgWordWidth': round(avg_word_width(last, left_margin), 1),
            'threshold': 80 if total == 1 else 60,
            'passes': fill >= (80 if total == 1 else 60),
            'exempt': False,
        })
    return results


# ─── Core processing ──────────────────────────────────────────────────────────

def process_config(config):
    """
    Extract measurement logic from main() into this reusable function.
    Returns the dict that is written to stdout as JSON.
    """
    pdf_path     = config.get('pdf_path', '')
    slot_name    = config.get('slot_name', '')
    slot_type    = config.get('slot_type', 'section')
    section_type = config.get('section_type', slot_type)

    with pdfplumber.open(pdf_path) as pdf:
        if not pdf.pages:
            raise ValueError('PDF has no pages')
        page = pdf.pages[0]
        words = page.extract_words(x_tolerance=X_TOLERANCE, y_tolerance=Y_TOLERANCE)
        page_width = float(page.width)

        if not words:
            # Return empty measurement rather than crashing
            return {
                'slotName': slot_name, 'slotType': slot_type,
                'pageWidth': page_width, 'leftMargin': 14.4,
                'rightMargin': 14.4, 'usableWidth': page_width - 28.8,
                'results': [],
            }

        lines = group_words_into_lines(words, y_tolerance=Y_TOLERANCE)
        left_margin, right_edge, usable_width = detect_margins(words)

        if section_type == 'summary':
            results = measure_summary(lines, left_margin, right_edge, usable_width)

        elif section_type == 'skills':
            cat_names = config.get('category_names', [])
            results = measure_skills(lines, cat_names, left_margin, right_edge, usable_width)

        elif section_type == 'bullets':
            anchor      = config.get('anchor', '')
            all_anchors = config.get('all_anchors', [anchor])
            results = measure_bullets(lines, anchor, all_anchors, left_margin, right_edge, usable_width)

        else:
            results = []

        return {
            'slotName':    slot_name,
            'slotType':    slot_type,
            'pageWidth':   round(page_width, 1),
            'leftMargin':  left_margin,
            'rightMargin': round(page_width - right_edge, 1),
            'usableWidth': usable_width,
            'results':     results,
        }


# ─── Server mode ──────────────────────────────────────────────────────────────

def run_server():
    """Read JSON configs line by line from stdin, write JSON results line by line to stdout."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        config = None
        try:
            config = json.loads(line)
            result = process_config(config)
            print(json.dumps(result), flush=True)
        except Exception as e:
            import traceback
            error_result = {
                'error': str(e),
                'traceback': traceback.format_exc(),
                'slot_name': config.get('slot_name', 'unknown') if config is not None else 'parse_error',
            }
            print(json.dumps(error_result), flush=True)


# ─── Single-shot mode ─────────────────────────────────────────────────────────

def main():
    try:
        config = json.loads(sys.stdin.read())
    except json.JSONDecodeError as e:
        sys.stderr.write(f'Invalid JSON config: {e}\n')
        sys.exit(1)

    try:
        result = process_config(config)
        print(json.dumps(result))
    except Exception as e:
        sys.stderr.write(f'measure_fill error: {e}\n')
        sys.exit(1)


if __name__ == '__main__':
    if '--server' in sys.argv:
        run_server()
    else:
        main()
