import { NextRequest, NextResponse } from 'next/server';
import { getCoverLetterTemplate } from '@/lib/latex-templates';
import { compileLatex, compileLatexToPdf } from '@/lib/latex-utils';
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// Model with Google Search grounding for company research
const modelWithSearch = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    tools: [{ googleSearch: {} } as any],
});

// Plain model for trimming (no search needed)
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

/**
 * Splits text into sentences on sentence-ending punctuation.
 * Keeps LaTeX commands (e.g. \textbf{...}) intact.
 */
function splitSentences(paragraph: string): string[] {
    // Split on . ! ? followed by whitespace or end of string, but not inside {}
    const sentences: string[] = [];
    let current = '';
    let depth = 0;
    for (let i = 0; i < paragraph.length; i++) {
        const ch = paragraph[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        current += ch;
        if (depth === 0 && /[.!?]/.test(ch)) {
            const next = paragraph[i + 1];
            if (!next || /\s/.test(next)) {
                sentences.push(current.trim());
                current = '';
            }
        }
    }
    if (current.trim()) sentences.push(current.trim());
    return sentences.filter(Boolean);
}

// Cover letter template metrics: 11pt Palatino, A4, 1.75cm all margins
// Text width: 175mm = 496pt, Palatino 11pt avg ~5.77pt/char → 86 chars/line
// Text height: 262mm = 743pt, non-body ~138pt → 605pt available for body
// Parskip overhead (7 paras): 6×5 = 30pt → 575pt for lines → 42 lines max
// Max total body chars: 42 × 86 = 3,612
const CHARS_PER_LINE     = 86;
const MIN_LINES_PER_PARA = 5;
const MAX_LINES_PER_PARA = 6;
const MIN_CHARS_PER_PARA = CHARS_PER_LINE * MIN_LINES_PER_PARA; // 430
const MAX_CHARS_PER_PARA = CHARS_PER_LINE * MAX_LINES_PER_PARA; // 516
const MIN_TOTAL_BODY_CHARS = 3000;
const MAX_TOTAL_BODY_CHARS = 3612;

/**
 * Strips LaTeX commands for the purpose of character counting,
 * so \textbf{word} counts as "word" (5 chars), not 14.
 */
function visibleLength(text: string): number {
    return text
        .replace(/\\textbf\{([^}]*)\}/g, '$1')
        .replace(/\\[a-zA-Z]+\s*/g, '')
        .replace(/[{}]/g, '')
        .length;
}

/**
 * Enforces MIN_CHARS_PER_PARA–MAX_CHARS_PER_PARA visible character range per paragraph.
 * - Trims at the last complete sentence that fits within the max.
 * - Flags paragraphs below the minimum (can't pad in post-processing; prompt handles it).
 */
function enforceParagraphBounds(para: string): string {
    const len = visibleLength(para);
    if (len >= MIN_CHARS_PER_PARA && len <= MAX_CHARS_PER_PARA) return para;

    if (len > MAX_CHARS_PER_PARA) {
        // Trim: cut at last sentence that fits within max
        const sentences = splitSentences(para);
        let result = '';
        for (const s of sentences) {
            const candidate = result ? `${result} ${s}` : s;
            if (visibleLength(candidate) > MAX_CHARS_PER_PARA) break;
            result = candidate;
        }
        return result || sentences[0];
    }

    // Below minimum — return as-is (too short paragraphs are flagged but not padded here;
    // the prompt instructs the AI to meet the minimum upfront)
    return para;
}

/**
 * Enforces 4–6 lines per paragraph and 3,612 total body chars. No paragraph count limit.
 * Lines estimated via visible character count (86 chars/line @ 11pt Palatino, 1.75cm margins).
 */
function enforceStructure(body: string): string {
    const paragraphs = body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const bounded = paragraphs.map(enforceParagraphBounds);

    // Global cap: drop trailing paragraphs until total visible chars ≤ MAX_TOTAL_BODY_CHARS
    let total = 0;
    const result: string[] = [];
    for (const para of bounded) {
        const len = visibleLength(para);
        if (total + len > MAX_TOTAL_BODY_CHARS) break;
        result.push(para);
        total += len;
    }
    const finalTotal = result.reduce((sum, p) => sum + visibleLength(p), 0);
    if (finalTotal < MIN_TOTAL_BODY_CHARS) {
        console.warn(`[CoverLetter] Body too short: ${finalTotal} chars (min ${MIN_TOTAL_BODY_CHARS})`);
    }
    return result.join('\n\n');
}

/**
 * Parses pdflatex log for overflow amount.
 * Returns overflow in pt, or 0 if none found.
 * pdflatex writes: "Overfull \vbox (Xpt too high) while \output is active"
 */
function parseOverflowPts(log: string): number {
    const match = log.match(/Overfull \\vbox \(([\d.]+)pt too high\)/);
    return match ? parseFloat(match[1]) : 0;
}

/**
 * Converts overflow points to lines and characters for the cover letter template.
 * Template: 11pt font, a4paper, top/bottom 0.9in margins, parskip 5pt.
 */
function overflowToMetrics(overflowPt: number): { lines: number; chars: number } {
    const baselineskip = 13.6;   // pt — standard for 11pt font
    const charsPerLine = 82;     // approx for 11pt Charter on A4 with 1in L/R margins
    const lines = Math.ceil(overflowPt / baselineskip);
    return { lines, chars: lines * charsPerLine };
}

/**
 * Cleans Gemini model output: removes markdown formatting, citation references,
 * and closing sign-offs that shouldn't appear in the LaTeX body.
 */
function cleanModelOutput(text: string): string {
    return text
        .trim()
        // Strip closing sign-offs
        .replace(/[\n\r]+(sincerely|regards|best regards|yours (truly|sincerely)|warm regards)[,.]?[\s\S]*$/i, '')
        // Convert markdown bold **text** → \textbf{text} (before stripping other markdown)
        .replace(/\*\*([^*]+)\*\*/g, '\\textbf{$1}')
        // Strip remaining single asterisks used for italic *text*
        .replace(/\*([^*]+)\*/g, '$1')
        // Strip markdown links [text](url) → keep text only
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        // Strip grounding citation footnotes like [1], [2], [Source], [1][2]
        .replace(/\[\d+\]/g, '')
        .replace(/\[Source[^\]]*\]/gi, '')
        // Strip markdown headers ## Header
        .replace(/^#{1,6}\s+/gm, '')
        // Strip leading bullet/list markers
        .replace(/^[\s]*[-*•]\s+/gm, '')
        // Strip bare URLs from web research — long unbreakable strings overflow the page margin
        .replace(/https?:\/\/\S+/g, '')
        // Strip source attribution phrases that leak from search grounding
        // e.g. "According to LinkedIn, ..." / "As reported by TechCrunch, " / "per their website"
        .replace(/\b(according to|as reported by|as per|based on information from|sourced from|per|as stated (on|by)|as (noted|mentioned) (on|by|in))\s+[^,.\n]{1,60}[,.\s]/gi, '')
        // Collapse any double-spaces left behind by removals
        .replace(/  +/g, ' ')
        .trim();
}

export async function POST(req: NextRequest) {
    try {
        const data = await req.json();
        const { mode = 'generate' } = data;

        if (mode === 'generate') {
            const { resumeContent, jobDescription, linkedinContent, companyName, personalInfo } = data;

            const prompt = `
                You are a senior career guidance and writing specialist with 15+ years of experience crafting executive-level cover letters. Your writing is precise, persuasive, and flows immaculately from one paragraph to the next — each idea builds naturally on the last with seamless transitions.

                JOB DESCRIPTION:
                ${jobDescription}

                RESUME CONTENT:
                ${resumeContent}

                ${linkedinContent ? `LINKEDIN CONTENT:\n${linkedinContent}` : ''}

                STRICT STRUCTURAL RULES — follow these exactly, no exceptions:
                - Write a minimum of 7 paragraphs. Add more if the content warrants it.
                - Each paragraph must be exactly 5-6 rendered lines (the page is 86 characters wide — so 430–516 characters per paragraph including spaces, excluding LaTeX commands). Write full, substantive sentences to fill each paragraph completely to at least 5 lines.
                - The entire body must be between 3,000 and 3,612 total characters including spaces. 7 paragraphs × 5 lines × 86 chars = 3,010 chars minimum — use this as your guide.
                - Separate paragraphs with a single blank line.

                CONTENT RULES:
                1. Carefully read the job description and mirror its tone, vocabulary, and level of formality throughout the letter.
                2. The letter must flow immaculately — use smooth, purposeful transitions so each paragraph leads naturally into the next.
                3. Emphasise throughout how the candidate will contribute to the team and organisation — not generic claims, but concrete ways their skills and experience directly address the company's stated needs.
                4. Use Google Search to find recent news, product launches, initiatives, or strategic developments at ${companyName || 'the company'} (within the last 12 months). Weave 1-2 specific, accurate findings naturally into the letter as plain stated facts — write them as things you already know, not as things you researched. NEVER cite the source. NEVER write phrases like "According to", "As reported by", "Based on", "I saw on", "LinkedIn shows", "their website states", "per [source]", or any attribution to a platform, website, or publication. The reader must not be able to tell where the information came from.
                5. Lead with a strong opening that immediately connects the candidate's background to the role and company.
                6. Draw on measurable achievements and business impact from the resume.
                7. Bold important words and phrases using \\textbf{...} — prioritise: (a) key skills and requirements from the job description, and (b) high-impact phrases that would immediately catch a hiring manager's eye (e.g. strong results, unique value propositions, standout achievements). Aim for 6-10 bolded instances spread naturally across the letter.
                8. RETURN ONLY THE BODY PARAGRAPHS. No headers, no LaTeX document structure.
                9. Do NOT include a closing (e.g. "Sincerely,", "Best regards,", your name). The template adds one.
                10. Escape LaTeX special characters (%, $, &, _, {, }, #, ^) if they appear in the text.
            `;

            const result = await modelWithSearch.generateContent(prompt);
            const rawText = cleanModelOutput(result.response.text());

            // Enforce structural rules post-generation
            const bodyText = enforceStructure(rawText);

            const templateParams = {
                name: personalInfo?.name || 'Applicant',
                email: personalInfo?.email || '',
                phone: personalInfo?.phone || '',
                linkedin: personalInfo?.linkedin || '',
                website: personalInfo?.website || '',
                address: personalInfo?.address || '',
                companyName: companyName || 'Hiring Manager',
            };

            let finalBody = bodyText;

            // Enforce minimum 3,000 chars — loop until met (max 3 attempts)
            for (let attempt = 0; attempt < 3; attempt++) {
                const currentLen = visibleLength(finalBody);
                if (currentLen >= MIN_TOTAL_BODY_CHARS) break;

                const shortfall = MIN_TOTAL_BODY_CHARS - currentLen;
                const linesNeeded = Math.ceil(shortfall / CHARS_PER_LINE);
                const parasNeeded = Math.ceil(linesNeeded / MIN_LINES_PER_PARA);
                console.log(`[CoverLetter] Too short: ${currentLen} chars, need ${shortfall} more (~${linesNeeded} lines). Expanding (attempt ${attempt + 1})...`);

                const expandResult = await model.generateContent(`
You are a senior career guidance and writing specialist. The cover letter body below is only ${currentLen} characters — it needs at least ${shortfall} more characters to meet the 3,000 character minimum.

Add ${parasNeeded} new paragraph(s), each 5-6 full lines (430–516 characters including spaces). Insert them before the final paragraph to maintain flow.
- Each new paragraph must be substantive: deepen a specific achievement, explain how a skill applies to the role, or expand on a contribution point.
- Each new paragraph must be 5-6 lines (430–516 chars). Write full, complete sentences — do not leave paragraphs short.
- Maintain immaculate flow and professional tone. Preserve all \\textbf{} bolding.
- Do NOT exceed 3,612 total characters.
- Do NOT include a closing or sign-off.
- Return the COMPLETE updated body, not just the new paragraphs.

CURRENT BODY:
${finalBody}
                `);
                const expanded = cleanModelOutput(expandResult.response.text());
                finalBody = enforceStructure(expanded);
                console.log(`[CoverLetter] After expansion attempt ${attempt + 1}: ${visibleLength(finalBody)} chars`);
            }

            let latex = getCoverLetterTemplate({ ...templateParams, body: finalBody }, 'classic');

            // Enforce 1-page: compile twice (lastpage needs 2 runs to resolve), trim if needed
            for (let attempt = 0; attempt < 2; attempt++) {
                const { pages, log } = await compileLatex(latex, { runs: 2 });
                if (pages <= 1) break;

                // Measure exact overflow from pdflatex log
                const overflowPt = parseOverflowPts(log);
                const { lines: overflowLines, chars: overflowChars } = overflowToMetrics(
                    overflowPt > 0 ? overflowPt : 80  // fallback: assume ~6 lines if log unparseable
                );

                console.log(`[CoverLetter] overflow ${overflowPt}pt ≈ ${overflowLines} lines / ${overflowChars} chars (attempt ${attempt + 1})`);

                const trimResult = await model.generateContent(`
You are editing a cover letter that overflows onto a second page by exactly ${overflowLines} lines (~${overflowChars} characters).

Your task: remove or shorten content to eliminate that overflow — no more, no less.
- Identify the least important sentences near the END of the letter first (the overflow is at the bottom of page 1).
- Shorten verbose phrases, remove redundant points, or trim a sentence from the last 1-2 paragraphs.
- Do NOT rewrite the whole letter. Make minimal, surgical edits.
- Preserve immaculate flow, all \\textbf{} bolding, contribution-focused language, and the strongest achievements.
- Do NOT include a closing or sign-off.

BODY:
${finalBody}
                `);
                finalBody = cleanModelOutput(trimResult.response.text());
                latex = getCoverLetterTemplate({ ...templateParams, body: finalBody }, 'classic');
            }

            return NextResponse.json({ text: latex });

        } else if (mode === 'compile') {
            const { latexContent, latexBody, runs = 1 } = data;
            const contentToCompile = latexContent || latexBody;

            if (!contentToCompile) {
                return NextResponse.json({ error: 'Missing LaTeX content' }, { status: 400 });
            }

            const pdfBuffer = await compileLatexToPdf(contentToCompile, { runs });

            const response = new NextResponse(new Uint8Array(pdfBuffer));
            response.headers.set('Content-Type', 'application/pdf');
            response.headers.set('Content-Disposition', 'attachment; filename="Cover_Letter.pdf"');

            return response;
        }

        return NextResponse.json({ error: 'Invalid mode' }, { status: 400 });

    } catch (error: any) {
        console.error('Unexpected error in cover-letter API:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to process cover letter request' },
            { status: 500 }
        );
    }
}
