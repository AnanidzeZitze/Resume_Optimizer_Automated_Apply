import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import util from 'util';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import fs from 'fs';

/*
 * A: Serves POST /api/parse-pdf
 * B: Called by the main resume application page (src/app/page.tsx) in three scenarios:
 *    1. On page load — parses the default public/linkedin.pdf to pre-fill LinkedIn text
 *    2. During analysis — parses a user-uploaded resume PDF to extract its text
 *    3. During analysis — parses a user-uploaded LinkedIn PDF to extract profile text
 * C: Accepts a multipart/form-data upload with a 'file' field containing a PDF,
 *    runs pdftotext (-layout) on it, and returns the extracted text as JSON { text: string }
 * D: Receives resume PDFs and LinkedIn export PDFs uploaded by the user (resume pipeline only)
 */

const execFilePromise = util.promisify(execFile);

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get('file') as File;

        if (!file) {
            return NextResponse.json({ error: 'No file provided' }, { status: 400 });
        }

        const arrayBuffer = await file.arrayBuffer();
        const pdfBuffer = Buffer.from(arrayBuffer);

        const tempPdfPath = path.join(os.tmpdir(), `pdf_parse_${crypto.randomBytes(8).toString('hex')}.pdf`);
        let extractedText = '';
        try {
            await fs.promises.writeFile(tempPdfPath, pdfBuffer);

            // Find pdftotext binary (same candidates as pdfline-counter.ts)
            const candidates = [
                '/opt/homebrew/bin/pdftotext',
                '/usr/local/bin/pdftotext',
                '/usr/bin/pdftotext',
            ];
            let bin = 'pdftotext';
            for (const p of candidates) {
                if (fs.existsSync(p)) { bin = p; break; }
            }

            const { stdout } = await execFilePromise(bin, ['-layout', tempPdfPath, '-'], { timeout: 15000 });
            extractedText = stdout;
        } finally {
            await fs.promises.rm(tempPdfPath, { force: true }).catch(() => {});
        }

        return NextResponse.json({ text: extractedText });
    } catch (error: any) {
        console.error('Error parsing PDF:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to parse PDF' },
            { status: 500 }
        );
    }
}
