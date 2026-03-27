'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Sparkles, RefreshCw, Download, FileText, CheckCircle2, BarChart3 } from 'lucide-react';
import { AmbientBackground } from '@/components/AmbientBackground';
import { FileUpload } from '@/components/FileUpload';
import { SlotAnalysis } from '@/components/ResumeEditor';
import { Slot, applyChanges } from '@/lib/latex-parser';
import { RecruiterReport } from '@/components/RecruiterReport';

// --- Types ---

type AppStep = 'upload' | 'analyzing' | 'finished';

interface AnalysisOverview {
    score: number;
    strengths: string[];
    weaknesses: string[];
    verdict: string;
}


export default function Home() {
    const [step, setStep] = useState<AppStep>('upload');

    // Inputs
    const [resumeFile, setResumeFile] = useState<File | null>(null);
    const [linkedinFile, setLinkedinFile] = useState<File | null>(null);
    // Inputs
    const [resumeText, setResumeText] = useState<string>('');
    const [linkedinText, setLinkedinText] = useState<string>('');
    const [jobDescription, setJobDescription] = useState('');

    // Analysis Data
    const [slots, setSlots] = useState<Slot[]>([]);
    const [analysisOverview, setAnalysisOverview] = useState<AnalysisOverview | null>(null);
    const [companyName, setCompanyName] = useState<string>('');
    const [showRecruiterReport, setShowRecruiterReport] = useState(false);

    // Outputs
    const [generatedPdfUrl, setGeneratedPdfUrl] = useState<string | null>(null);
    const [coverLetterPdfUrl, setCoverLetterPdfUrl] = useState<string | null>(null);

    // Load default files from public/ on mount, then restore saved job description
    React.useEffect(() => {
        const loadDefaults = async () => {
            // Always load resume.tex from public/
            try {
                const res = await fetch('/resume.tex');
                if (res.ok) setResumeText(await res.text());
            } catch (e) {
                console.error('Failed to load default resume', e);
            }

            // Always parse linkedin.pdf from public/
            try {
                const res = await fetch('/linkedin.pdf');
                if (res.ok) {
                    const blob = await res.blob();
                    const file = new File([blob], 'linkedin.pdf', { type: 'application/pdf' });
                    const formData = new FormData();
                    formData.append('file', file);
                    const parseRes = await fetch('/api/parse-pdf', { method: 'POST', body: formData });
                    if (parseRes.ok) {
                        const data = await parseRes.json();
                        setLinkedinText(data.text || '');
                    }
                }
            } catch (e) {
                console.error('Failed to load default LinkedIn profile', e);
            }

        };

        loadDefaults();
    }, []);




    // Fix common AI LaTeX output mistakes WITHOUT corrupting valid LaTeX.
    // This is for AI-generated content — it already contains \textbf, \begin, etc.
    const fixAiLatex = (str: string): string => {
        let s = str;

        // 1. Escape bare & not already preceded by backslash
        //    "Analytics & Tools" -> "Analytics \& Tools"
        s = s.replace(/(?<!\\)&/g, '\\&');

        // 2. Escape bare % not already escaped (bare % is a LaTeX comment)
        s = s.replace(/(?<!\\)%/g, '\\%');

        // 3. Remove stray \\ at the very start of content
        //    (causes "no line here to end")
        s = s.replace(/^\s*\\\\\s*/m, '');

        // 4. Remove \\ directly after \begin{itemize}
        s = s.replace(/(\\begin\{itemize\})\s*\\\\/g, '$1');

        // 5. Remove \\ directly before \end{itemize}
        s = s.replace(/\\\\\s*(\\end\{itemize\})/g, '$1');

        // 6. Remove trailing \\ at end of content
        s = s.replace(/\\\\\s*$/m, '');

        return s;
    };

    const handleAnalyze = async () => {
        if ((!resumeFile && !resumeText) || !jobDescription) return;

        setStep('analyzing');

        try {
            // 1. Get Resume Text
            let text = resumeText;
            if (resumeFile) {
                if (resumeFile.type === 'application/pdf' || resumeFile.name.endsWith('.pdf')) {
                    const formData = new FormData();
                    formData.append('file', resumeFile);
                    const lpRes = await fetch('/api/parse-pdf', {
                        method: 'POST',
                        body: formData
                    });
                    if (lpRes.ok) {
                        const lpData = await lpRes.json();
                        text = lpData.text || '';
                    } else {
                        throw new Error('Failed to parse resume PDF');
                    }
                } else {
                    text = await resumeFile.text();
                }
                setResumeText(text);
            }

            // 2. Get LinkedIn Text (if uploaded)
            let lt = linkedinText;
            if (linkedinFile) {
                try {
                    const formData = new FormData();
                    formData.append('file', linkedinFile);
                    const lpRes = await fetch('/api/parse-pdf', {
                        method: 'POST',
                        body: formData
                    });
                    if (lpRes.ok) {
                        const lpData = await lpRes.json();
                        lt = lpData.text || '';
                        setLinkedinText(lt);
                    }
                } catch (e) {
                    console.error("Failed to parse LinkedIn PDF", e);
                }
            }

            // 3. Analyze Resume
            const res = await fetch('/api/analyze', {
                method: 'POST',
                body: JSON.stringify({
                    resumeContent: text,
                    jobDescription,
                    linkedinContent: lt
                }),
                headers: { 'Content-Type': 'application/json' }
            });

            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            setSlots(data.slots);
            if (data.analysis.overview) {
                setAnalysisOverview(data.analysis.overview);
            }
            const extractedCompany = data.analysis.companyName || 'Company';
            setCompanyName(extractedCompany);

            // 4. Auto-apply all AI suggestions
            const suggestions: SlotAnalysis[] = data.analysis.suggestions || [];
            const autoAppliedMods: Record<string, string> = {};
            data.slots.forEach((s: Slot) => {
                const suggestion = suggestions.find((sg: SlotAnalysis) => sg.slotName === s.name);
                autoAppliedMods[s.name] = suggestion ? suggestion.suggestedContent : s.originalContent;
            });

            // 5. Generate Cover Letter
            let coverText = '';
            try {
                const coverRes = await fetch('/api/cover-letter', {
                    method: 'POST',
                    body: JSON.stringify({
                        resumeContent: text,
                        jobDescription,
                        linkedinContent: lt,
                        companyName: extractedCompany,
                        personalInfo: data.analysis.personalInfo || null,
                        mode: 'generate'
                    }),
                    headers: { 'Content-Type': 'application/json' }
                });
                if (coverRes.ok) {
                    const coverData = await coverRes.json();
                    coverText = coverData.text || '';
                }
            } catch (e) {
                console.error("Cover letter generation failed", e);
            }

            // 6. Compile Resume PDF with auto-applied suggestions
            const modifications = Object.entries(autoAppliedMods).map(([name, content]) => ({
                slotName: name,
                newContent: fixAiLatex(content)
            }));
            const newLatex = applyChanges(text, modifications);
            const resumeRes = await fetch('/api/compile', {
                method: 'POST',
                body: JSON.stringify({ latexContent: newLatex }),
                headers: { 'Content-Type': 'application/json' }
            });

            if (!resumeRes.ok) {
                const errData = await resumeRes.json();
                const errorMessage = errData.error || errData.details || "Resume compilation failed";
                alert(`Resume Compilation Error:\n${errorMessage}`);
                throw new Error(errorMessage);
            }

            const resumeBlob = await resumeRes.blob();
            const resumeUrl = URL.createObjectURL(resumeBlob);
            setGeneratedPdfUrl(resumeUrl);

            // 7. Compile Cover Letter PDF
            if (coverText) {
                try {
                    const clRes = await fetch('/api/cover-letter', {
                        method: 'POST',
                        body: JSON.stringify({
                            latexBody: coverText,
                            mode: 'compile'
                        }),
                        headers: { 'Content-Type': 'application/json' }
                    });
                    if (clRes.ok) {
                        const clBlob = await clRes.blob();
                        setCoverLetterPdfUrl(URL.createObjectURL(clBlob));
                    } else {
                        const errData = await clRes.json();
                        console.error(`Cover Letter Compilation Error: ${errData.error}`);
                    }
                } catch (e) {
                    console.error("Cover letter compilation failed", e);
                }
            }

            setStep('finished');

        } catch (error) {
            console.error(error);
            alert('Analysis failed. See console.');
            setStep('upload');
        }
    };



    return (
        <div className="min-h-screen text-zinc-100 font-sans selection:bg-primary/30">
            <AmbientBackground />

            <main className="max-w-[95vw] mx-auto px-6 py-8 flex flex-col min-h-screen">

                {/* Navigation / Header */}
                <header className="flex justify-between items-center mb-8 z-10 transition-all duration-500 ease-in-out">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-gradient-to-tr from-red-600 to-red-800 rounded-xl flex items-center justify-center shadow-lg shadow-red-600/20 backdrop-blur-md">
                            <Sparkles className="w-5 h-5 text-white" />
                        </div>
                        <span className="text-xl font-bold tracking-tight">Resume<span className="text-zinc-500">AI</span></span>
                    </div>

                    {step === 'finished' && (
                    <button
                        onClick={() => setStep('upload')}
                        className="flex items-center gap-2 text-sm font-medium text-zinc-400 hover:text-white transition-colors px-4 py-2 hover:bg-white/5 rounded-full cursor-pointer"
                    >
                        <RefreshCw className="w-4 h-4" /> Start Over
                    </button>
                )}
                </header>

                <div className="flex-1 flex flex-col justify-center relative z-10">
                    <AnimatePresence mode="wait">

                        {/* ---------------- STEP 1: UPLOAD ---------------- */}
                        {step === 'upload' && (
                            <motion.div
                                key="upload"
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -20, filter: 'blur(10px)' }}
                                transition={{ duration: 0.5 }}
                                className="grid lg:grid-cols-2 gap-16 items-center max-w-7xl mx-auto"
                            >
                                <div className="space-y-8">
                                    <div className="space-y-4">
                                        <h1 className="text-5xl lg:text-7xl font-bold tracking-tighter leading-[1.1]">
                                            Tailor your <br />
                                            <span className="text-transparent bg-clip-text bg-gradient-to-r from-red-600 to-white">
                                                Resume.
                                            </span>
                                        </h1>
                                        <p className="text-xl text-zinc-400 max-w-md leading-relaxed">
                                            Upload your PDF or LaTeX resume and a job description. Our AI transforms it into a perfectly tailored masterpiece.
                                        </p>
                                    </div>

                                    <button
                                        onClick={handleAnalyze}
                                        disabled={!jobDescription}
                                        className="group relative inline-flex items-center justify-center px-8 py-4 font-semibold text-white transition-all duration-200 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden shadow-lg hover:shadow-red-600/40 rounded-full cursor-pointer"
                                    >
                                        <span className="mr-2">Start Optimization</span>
                                        <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                                    </button>
                                </div>

                                <div className="space-y-6 bg-surface/40 backdrop-blur-md p-8 rounded-3xl border border-white/5 shadow-2xl hover:border-white/10 transition-colors duration-500">
                                    <div>
                                        <FileUpload
                                            label="Resume (PDF or .tex)"
                                            selectedFile={resumeFile}
                                            onFileSelect={setResumeFile}
                                            acceptText="Accepts .pdf or .tex files"
                                            className="h-40"
                                        />
                                        {!resumeFile && resumeText && (
                                            <div className="text-sm text-green-400 mt-2 px-2 flex items-center gap-2">
                                                <CheckCircle2 className="w-4 h-4" /> resume.tex loaded from project
                                            </div>
                                        )}
                                    </div>
                                    <div>
                                        <FileUpload
                                            label="LinkedIn (Optional)"
                                            acceptText="PDF Only"
                                            selectedFile={linkedinFile}
                                            onFileSelect={setLinkedinFile}
                                            className="h-40 border-dashed border-red-600/30 bg-red-600/5"
                                        />
                                        {!linkedinFile && linkedinText && (
                                            <div className="text-sm text-green-400 mt-2 px-2 flex items-center gap-2">
                                                <CheckCircle2 className="w-4 h-4" /> linkedin.pdf loaded from project
                                            </div>
                                        )}
                                    </div>

                                    <div className="relative group">
                                        <textarea
                                            value={jobDescription}
                                            onChange={(e) => setJobDescription(e.target.value)}
                                            placeholder="Paste the Job Description here..."
                                            className="w-full h-40 bg-surfaceHighlight/50 border-2 border-transparent focus:border-red-600/50 rounded-2xl p-6 text-zinc-200 placeholder:text-zinc-600 resize-none outline-none transition-all duration-300 focus:bg-surfaceHighlight"
                                        />
                                        <div className="absolute bottom-4 right-4 text-xs font-mono text-zinc-500 bg-background/40 px-2 py-1 rounded">
                                            MARKDOWN SUPPORTED
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        )}

                        {/* ---------------- STEP 2: ANALYZING ---------------- */}
                        {step === 'analyzing' && (
                            <motion.div
                                key="analyzing"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="flex flex-col items-center justify-center space-y-8 py-20"
                            >
                                <div className="relative w-32 h-32">
                                    <div className="absolute inset-0 rounded-full border-2 border-surfaceHighlight" />
                                    <div className="absolute inset-0 rounded-full border-t-2 border-primary animate-spin" />
                                    <div className="absolute inset-4 rounded-full bg-surfaceHighlight/30 backdrop-blur-xl flex items-center justify-center shadow-[0_0_30px_rgba(139,92,246,0.2)]">
                                        <Sparkles className="w-8 h-8 text-primary animate-pulse" />
                                    </div>
                                </div>
                                <div className="text-center space-y-2">
                                    <h2 className="text-2xl font-bold text-white">Generating Documents</h2>
                                    <p className="text-zinc-500">Optimizing resume and drafting cover letter...</p>
                                </div>
                            </motion.div>
                        )}



                        {/* ---------------- STEP 4: FINISHED ---------------- */}
                        {step === 'finished' && (
                            <motion.div
                                key="finished"
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.5 }}
                                className="flex flex-col items-center max-w-5xl mx-auto w-full py-10"
                            >
                                <div className="text-center mb-16 space-y-4">
                                    <motion.div
                                        initial={{ scale: 0 }}
                                        animate={{ scale: 1 }}
                                        transition={{ type: "spring", stiffness: 200, damping: 10 }}
                                        className="relative inline-flex items-center justify-center w-28 h-28 rounded-full bg-green-500/10 text-green-400 mb-4 border border-green-500/20 shadow-[0_0_40px_rgba(34,197,94,0.15)]"
                                    >
                                        <CheckCircle2 className="w-12 h-12" />
                                        <div className="absolute -bottom-2 -right-2 bg-zinc-900 border border-white/10 px-3 py-1 rounded-full text-xs font-bold text-white shadow-xl">
                                            SCORE: {analysisOverview?.score}/10
                                        </div>
                                    </motion.div>
                                    <h2 className="text-4xl font-bold text-white tracking-tight">Ready to Apply</h2>
                                    <p className="text-zinc-400 text-lg">Your documents have been optimized for <span className="text-white font-semibold">{companyName}</span>.</p>
                                    
                                    <button
                                        onClick={() => setShowRecruiterReport(true)}
                                        className="mt-6 px-6 py-2 bg-red-600/10 hover:bg-red-600/20 text-red-500 text-sm font-bold rounded-full border border-red-600/20 transition-all flex items-center gap-2 mx-auto cursor-pointer group"
                                    >
                                        <Sparkles className="w-4 h-4 group-hover:rotate-12 transition-transform" />
                                        View Deep Analysis
                                    </button>
                                </div>

                                <div className="grid md:grid-cols-2 gap-8 w-full">
                                    {/* Result Card: Resume */}
                                    <motion.div
                                        initial={{ x: -20, opacity: 0 }}
                                        animate={{ x: 0, opacity: 1 }}
                                        transition={{ delay: 0.2 }}
                                        className="group relative bg-surface border border-white/5 rounded-3xl overflow-hidden hover:border-primary/50 transition-all duration-300 shadow-2xl"
                                    >
                                        <div className="absolute inset-0 bg-gradient-to-b from-primary/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                                        <div className="p-8 relative z-10">
                                            <div className="flex justify-between items-start mb-8">
                                                <div>
                                                    <h3 className="text-2xl font-bold text-white">Resume</h3>
                                                    <p className="text-sm text-zinc-500">Optimized PDF</p>
                                                </div>
                                                <div className="p-3 bg-white/5 rounded-xl backdrop-blur-md">
                                                    <FileText className="w-6 h-6 text-primary" />
                                                </div>
                                            </div>
                                            <div className="aspect-[3/4] bg-surface rounded-xl mb-6 border border-white/5 overflow-hidden relative">
                                                {generatedPdfUrl && <iframe src={generatedPdfUrl} className="w-full h-full opacity-70 group-hover:opacity-100 transition-opacity duration-300" />}
                                                {!generatedPdfUrl && <div className="absolute inset-0 flex items-center justify-center text-zinc-600">Preview Unavailable</div>}
                                            </div>
                                            <a href={generatedPdfUrl || '#'} download={`Gagan_BN_${companyName.replace(/\s+/g, '_')}.pdf`} className="block">
                                                <button className="w-full py-4 bg-white text-black font-bold rounded-xl hover:bg-zinc-200 transition-colors flex items-center justify-center gap-2 shadow-lg cursor-pointer">
                                                    <Download className="w-4 h-4" /> Download PDF
                                                </button>
                                            </a>
                                        </div>
                                    </motion.div>

                                    {/* Result Card: Cover Letter */}
                                    <motion.div
                                        initial={{ x: 20, opacity: 0 }}
                                        animate={{ x: 0, opacity: 1 }}
                                        transition={{ delay: 0.3 }}
                                        className="group relative bg-surface border border-white/5 rounded-3xl overflow-hidden hover:border-secondary/50 transition-all duration-300 shadow-2xl"
                                    >
                                        <div className="absolute inset-0 bg-gradient-to-b from-secondary/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                                        <div className="p-8 relative z-10">
                                            <div className="flex justify-between items-start mb-8">
                                                <div>
                                                    <h3 className="text-2xl font-bold text-white">Cover Letter</h3>
                                                    <p className="text-sm text-zinc-500">Harvard Business Style</p>
                                                </div>
                                                <div className="p-3 bg-white/5 rounded-xl backdrop-blur-md">
                                                    <FileText className="w-6 h-6 text-secondary" />
                                                </div>
                                            </div>
                                            <div className="aspect-[3/4] bg-surface rounded-xl mb-6 border border-white/5 overflow-hidden relative">
                                                {coverLetterPdfUrl && <iframe src={coverLetterPdfUrl} className="w-full h-full opacity-70 group-hover:opacity-100 transition-opacity duration-300" />}
                                                {!coverLetterPdfUrl && <div className="absolute inset-0 flex items-center justify-center text-zinc-600">Preview Unavailable</div>}
                                            </div>
                                            <a href={coverLetterPdfUrl || '#'} download={`Cover_Letter_${companyName.replace(/\s+/g, '_')}.pdf`} className="block">
                                                <button className="w-full py-4 bg-surfaceHighlight text-white font-bold rounded-xl hover:bg-surfaceHighlight/80 transition-colors flex items-center justify-center gap-2 border border-white/5 shadow-lg cursor-pointer">
                                                    <Download className="w-4 h-4" /> Download PDF
                                                </button>
                                            </a>
                                        </div>
                                    </motion.div>
                                </div>
                                <motion.div
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    transition={{ delay: 0.5 }}
                                    className="mt-12 flex justify-center gap-4"
                                >
                                    <button
                                        onClick={() => setShowRecruiterReport(true)}
                                        className="px-8 py-3 bg-red-600 text-white font-bold rounded-full hover:bg-red-700 transition-all flex items-center gap-2 shadow-[0_0_20px_rgba(220,38,38,0.3)] cursor-pointer"
                                    >
                                        <BarChart3 className="w-4 h-4" /> Recruiter Scorecard
                                    </button>
                                    <button
                                        onClick={() => setStep('upload')}
                                        className="px-8 py-3 bg-white/5 hover:bg-white/10 text-white rounded-full transition-all flex items-center gap-2 border border-white/10 cursor-pointer"
                                    >
                                        <ArrowRight className="w-4 h-4 rotate-180" /> Start Over
                                    </button>
                                </motion.div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                {/* Recruiter Report Modal */}
                <AnimatePresence>
                    {showRecruiterReport && analysisOverview && (
                        <RecruiterReport
                            overview={analysisOverview}
                            onClose={() => setShowRecruiterReport(false)}
                        />
                    )}
                </AnimatePresence>
            </main>
        </div>
    );
}

