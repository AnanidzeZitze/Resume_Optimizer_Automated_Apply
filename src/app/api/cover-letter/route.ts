import { NextRequest, NextResponse } from 'next/server';
import { generateJSON, generateContent } from '@/lib/ai-client';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { mode = 'generate', resumeContent, jobDescription, linkedinContent, latexBody } = body;

        // MODE: COMPILE (Takes existing latex body and compiles to PDF)
        if (mode === 'compile') {
            if (!latexBody) {
                return NextResponse.json({ error: 'Missing latexBody for compilation' }, { status: 400 });
            }

            const fullLatex = `
\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage{geometry}
\\geometry{a4paper, margin=1in}
\\usepackage{parskip}

\\begin{document}
\\pagestyle{empty} 

${latexBody.replace(/\\documentclass[\s\S]*?\\begin{document}/, '').replace(/\\end{document}/, '')}

\\end{document}
`;

            const runId = uuidv4();
            const tempDir = path.join('/tmp', `cover-letter-${runId}`);

            await fs.promises.mkdir(tempDir, { recursive: true });
            const texPath = path.join(tempDir, 'coverliteral.tex');
            await fs.promises.writeFile(texPath, fullLatex);

            try {
                await execPromise(`pdflatex -interaction=nonstopmode -output-directory=${tempDir} ${texPath}`);
            } catch (execError: any) {
                console.error("LaTeX Compilation Failed:", execError);
                console.error("STDOUT:", execError.stdout);
                console.error("STDERR:", execError.stderr);
                // Try to read the log file
                let logContent = 'Log file not found.';
                let errorSummary = 'LaTeX compilation failed.';
                try {
                    const logPath = path.join(tempDir, 'coverliteral.log');
                    logContent = await fs.promises.readFile(logPath, 'utf-8');
                    console.error("LaTeX Log:", logContent);

                    // Extract errors starting with "!"
                    const errors = logContent.split('\n').filter(line => line.startsWith('!'));
                    if (errors.length > 0) {
                        errorSummary = errors.join('\n');
                    }
                } catch (e) { /* ignore */ }

                return NextResponse.json(
                    {
                        error: errorSummary,
                        details: logContent.slice(-2000),
                        stdout: execError.stdout,
                        stderr: execError.stderr
                    },
                    { status: 500 }
                );
            }

            const pdfPath = path.join(tempDir, 'coverliteral.pdf');
            const pdfBuffer = await fs.promises.readFile(pdfPath);

            await fs.promises.rm(tempDir, { recursive: true, force: true });

            const response = new NextResponse(pdfBuffer);
            response.headers.set('Content-Type', 'application/pdf');
            response.headers.set('Content-Disposition', 'attachment; filename="Cover_Letter.pdf"');

            return response;
        }

        // MODE: GENERATE (Default - Generates text via AI)
        const { companyName = "Company Name" } = body;

        if (!resumeContent || !jobDescription) {
            return NextResponse.json(
                { error: 'Missing resume content or job description' },
                { status: 400 }
            );
        }

        const prompt = `
Act as an expert Career Strategist and ATS Optimization Specialist. Write a compelling, Harvard Business School-style cover letter with natural paragraph flow and professional narrative structure.

### WRITING STYLE:
- Professional, high-energy, confident but grounded
- Natural flowing paragraphs (not rigid template structure)
- Strong storytelling with business impact focus
- No fluff or generic clichés
- CRITICAL: Keep paragraphs balanced and concise (3-5 sentences each, max 60-80 words per paragraph)
- Avoid long, dense paragraphs - break up content for readability
- Aim for 4-6 well-balanced paragraphs total

### CRITICAL REQUIREMENTS TO INCLUDE (woven naturally throughout):

**ATS Optimization:**
- Identify and integrate high-frequency hard skills and technical terms from the job description
- Bold ALL keywords and industry-specific terms using \\textbf{keyword} in LaTeX

**Company Research & Hook:**
- Open with attention-grabbing reference to ${companyName}'s recent news, product launch, or market move
- Demonstrate genuine research and knowledge of the company
- Show alignment with their mission/vision

**Value Proposition & Solutions:**
- Based on the resume, articulate 3 specific solutions to ${companyName}'s current market challenges
- Connect candidate's experience directly to company needs
- Use metrics and quantified achievements

**Achievement Stories:**
- Include 3 compelling achievement narratives using format: Challenge → Solution → Business Impact
- Every achievement must include specific metrics (percentages, dollar amounts, time savings, etc.)
- Bold technical skills and tools used

**Culture Fit & Collaboration:**
- Reference ${companyName}'s core values and demonstrate alignment
- Include specific examples of successful cross-functional collaboration
- Show how candidate's working style matches company culture

**Continuous Learning & Growth:**
- Highlight specific skill development and continuous improvement examples
- Mention tools, certifications, or technologies mastered
- Bold the skill/tool names

**Industry Expertise:**
- Demonstrate deep knowledge of the industry
- Include a current trend analysis or market insight
- Propose a specific solution framework or strategic approach

**Innovation & Future Alignment:**
- Show understanding of ${companyName}'s future growth plans or recent innovations
- Propose one high-level innovation idea or strategic initiative
- Connect candidate's vision with company direction

**Strong Closing:**
- Clear articulation of immediate contribution potential
- Long-term value proposition
- Confident call to action requesting interview/conversation

### FORMATTING RULES FOR LaTeX:
- Use \\textbf{} for ALL keywords, company name, technical terms, and important phrases
- Use DOUBLE NEWLINES (blank lines) to separate paragraphs - DO NOT use \\\\\\\\ for paragraph breaks
- Escape special characters: \\&, \\%, \\$, \\_, \\#
- End with: "Sincerely,\\\\\\\\ \\nGagan Bhaskar Naik"
- Keep total length to 400-500 words

### INPUTS:

Job Description:
${jobDescription}

Resume:
${resumeContent}

LinkedIn Profile Context:
${linkedinContent || "Not provided"}

### OUTPUT:
Provide ONLY the body paragraphs in LaTeX format (no header, no salutation). Create a flowing narrative that naturally incorporates ALL the requirements above. The letter should read like a compelling story, not a checklist.
`;

        const bodyLatex = await generateContent(prompt);

        // Construct the full text including header for the user to review/edit
        const header = `{\\textbf{Gagan Bhaskar Naik}}\\\\
Sunnyvale, CA\\\\
gbhaskarnaik1@babson.edu $\\vert$ (774)-290-3032

\\today

Hiring Team\\\\
{${companyName}}

Dear Hiring Manager,`;

        // Ensure strictly one paragraph break between header and body
        let cleanBody = bodyLatex.trim();

        // Post-processing: Convert Markdown bold (**text**) to LaTeX bold (\textbf{text})
        // The AI sometimes outputs Markdown despite instructions.
        cleanBody = cleanBody.replace(/\*\*(.*?)\*\*/g, '\\textbf{$1}');

        return NextResponse.json({ text: header + "\n\n" + cleanBody });

    } catch (error: any) {
        console.error('Error generating cover letter:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to generate cover letter' },
            { status: 500 }
        );
    }
}
