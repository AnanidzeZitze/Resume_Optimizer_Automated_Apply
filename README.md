# Resume Optimizer

A full-stack AI application that optimizes LaTeX resumes for specific job descriptions using a two-pass Gemini AI pipeline, with automatic PDF compilation and cover letter generation.

---

## What It Does

1. **Parses** a LaTeX resume into named content slots (`% SLOT: <name>` / `% END_SLOT`)
2. **Analyzes** the resume against a job description in Pass 1 (strategic analysis): role classification, gap analysis, keyword extraction, and pre-optimization ATS scoring
3. **Rewrites** every slot in Pass 2 (content generation): injects exact-match JD keywords, mirrors seniority language, enforces line-count and last-line fill constraints
4. **Validates** the output by compiling to PDF and measuring rendered line counts with `pdftotext`; mismatches trigger up to 3 AI retry rounds per failing slot
5. **Enforces fill thresholds** on every slot's last rendered line (≥80% for sections and single-line bullets; ≥60% for multi-line bullets) using `pdfplumber`
6. **Generates** a Harvard-style cover letter with Google Search grounding and strict paragraph structure validation
7. **Compiles** both documents to downloadable PDFs

---

## Prerequisites

The following system tools must be installed and on `PATH`:

| Tool | Purpose | Install |
|------|---------|---------|
| `pdflatex` | Compile LaTeX → PDF | `brew install mactex` (macOS) · `apt install texlive-full` (Linux) |
| `pdftotext` | Extract text layout from PDF | `brew install poppler` · `apt install poppler-utils` |
| `python3` | Run fill measurement script | Built-in on macOS · `apt install python3` (Linux) |
| `pdfplumber` | Python PDF word extraction | `pip install pdfplumber` |

Node.js 18+ and npm are also required.

---

## Setup

```bash
# 1. Clone the repository
git clone <repo-url>
cd resume-optimizer

# 2. Install Node dependencies
npm install

# 3. Create your environment file
cp .env.example .env.local
# Edit .env.local and set your Gemini API key
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Google Gemini API key — get one at [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| `FILL_MEASUREMENT_TIMEOUT_MS` | No | Python fill server timeout in ms (default: `60000`) |

---

## Running the App

```bash
# Development
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

```bash
# Production
npm run build && npm start
```

---

## Usage

1. **Upload your resume** — `.tex` LaTeX file (a default template is pre-loaded at `public/resume.tex`)
2. **Upload your LinkedIn profile** — exported as PDF (optional; improves keyword analysis)
3. **Paste the job description** — full JD text from the posting
4. Click **Optimize Resume**

The app runs the two-pass AI analysis, displays a side-by-side editor with suggestions per slot, auto-applies all suggestions, generates a cover letter, and compiles both to PDFs for download. You can review each slot's original vs. optimized content and revert individual slots before downloading.

---

## Resume Format Requirements

Your LaTeX resume must use slot markers so the optimizer knows which sections to rewrite:

```latex
% SLOT: Professional Summary
Your summary text here.
% END_SLOT

% SLOT: Job Experience 1
\begin{itemize}
  \item Your bullet point here.
\end{itemize}
% END_SLOT
```

Experience and project entries should use the `\job` macro:

```latex
\job{Company Name}{Job Title}{Start – End}{Location}
% SLOT: Job Experience 1
\begin{itemize}
  \item Bullet point.
\end{itemize}
% END_SLOT
```

The default `public/resume.tex` template shows the full expected structure. The AI only rewrites content between slot markers — headers, contact info, and formatting remain untouched.

---

## Project Structure

```
resume-optimizer/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── analyze/route.ts       # Main optimization endpoint
│   │   │   ├── compile/route.ts       # LaTeX → PDF compilation
│   │   │   ├── cover-letter/route.ts  # Cover letter generation + compile
│   │   │   └── parse-pdf/route.ts     # PDF text extraction
│   │   ├── page.tsx                   # Main UI
│   │   ├── layout.tsx
│   │   └── globals.css
│   │
│   ├── components/
│   │   ├── AmbientBackground.tsx      # Animated background
│   │   ├── FileUpload.tsx             # Drag-and-drop file input
│   │   ├── ResumeEditor.tsx           # Slot editor (original vs. suggestion)
│   │   ├── RecruiterReport.tsx        # ATS score modal
│   │   └── ui/                        # Base UI primitives
│   │
│   └── lib/
│       ├── logger.ts                  # Request-scoped structured logger
│       ├── pipeline.ts                # Core validation + retry loop
│       ├── baseline.ts                # Baseline caching and stale detection
│       ├── pdfline-counter.ts         # pdftotext parsing and line counting
│       ├── fill-measurement.ts        # Last-line fill % via Python server
│       ├── latex-parser.ts            # Slot parsing, modification, personal info
│       ├── latex-utils.ts             # pdflatex invocation
│       ├── latex-templates.ts         # Cover letter LaTeX templates
│       ├── layout-probe.ts            # Character width calibration
│       ├── ai-client.ts               # Gemini API wrapper
│       ├── json-utils.ts              # Fix unescaped LaTeX backslashes in AI JSON
│       └── utils.ts
│
├── scripts/
│   └── measure_fill.py                # Measure last-line fill % with pdfplumber
│
├── public/
│   ├── resume.tex                     # Default LaTeX resume template
│   └── linkedin.pdf                   # Default LinkedIn placeholder
│
└── src/lib/__tests__/
    └── json-utils.test.ts
```

---

## How the Pipeline Works

### Baseline (first run only)

On the first run with a given resume, the app compiles the original LaTeX and runs `pdftotext -layout` to measure:
- **Line count per section** (for slots like Professional Summary and Skills)
- **Line count per bullet** (for experience and project slots)
- **Last-line fill percentage** for every element, measured by `pdfplumber`

This baseline is cached to `.baseline_<hash>.json`. Delete this file to force fresh measurement after editing your resume.

### Pass 1 — Strategic Analysis

A single Gemini API call that:
- Classifies the role type (Marketing Analytics / Digital Marketing / Growth Marketing / Marketing Operations)
- Deconstructs the JD into required skills, preferred skills, high-priority signals, and responsibility verbs
- Performs gap analysis (present-and-strong / present-but-weak / missing) with reframe instructions for critical gaps
- Scores the current resume against ATS criteria (0–100)
- Produces a per-slot change plan with target keywords and bullet relevancy scores (1–5)

### Pass 2 — Content Generation

A second Gemini API call that rewrites every slot using the Pass 1 strategy. Each slot prompt includes:
- The rewrite strategy and exact keywords to inject (in JD spelling)
- Bullet relevancy scores — bullets rated 1–2 are reframed to transferable skills
- **Line constraints** — exact number of PDF-rendered lines each element must occupy
- **Fill constraints** — minimum last-line fill percentage with original fill shown as calibration

### Validation + Retry Loop

After Pass 2, for each slot the app:
1. Compiles the modified LaTeX to PDF (isolated per-slot wrapper for speed)
2. Runs `pdftotext -layout` and counts rendered lines
3. Compares against baseline: `PASS`, `MISMATCH`, or `UNMEASURABLE`
4. On `PASS`, runs `pdfplumber` fill measurement and checks thresholds
5. Failing slots enter a retry round with a single batched Gemini call:
   - The failure prompt includes word counts, direction (too long / too short), and fill gap
   - If a slot produces identical wrong output twice in a row, an escalation note forces a structural rewrite from scratch
6. Up to 3 retry rounds. At max retries:
   - If the slot had passed line-count in an earlier round (but failed fill), the best line-count-passing version is kept
   - Otherwise the slot reverts to original content

### Final Validation

After the retry loop, the full resume compiles once more to verify it stays on a single page. If it overflows, all optimized slots revert to original.

---

## Fill Thresholds

The last rendered line of every element must meet a minimum fill percentage (how far the line extends across the usable page width):

| Element | Threshold | Notes |
|---------|-----------|-------|
| Professional Summary | ≥ 80% | Prose paragraph should read as full |
| Skills category row | ≥ 80% | Each row should appear dense |
| Multi-line bullet (≥ 2 lines) | ≥ 60% | Last line can be shorter without looking sparse |
| Single-line bullet | ≥ 80% | A single short line appears visually weak |

These are enforced in the retry loop. The original fill is passed to the AI as calibration data, not as a pass/fail signal — all bullets are rewritten regardless.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 15 (App Router) |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS v4, Framer Motion |
| AI | Google Gemini 2.0 Flash |
| PDF compilation | `pdflatex` (system binary) |
| PDF preview | `pdfjs-dist` (browser) |
| PDF parsing | `pdftotext -layout` (text), `pdfplumber` (fill measurement) |
| Testing | Jest + ts-jest |

---

## API Reference

### POST /api/analyze

Runs the full two-pass optimization pipeline.

**Request:**
```json
{
  "resumeContent": "full LaTeX string",
  "jobDescription": "job description text",
  "linkedinContent": "optional LinkedIn profile text"
}
```

**Response:**
```json
{
  "slots": [...],
  "analysis": {
    "roleType": "DIGITAL_MARKETING",
    "overview": { "verdict": "...", "primaryGaps": [...], "companyName": "..." },
    "gapAnalysis": { "presentAndStrong": [...], "presentButWeak": [...], "missing": [...] },
    "preOptimizationScore": { "total": 62, "breakdown": { ... }, "gaps": [...] },
    "changePlan": [...],
    "suggestions": [{ "slotName": "...", "suggestedContent": "...", "reasoning": "..." }],
    "postOptimizationScore": { "estimated": 78, "keywordsInjected": [...], "criticalGapsRemaining": [...] },
    "personalInfo": { "name": "...", "email": "...", "phone": "...", "linkedin": "..." }
  }
}
```

### POST /api/compile

Compiles a LaTeX string to PDF.

**Request:** `{ "latex": "full LaTeX string" }`
**Response:** PDF binary (`application/pdf`)

### POST /api/cover-letter

Generates or compiles a cover letter.

**Request (generate):** `{ "mode": "generate", "resumeContent": "...", "jobDescription": "...", "linkedinContent": "..." }`
**Request (compile):** `{ "mode": "compile", "latex": "..." }`
**Response (generate):** `{ "latex": "cover letter LaTeX", "body": "plain text body" }`
**Response (compile):** PDF binary

### POST /api/parse-pdf

Extracts text from a PDF using `pdftotext -layout`.

**Request:** `multipart/form-data` with `file` field (PDF)
**Response:** `{ "text": "extracted text" }`

---

## Development

```bash
npm test          # Run Jest tests
npm run lint      # ESLint
npx tsc --noEmit  # Type check without building
```

### Logs

Each optimization run writes a structured event log to `resume_optimizer_<timestamp>_<runId>.log` in the project root (gitignored). Each line is a JSON event with timestamp, event name, and data — useful for debugging retry behavior, fill measurements, and compilation timings.

---

## Known Limitations

- **LaTeX only** — the resume must be a `.tex` file using the slot marker format
- **Single-page enforced** — the optimizer assumes and enforces a 1-page resume; overflow reverts all changes
- **Marketing-focused role types** — Pass 1 classifies into four marketing-specific role types; other industries work but get less precise keyword targeting
- **System dependencies** — `pdflatex`, `pdftotext`, and `pdfplumber` must be installed on the server; does not run in standard serverless environments
- **Single-line bullet fill** — bullets constrained to exactly 1 rendered line with ≥80% fill have a narrow valid length window; the optimizer keeps the best line-count-passing version when perfect fill cannot be achieved within the retry budget
