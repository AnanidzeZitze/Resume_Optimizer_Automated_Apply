import { NextRequest, NextResponse } from 'next/server';
import { generateJSON } from '@/lib/ai-client';
import { parseSlots } from '@/lib/latex-parser';

export async function POST(req: NextRequest) {
  try {
    const { resumeContent, jobDescription, linkedinContent } = await req.json();

    if (!resumeContent || !jobDescription) {
      return NextResponse.json(
        { error: 'Missing resume content or job description' },
        { status: 400 }
      );
    }

    // 1. Parse slots from Resume
    const slots = parseSlots(resumeContent);
    if (slots.length === 0) {
      return NextResponse.json(
        { error: 'No slots found in resume. Mark slots with % SLOT: <Name> ... % END_SLOT' },
        { status: 400 }
      );
    }

    // 2. Construct prompt for analysis
    const slotData = slots.map(s => `Slot: ${s.name}\nContent:\n${s.originalContent}`).join('\n\n');

    const prompt = `
You are a senior technical recruiter and career coach known for being "brutally honest" but highly effective. 
Analyze the following resume slots and job description.

Your Goal: 
1. Provide a CRITICAL OVERVIEW of the candidate's fit. Be blunt about weak areas, overused buzzwords, and missing metrics.
2. Optimize the resume slots to be results-driven and ATS-ready.

---
PART 1: CRITICAL OVERVIEW
Analyze the resume holistically against the JD.
- Give a "Fit Score" (1-10) based on skills and experience match.
- List 3-5 specific "Weaknesses" (e.g., "Generic summary", "Lack of quantification in Project X", "Overused buzzword 'Synergy'").
- List 3-5 "Strengths".
- Write a short "Verdict" paragraph summarizing the critique.

---
PART 1: SLOT ANALYSIS
For each slot, identify what type of content it contains and what needs improvement.

CRITICAL OUTPUT FORMAT:
- Your "suggestedContent" must be COMPLETE LaTeX code that will replace the content between % SLOT and % END_SLOT markers.
- If the original slot has \begin{itemize}...\end{itemize}, your suggestion MUST include the full structure.
- If the original slot has \begin{itemize} with 3 \item bullets, generate the COMPLETE code:
  \begin{itemize}
    \item Your optimized first bullet
    \item Your optimized second bullet
    \item Your optimized third bullet
  \end{itemize}
- If the original slot has \\begin{itemize}...\\end{itemize}, your suggestion MUST include the full structure.
- If the original slot has \\begin{itemize} with 3 \\item bullets, generate the COMPLETE code:
  \\begin{itemize}
    \\item Your optimized first bullet
    \\item Your optimized second bullet
    \\item Your optimized third bullet
  \\end{itemize}
- For each \\item bullet, use \\textbf{key phrase} to bold 1-3 important skills/achievements.
- Match the LaTeX structure of the original exactly (same environments, same formatting style).
- The originalContent should show the FULL original LaTeX code for reference.
- The suggestedContent should be the FULL optimized LaTeX code.

CRITICAL LATEX COMMAND RESTRICTIONS:
- ONLY use these LaTeX commands: \\textbf{}, \\begin{itemize}, \\end{itemize}, \\item
- ABSOLUTELY NO other LaTeX commands: NO \\textit{}, \\underline{}, \\emph{}, \\section{}, \\href{}, \\url{}, etc.
- For special characters ONLY: Use \\&, \\%, \\$, \\_, \\# (these are the ONLY allowed backslash escapes)
- If you use ANY other backslash command, the compilation will FAIL.

CRITICAL FORMATTING IN JSON:
- DO NOT use \\n for line breaks in your JSON response
- Use ACTUAL newlines (line breaks) in your JSON string values
- Format like this (with real line breaks, not \\n):
  \\begin{itemize}
    \\item First bullet here
    \\item Second bullet here
  \\end{itemize}
- NOT like this: "\\begin{itemize}\\n  \\item..." (this is WRONG)

PART 2: SLOT OPTIMIZATION
For each slot, rewrite the content to be compelling and quantified.

RULES FOR "Professional Summary" (or similar):
- Write a 3-line POWER SUMMARY as CONTINUOUS PROSE (no line breaks between sentences).
- DO NOT use \\\\ between sentences. Write it as a single flowing paragraph.
- Hook the recruiter in 10 seconds.
- Prioritize impact, years of experience, and key value prop.
- NO generic fluff.

RULES FOR "Experience" / "Projects":
- Use the formula: ACTION VERB + TASK + RESULT (Quantified).
- Highlight impact and transferable skills.
- MUST include metrics (e.g., "Increased efficiency by 20%"). If exact numbers aren't in the source, use placeholders like "[X]%" or "significant".
- Generate ONE suggestion per slot that contains the COMPLETE LaTeX structure.
- If original has \begin{itemize} with 3 \item bullets, your suggestedContent should have the full \begin{itemize}...\end{itemize} block with all 3 optimized bullets.
- Use \textbf{key phrase} to bold important skills/achievements in each bullet.
- NO line breaks (\\\\) within individual bullet text.

RULES FOR ALL SLOTS:
- Your suggestedContent MUST be COMPLETE LaTeX code ready to replace the entire slot content.
- Match the structure of the original exactly (if it has \begin{itemize}, yours should too).
- Use keywords from the JD naturally.
- For SUMMARY: Write as continuous prose. You MAY use \\textbf{} to bold 3-5 key JD-matched skills/roles.
- For EXPERIENCE/PROJECTS BULLETS: Use \\textbf{key phrase} to bold 1-3 important skills/achievements per bullet. NO line breaks (\\\\\\\\) within bullet text.
- For ALL SLOT TYPES: Bold keywords that match the job description using \\textbf{}.
- For SKILLS LISTS (and ONLY skills lists): 
  - ALL skill categories (Programming, Marketing, Analytical, etc.) MUST be combined into a SINGLE recommendation for the skills slot.
  - DO NOT create separate recommendations for different skill types.
  - Format: "\\textbf{Category Name:} skill1, skill2, skill3" (category name is BOLDED, skills on same line)
  - CRITICAL: Separate each category with \\\\ (line break). Each category starts on a new line.
  - Example: "\\textbf{Programming Languages:} Python, Java \\\\ \\textbf{Marketing \\& Digital Skills:} SEO, Analytics \\\\ \\textbf{Analytical Skills \\& Tools:} Excel, Tableau"
  - DO NOT add blank lines between categories.
  - DO NOT indent.
- CRITICAL: Your response must be VALID JSON. Special characters MUST be escaped correctly.
- These are INVALID in JSON and will cause errors: \&, \%, \$, \_, \#
- ALWAYS double the backslash when writing to JSON.

- JSON ESCAPING CHEAT SHEET:
  * To write &: Use "&" (no backslash needed in plain text)
  * To write LaTeX \textbf{word}: Use "\\textbf{word}" in JSON
  * To write LaTeX line break \\: Use "\\\\" in JSON (4 backslashes)
  * If you need LaTeX \& (for skills headings): Use "\\&" in JSON (2 backslashes)

- EXAMPLE FOR SKILLS: "\\textbf{Marketing \\& Digital:} SEO \\\\ \\textbf{Analytics:} Excel"
- PLAIN TEXT (Summary/Bullets): "Increased revenue by 20% through data-driven marketing campaigns"

---
Job Description:
${jobDescription}

Full Resume Context:
${resumeContent}

LinkedIn Profile Context:
${(req as any).linkedinContent || "Not provided"}

Target Slots to Optimize:
${slotData}

Return a JSON object with this EXACT structure:
{
  "companyName": "extracted company name",
  "overview": {
    "score": 7,
    "strengths": ["string", "string"],
    "weaknesses": ["string", "string"],
    "verdict": "string"
  },
  "suggestions": [
    {
      "slotName": "Name of the slot",
      "originalContent": "Original content",
      "suggestedContent": "Optimized LaTeX content",
      "reasoning": "Why this specific change improves ATS chances"
    }
  ]
}
`;

    // 3. Call LLM
    const responseText = await generateJSON(prompt);

    // Parse response: Extract JSON from potential markdown blocks
    let cleanedJson = responseText;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleanedJson = jsonMatch[0];
    }

    // SANITIZATION: Fix common JSON escape errors in LaTeX content
    // 1. Fix \&, \%, \$, \_, \# if they are not properly escaped for JSON (i.e., if they are single backslash)
    // Note: It's hard to distinguish "valid tab \t" from "\textbf".
    // Attempt to replace single backslashes before non-special chars with double backslashes? 
    // Safer approach: The prompt fix should handle most. 
    // We can try to catch the error and auto-fix specific known bad patterns if parse fails.

    let data;
    try {
      data = JSON.parse(cleanedJson);
    } catch (e) {
      console.warn("Initial JSON parse failed, attempting strict sanitation...", e);
      // aggressive fix: replace single backslash that isn't followed by ["\\/bfnrtu] with double backslash
      // This is complex regex. Simpler: just replace common LaTeX patterns?
      // Actually, simply re-prompting or erroring might be safer, but let's try a common fix.
      // Replace `\` followed by a character that makes it invalid. 
      // Valid: \" \\ \/ \b \f \n \r \t 
      // Invalid: \a, \c, \d, \e, ... \A ... \z
      // But we actually WANT \\textbf -> in JSON string this is represented as "\\\\textbf"
      // If LLM output simply `\textbf` in the raw string, it is `\t` + `extbf`. valid!
      // The crash `Bad escaped character` usually comes from `\&` or similar.

      const fixedJson = cleanedJson.replace(/\\([^"\\/bfnrtu])/g, '\\\\$1');
      data = JSON.parse(fixedJson);
    }

    // POST-PROCESSING: Format the LaTeX content for better readability & validity
    // The UI needs actual newlines to render correctly in textarea
    if (data.suggestions && Array.isArray(data.suggestions)) {
      data.suggestions.forEach((suggestion: any) => {
        if (suggestion.suggestedContent) {
          let content = suggestion.suggestedContent;

          // 1. Replace literal "\n" sequences (often from JSON stringification) with real newlines
          content = content.replace(/\\n/g, '\n');

          // 2. Ensure basic LaTeX structure has proper spacing
          // Ensure \begin{itemize} is on its own line
          content = content.replace(/([^\n])\\begin{itemize}/g, '$1\n\\begin{itemize}');

          // Ensure \item is on its own line (with indentation)
          content = content.replace(/([^\n])\\item/g, '$1\n  \\item');

          // Ensure \end{itemize} is on its own line
          content = content.replace(/([^\n])\\end{itemize}/g, '$1\n\\end{itemize}');

          // 3. Fix potential double indentation or spacing issues
          // (Simple cleanup for common patterns)
          content = content.replace(/\n\s*\\item/g, '\n  \\item');

          // 4. Ensure skill categories (separated by \\) are on new lines
          // ONLY apply this if the slot is likely a Skills section
          const isSkillsSlot = /skill/i.test(suggestion.slotName || "");
          if (isSkillsSlot) {
            // Look for \\ (double backslash) and ensure it has a newline after it
            content = content.replace(/\\\\(?!\n)/g, '\\\\\n');
          }

          suggestion.suggestedContent = content;
        }
      });
    }

    return NextResponse.json({
      slots: slots, // original slots info
      analysis: data
    });

  } catch (error: any) {
    console.error('Error analyzing resume:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to analyze resume' },
      { status: 500 }
    );
  }
}
