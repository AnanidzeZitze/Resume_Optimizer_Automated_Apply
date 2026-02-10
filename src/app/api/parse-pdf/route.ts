import { NextRequest, NextResponse } from 'next/server';

// Ensure this route runs in Node.js
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const file = formData.get('file') as File;

        if (!file) {
            return NextResponse.json({ error: 'No file provided' }, { status: 400 });
        }

        const arrayBuffer = await file.arrayBuffer();

        // Dynamically import pdfjs-dist to avoid build issues with canvas in edge
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

        // Set worker? In node we might not need it or use fake worker
        // For simple text extraction in Node, we can often disable worker or point to it
        // But pdfjs in Node usually requires some setup.
        // Actually, simpler approach for "serverless" node:

        const loadingTask = pdfjs.getDocument({
            data: new Uint8Array(arrayBuffer),
            useSystemFonts: true,
            disableFontFace: true,
        });

        const pdfDocument = await loadingTask.promise;
        let fullText = '';

        for (let i = 1; i <= pdfDocument.numPages; i++) {
            const page = await pdfDocument.getPage(i);
            const textContent = await page.getTextContent();
            const pageText = textContent.items.map((item: any) => item.str).join(' ');
            fullText += pageText + '\n';
        }

        return NextResponse.json({ text: fullText });
    } catch (error: any) {
        console.error('Error parsing PDF:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to parse PDF' },
            { status: 500 }
        );
    }
}
