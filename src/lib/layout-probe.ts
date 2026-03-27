import { compileLatex } from './latex-utils';

export interface LayoutMetrics {
    maxCharsPerLine: number;
    textwidthPts: number;
    charWidthPts: number;
}

/**
 * Probes the LaTeX engine to determine the exact text width and average character width
 * for a given preamble. This allows for precise calculation of character limits.
 */
export async function getLayoutMetrics(preamble: string): Promise<LayoutMetrics> {
    // Create a measurement document
    // We use a large string of characters to get a better average
    const measurementDoc = `
${preamble}
\\begin{document}
\\setbox0=\\hbox{abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789}
\\typeout{MEASURE_WIDTH: \\the\\textwidth}
\\typeout{MEASURE_CHARWIDTH: \\the\\dimexpr\\wd0/62\\relax}
\\end{document}
`;

    try {
        const { log } = await compileLatex(measurementDoc, { runs: 1, timeout: 15000 });
        
        const widthMatch = log.match(/MEASURE_WIDTH: ([\d.]+)pt/);
        const charWidthMatch = log.match(/MEASURE_CHARWIDTH: ([\d.]+)pt/);
        
        if (!widthMatch || !charWidthMatch) {
            console.error('Failed to extract metrics from LaTeX log. Log snippet:', log.slice(-1000));
            throw new Error('Could not parse LaTeX measurement output');
        }
        
        const textwidthPts = parseFloat(widthMatch[1]);
        const charWidthPts = parseFloat(charWidthMatch[1]);
        
        // Discount factor: LaTeX's justification algorithm fills lines to ~95% before wrapping.
        // Calibrated against 50 compiled bullets measured with pdfplumber.
        const LINE_WIDTH_DISCOUNT = 0.95;
        const maxCharsPerLine = Math.floor((textwidthPts / charWidthPts) * LINE_WIDTH_DISCOUNT);
        
        return {
            maxCharsPerLine,
            textwidthPts,
            charWidthPts
        };
    } catch (error) {
        console.error('Layout probe failed:', error);
        // Return sensible defaults if probing fails
        return {
            maxCharsPerLine: 80,
            textwidthPts: 468, // ~6.5 inches
            charWidthPts: 5.5
        };
    }
}

/**
 * Simple helper to extract the preamble from a LaTeX document string.
 */
export function extractPreamble(texContent: string): string {
    const beginDocIndex = texContent.indexOf('\\begin{document}');
    if (beginDocIndex === -1) return texContent;
    return texContent.substring(0, beginDocIndex);
}
