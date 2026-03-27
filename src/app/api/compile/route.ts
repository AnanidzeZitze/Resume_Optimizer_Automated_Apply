import { NextRequest, NextResponse } from 'next/server';
import { compileLatexToPdf } from '@/lib/latex-utils';

export async function POST(req: NextRequest) {
    try {
        const data = await req.json();
        const { latexContent, latexBody, runs = 1 } = data;
        const contentToCompile = latexContent || latexBody;

        if (!contentToCompile) {
            return NextResponse.json({ error: 'Missing LaTeX content' }, { status: 400 });
        }

        const pdfBuffer = await compileLatexToPdf(contentToCompile, { runs });

        const response = new NextResponse(new Uint8Array(pdfBuffer));
        response.headers.set('Content-Type', 'application/pdf');
        response.headers.set('Content-Disposition', 'attachment; filename="resume.pdf"');

        return response;

    } catch (error: any) {
        console.error('Unexpected error in compile API:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to compile LaTeX' },
            { status: 500 }
        );
    }
}
