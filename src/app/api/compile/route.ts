import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

export async function POST(req: NextRequest) {
    const content = await req.json();
    const { latexContent } = content;

    if (!latexContent) {
        return NextResponse.json(
            { error: 'Missing LaTeX content' },
            { status: 400 }
        );
    }

    const runId = uuidv4();
    const tempDir = path.join('/tmp', `resume-builder-${runId}`);

    try {
        // 1. Create temp directory
        await fs.promises.mkdir(tempDir, { recursive: true });

        // 2. Write LaTeX content to file
        const texPath = path.join(tempDir, 'resume.tex');
        await fs.promises.writeFile(texPath, latexContent);

        // 3. Compile LaTeX to PDF
        // Run twice for references if needed, but for resume usually once is enough unless complex.
        // Use -interaction=nonstopmode to avoid hanging on errors.
        const command = `pdflatex -interaction=nonstopmode -output-directory=${tempDir} ${texPath}`;

        try {
            await execPromise(command);
        } catch (execError: any) {
            console.error("LaTeX Compilation Failed:", execError);
            console.error("STDOUT:", execError.stdout);
            console.error("STDERR:", execError.stderr);
            console.error("Failing LaTeX Source (Snippet):", latexContent.slice(0, 500)); // Log snippet for debugging

            const logPath = path.join(tempDir, 'resume.log');
            let logContent = 'Log file not found.';
            let errorSummary = 'LaTeX compilation failed.';
            try {
                logContent = await fs.promises.readFile(logPath, 'utf-8');
                // Extract errors starting with "!"
                const errors = logContent.split('\n').filter(line => line.startsWith('!'));
                if (errors.length > 0) {
                    errorSummary = errors.join('\n');
                }
                console.error("LaTeX Log Errors:", errorSummary);
            } catch (e) { /* ignore */ }

            return NextResponse.json(
                {
                    error: errorSummary,
                    details: logContent.slice(-2000), // Last 2000 chars
                    stdout: execError.stdout,
                    stderr: execError.stderr
                },
                { status: 500 }
            );
        }

        // 4. Read generated PDF
        const pdfPath = path.join(tempDir, 'resume.pdf');
        try {
            const pdfBuffer = await fs.promises.readFile(pdfPath);

            // 5. Return PDF
            // We set headers for download
            const response = new NextResponse(pdfBuffer);
            response.headers.set('Content-Type', 'application/pdf');
            response.headers.set('Content-Disposition', 'attachment; filename="resume.pdf"');
            return response;
        } catch (readError) {
            console.error('PDF file not found after compilation');
            return NextResponse.json({ error: 'PDF file not generated' }, { status: 500 });
        }

    } catch (error: any) {
        console.error('Unexpected error during compilation:', error);
        return NextResponse.json(
            { error: 'Internal server error during compilation' },
            { status: 500 }
        );
    } finally {
        // 6. Cleanup
        try {
            await fs.promises.rm(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
            console.warn('Failed to cleanup temp dir:', cleanupError);
        }
    }
}
