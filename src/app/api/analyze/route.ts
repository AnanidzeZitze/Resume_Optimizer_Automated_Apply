import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import path from 'path';
import { parseSlots, stripLatexToVisible, parsePersonalInfo } from '@/lib/latex-parser';
import { extractPreamble } from '@/lib/layout-probe';
import {
  performStrategicAnalysis,
  generateOptimizedContent,
  validateAndRetrySlots,
  RunLogger,
} from '@/lib/pipeline';
import { getOrCreateBaseline } from '@/lib/baseline';
import { buildSlotDefs } from '@/lib/pdfline-counter';

export async function POST(req: NextRequest) {
  const runId = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  const logger = new RunLogger(runId);

  try {
    const { resumeContent, jobDescription, linkedinContent } = await req.json();

    if (!resumeContent || !jobDescription) {
      return NextResponse.json(
        { error: 'Missing resume content or job description' },
        { status: 400 }
      );
    }

    const slots = parseSlots(resumeContent);
    if (slots.length === 0) {
      return NextResponse.json({ error: 'No slots found in resume.' }, { status: 400 });
    }

    const slotNames = slots.map((s: any) => s.name);

    // Derive a stable baseline path from the resume content hash
    const resumeHash = crypto.createHash('sha256').update(resumeContent).digest('hex').slice(0, 12);
    const baselinePath = path.join(process.cwd(), `.baseline_${resumeHash}.json`);

    const slotDefs = buildSlotDefs(resumeContent, slotNames);

    // Load or create baseline (compiles original resume + pdftotext on first run)
    const baseline = await getOrCreateBaseline(resumeContent, slotNames, baselinePath, slotDefs);

    // Build slot metadata (no character budgets — only baseline line counts)
    const slotMetadata = slots.map((s: any) => ({
      name: s.name,
      originalContent: s.originalContent,
      cleanText: stripLatexToVisible(s.originalContent),
      baseline: baseline[s.name] ?? null,
    }));

    // Pass 1: strategic analysis
    const analysisData = await performStrategicAnalysis(
      jobDescription,
      linkedinContent,
      slotMetadata,
      logger
    );
    const companyType = analysisData.overview.companyType || 'GENERAL';

    // Pass 2: generate optimized content
    const finalSuggestions = await generateOptimizedContent(
      analysisData,
      slotMetadata,
      companyType,
      resumeContent,
      jobDescription,
      logger
    );

    // Validate with pdftotext and retry up to 3 times per failing slot
    const validatedSuggestions = await validateAndRetrySlots(
      resumeContent,
      finalSuggestions,
      slotMetadata,
      baseline,
      slotDefs,
      logger
    );

    const personalInfo = parsePersonalInfo(resumeContent);

    // Extract postOptimizationScore attached to first suggestion by pipeline
    const postOptimizationScore = validatedSuggestions[0]?.__postOptimizationScore ?? null;
    const cleanedSuggestions = validatedSuggestions.map(({ __postOptimizationScore: _, ...s }: any) => s);

    return NextResponse.json({
      slots: slots,
      analysis: {
        ...analysisData,
        companyName: analysisData.overview?.companyName || '',
        suggestions: cleanedSuggestions,
        personalInfo,
        postOptimizationScore,
      },
    });
  } catch (error: unknown) {
    console.error('Error analyzing resume:', error);
    return NextResponse.json(
      { error: (error as Error).message || 'Failed' },
      { status: 500 }
    );
  }
}
