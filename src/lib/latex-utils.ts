import { execFile } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

const execFilePromise = util.promisify(execFile);

export async function compileLatex(
    texContent: string,
    options: { runs?: number, timeout?: number } = {}
): Promise<{ pdf?: Buffer, log: string, pages: number }> {
    const { runs = 1, timeout = 30000 } = options;
    const runId = uuidv4();
    const tempDir = path.join(os.tmpdir(), `latex-${runId}`);

    await fs.promises.mkdir(tempDir, { recursive: true });
    const texPath = path.join(tempDir, 'document.tex');
    await fs.promises.writeFile(texPath, texContent);

    let logContent = '';

    try {
        const pdflatexPath = os.platform() === 'darwin' ? '/Library/TeX/texbin/pdflatex' : 'pdflatex';
        for (let i = 0; i < runs; i++) {
            await execFilePromise(pdflatexPath, [
                '-interaction=nonstopmode',
                `-output-directory=${tempDir}`,
                texPath,
            ], {
                timeout,
                env: {
                    ...process.env,
                    PATH: `${process.env.PATH || '/usr/bin:/bin'}:/Library/TeX/texbin:/usr/local/bin`,
                },
            });
        }

        const logPath = path.join(tempDir, 'document.log');
        if (fs.existsSync(logPath)) {
            logContent = await fs.promises.readFile(logPath, 'utf8');
        }

        const pdfPath = path.join(tempDir, 'document.pdf');
        const auxPath = path.join(tempDir, 'document.aux');
        let pdfBuffer: Buffer | undefined;
        if (fs.existsSync(pdfPath)) {
            pdfBuffer = await fs.promises.readFile(pdfPath);
        }
        const pages = await getPageCountFromAux(auxPath);

        await fs.promises.rm(tempDir, { recursive: true, force: true });
        return { pdf: pdfBuffer, log: logContent, pages };
    } catch (execError: any) {
        const error = execError;
        const diagInfo = `\nSTDOUT: ${error.stdout || 'none'}\nSTDERR: ${error.stderr || 'none'}`;

        let errorLog = '';
        try {
            const logPath = path.join(tempDir, 'document.log');
            if (fs.existsSync(logPath)) {
                errorLog = await fs.promises.readFile(logPath, 'utf8');
            }
        } catch {}

        const pdfPath = path.join(tempDir, 'document.pdf');
        const pdfExists = fs.existsSync(pdfPath);

        if (pdfExists) {
            const buffer = await fs.promises.readFile(pdfPath);
            await fs.promises.rm(tempDir, { recursive: true, force: true });
            return { pdf: buffer, log: errorLog || diagInfo, pages: 1 };
        }

        await fs.promises.rm(tempDir, { recursive: true, force: true });
        throw new Error(`LaTeX compilation failed: ${error.message}${diagInfo}\nLOG: ${errorLog.slice(-1000)}`);
    }
}

export async function compileLatexToPdf(
    texContent: string,
    options: { runs?: number, timeout?: number } = {}
): Promise<Buffer> {
    const { pdf } = await compileLatex(texContent, options);
    if (!pdf) {
        throw new Error("LaTeX compilation finished but no PDF was generated.");
    }
    return pdf;
}

/**
 * Reads the page count from a LaTeX .aux file (requires \usepackage{lastpage}).
 * More reliable than PDF binary scanning — immune to object stream compression.
 */
export async function getPageCountFromAux(auxPath: string): Promise<number> {
    try {
        const aux = await fs.promises.readFile(auxPath, 'utf8');
        const match = aux.match(/\\newlabel\{LastPage\}\{\{.*?\}\{(\d+)\}\}/);
        return match ? parseInt(match[1], 10) : 1;
    } catch {
        return 1;
    }
}

