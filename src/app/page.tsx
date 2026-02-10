'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Sparkles, RefreshCw, Download, FileText, CheckCircle2, BarChart3 } from 'lucide-react';
import { AmbientBackground } from '@/components/AmbientBackground';
import { FileUpload } from '@/components/FileUpload';
import { ResumeEditor, SlotAnalysis } from '@/components/ResumeEditor';
import { Slot, applyChanges } from '@/lib/latex-parser';
import { RecruiterReport } from '@/components/RecruiterReport';

// --- Types ---

type AppStep = 'upload' | 'analyzing' | 'workspace' | 'finished';

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
    const [resumeText, setResumeText] = useState<string>('');
    const [linkedinText, setLinkedinText] = useState<string>('');
    const [jobDescription, setJobDescription] = useState('');

    // Analysis Data
    const [slots, setSlots] = useState<Slot[]>([]);
    const [suggestions, setSuggestions] = useState<SlotAnalysis[]>([]);
    const [analysisOverview, setAnalysisOverview] = useState<AnalysisOverview | null>(null);
    const [companyName, setCompanyName] = useState<string>('');
    const [showRecruiterReport, setShowRecruiterReport] = useState(false);

    // Editor State
    const [modifiedSlots, setModifiedSlots] = useState<Record<string, string>>({});
    const [coverLetterText, setCoverLetterText] = useState<string>('');
    const [activeTab, setActiveTab] = useState<string>('');
    const [editedSuggestions, setEditedSuggestions] = useState<Record<string, string>>({});

    // Outputs
    const [generatedPdfUrl, setGeneratedPdfUrl] = useState<string | null>(null);
    const [coverLetterPdfUrl, setCoverLetterPdfUrl] = useState<string | null>(null);



    const handleAnalyze = async () => {
        if (!resumeFile || !jobDescription) return;

        setStep('analyzing');
        setModifiedSlots({}); // Reset modifications on new analysis

        try {
            // 1. Get Resume Text
            const text = await resumeFile.text();
            setResumeText(text);

            // 2. Get LinkedIn Text (if uploaded)
            let lt = '';
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
            setSuggestions(data.analysis.suggestions);
            if (data.analysis.overview) {
                setAnalysisOverview(data.analysis.overview);
                setShowRecruiterReport(true);
            }
            const extractedCompany = data.analysis.companyName || 'Company';
            setCompanyName(extractedCompany);

            // Set initial active tab
            if (data.slots.length > 0) setActiveTab(data.slots[0].name);

            // Initialize modified slots with original content
            const initialMods: Record<string, string> = {};
            data.slots.forEach((s: Slot) => {
                initialMods[s.name] = s.originalContent;
            });
            setModifiedSlots(initialMods);

            // Note: We don't need to initialize editedSuggestions, they default to empty (fallback to suggestion.suggestedContent in child)
            setEditedSuggestions({});

            // 4. Generate Cover Letter Draft (Simultaneous)
            try {
                const coverRes = await fetch('/api/cover-letter', {
                    method: 'POST',
                    body: JSON.stringify({
                        resumeContent: text,
                        jobDescription,
                        linkedinContent: lt,
                        companyName: extractedCompany,
                        mode: 'generate'
                    }),
                    headers: { 'Content-Type': 'application/json' }
                });

                if (coverRes.ok) {
                    const coverData = await coverRes.json();
                    setCoverLetterText(coverData.text || '');
                }
            } catch (e) {
                console.error("Cover letter generation failed", e);
            }

            setStep('workspace');

        } catch (error) {
            console.error(error);
            alert('Analysis failed. See console.');
            setStep('upload');
        }
    };

    const handleUpdateSlot = (slotName: string, newContent: string) => {
        setModifiedSlots(prev => ({
            ...prev,
            [slotName]: newContent
        }));
    };

    const handleSuggestionChange = (slotName: string, newValue: string) => {
        setEditedSuggestions(prev => ({
            ...prev,
            [slotName]: newValue
        }));
    };

    const handleFinalizeAll = async () => {
        setStep('analyzing');

        try {
            // Helper to sanitize LaTeX content, allowing only specific commands
            const sanitizeLatex = (str: string) => {
                // 1. First, handle allowed escaped characters to protect them
                // We'll replace them with placeholders temporarily.
                let processed = str
                    .replace(/\\&/g, '@@AMP@@')
                    .replace(/\\%/g, '@@PCT@@')
                    .replace(/\\\$/g, '@@DLR@@')
                    .replace(/\\_/g, '@@USC@@')
                    .replace(/\\#/g, '@@HSH@@');

                // 2. Escape ALL remaining special characters
                // Since valid ones are protected, any remaining special char is "naked" and must be escaped.
                processed = processed
                    .replace(/&/g, '\\&')
                    .replace(/%/g, '\\%')
                    .replace(/\$/g, '\\$')
                    .replace(/#/g, '\\#')
                    .replace(/_/g, '\\_');

                // 3. Whitelist specific commands: \textbf, \begin, \end, \item, \\ (line break)
                // We need to protect these before escaping other backslashes
                processed = processed
                    .replace(/\\textbf/g, '@@BOLD@@')
                    .replace(/\\begin/g, '@@BEGIN@@')
                    .replace(/\\end/g, '@@END@@')
                    .replace(/\\item/g, '@@ITEM@@')
                    .replace(/\\\\/g, '@@BREAK@@'); // Allow \\ for manual line breaks

                // 4. Escape any remaining backslashes (which would be invalid commands or literal backslashes)
                // This catches \n, \s, \undefined, etc. by turning \ into space
                processed = processed.replace(/\\/g, ' ');

                // 5. Restore whitelisted commands and characters
                processed = processed
                    .replace(/@@BOLD@@/g, '\\textbf')
                    .replace(/@@BEGIN@@/g, '\\begin')
                    .replace(/@@END@@/g, '\\end')
                    .replace(/@@ITEM@@/g, '\\item')
                    .replace(/@@BREAK@@/g, '\\\\')
                    .replace(/@@AMP@@/g, '\\&')
                    .replace(/@@PCT@@/g, '\\%')
                    .replace(/@@DLR@@/g, '\\$')
                    .replace(/@@USC@@/g, '\\_')
                    .replace(/@@HSH@@/g, '\\#');

                return processed;
            };

            const modifications = Object.entries(modifiedSlots).map(([name, content]) => ({
                slotName: name,
                newContent: sanitizeLatex(content)
            }));

            // 1. Compile Resume PDF
            const newLatex = applyChanges(resumeText, modifications);
            const resumeRes = await fetch('/api/compile', {
                method: 'POST',
                body: JSON.stringify({ latexContent: newLatex }),
                headers: { 'Content-Type': 'application/json' }
            });

            if (!resumeRes.ok) {
                const errData = await resumeRes.json();
                const errorMessage = errData.error || errData.details || "Resume compilation failed";
                alert(`Resume Compilation Error:\n${errorMessage}\n\nCheck console for full log.`);
                throw new Error(errorMessage);
            }

            const resumeBlob = await resumeRes.blob();
            const resumeUrl = URL.createObjectURL(resumeBlob);
            setGeneratedPdfUrl(resumeUrl);

            // 2. Compile Cover Letter PDF
            const coverRes = await fetch('/api/cover-letter', {
                method: 'POST',
                body: JSON.stringify({
                    latexBody: coverLetterText,
                    mode: 'compile'
                }),
                headers: { 'Content-Type': 'application/json' }
            });

            if (coverRes.ok) {
                const coverBlob = await coverRes.blob();
                const coverUrl = URL.createObjectURL(coverBlob);
                setCoverLetterPdfUrl(coverUrl);
            } else {
                const errData = await coverRes.json();
                alert(`Cover Letter Compilation Error: ${errData.error}`);
            }

            setStep('finished');

        } catch (error: any) {
            console.error(error);
            setStep('workspace');
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

                    {step !== 'upload' && step !== 'analyzing' && (
                        <div className="flex gap-4">
                            {step === 'workspace' && (
                                <button
                                    onClick={handleFinalizeAll}
                                    className="px-6 py-2 bg-white text-black font-bold rounded-full hover:bg-zinc-200 transition-colors flex items-center gap-2 shadow-lg shadow-white/10 cursor-pointer"
                                >
                                    Finalize & Download <CheckCircle2 className="w-4 h-4" />
                                </button>
                            )}
                            <button
                                onClick={() => setStep('upload')}
                                className="flex items-center gap-2 text-sm font-medium text-zinc-400 hover:text-white transition-colors px-4 py-2 hover:bg-white/5 rounded-full cursor-pointer"
                            >
                                <RefreshCw className="w-4 h-4" /> Start Over
                            </button>
                        </div>
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
                                            Upload your LaTeX resume and a job description. Our AI rewrites the source code to match the role perfectly.
                                        </p>
                                    </div>

                                    <button
                                        onClick={handleAnalyze}
                                        disabled={!resumeFile || !jobDescription}
                                        className="group relative inline-flex items-center justify-center px-8 py-4 font-semibold text-white transition-all duration-200 bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden shadow-lg hover:shadow-red-600/40 rounded-full cursor-pointer"
                                    >
                                        <span className="mr-2">Start Optimization</span>
                                        <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                                    </button>
                                </div>

                                <div className="space-y-6 bg-surface/40 backdrop-blur-md p-8 rounded-3xl border border-white/5 shadow-2xl hover:border-white/10 transition-colors duration-500">
                                    <FileUpload
                                        label="Resume (.tex)" // Compatibility prop
                                        selectedFile={resumeFile}
                                        onFileSelect={setResumeFile}
                                        className="h-40"
                                    />
                                    <FileUpload
                                        label="LinkedIn (Optional)"
                                        acceptText="PDF Only"
                                        selectedFile={linkedinFile}
                                        onFileSelect={setLinkedinFile}
                                        className="h-40 border-dashed border-red-600/30 bg-red-600/5"
                                    />

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

                        {/* ---------------- STEP 3: WORKSPACE (UNIFIED) ---------------- */}
                        {step === 'workspace' && (
                            <motion.div
                                key="workspace"
                                initial={{ opacity: 0, scale: 0.95 }}
                                animate={{ opacity: 1, scale: 1 }}
                                exit={{ opacity: 0, scale: 1.05 }}
                                transition={{ duration: 0.4 }}
                                className="w-full flex flex-col gap-16 pb-32"
                            >
                                {/* Top: Resume Editor */}
                                <div className="flex flex-col h-[85vh] space-y-4">
                                    <div className="flex items-center justify-between text-2xl font-bold text-white px-2">
                                        <div className="flex items-center gap-2">
                                            <div className="p-2 bg-primary/10 rounded-lg">
                                                <FileText className="w-6 h-6 text-primary" />
                                            </div>
                                            Resume Optimizer
                                        </div>
                                        {analysisOverview && (
                                            <button
                                                onClick={() => setShowRecruiterReport(true)}
                                                className="text-xs bg-white/10 hover:bg-white/20 text-zinc-300 hover:text-white px-3 py-1.5 rounded-full transition-colors font-medium flex items-center gap-2 cursor-pointer"
                                            >
                                                <BarChart3 className="w-3 h-3" /> View Report
                                            </button>
                                        )}
                                    </div>
                                    <ResumeEditor
                                        slots={slots}
                                        suggestions={suggestions}
                                        modifiedSlots={modifiedSlots}
                                        onUpdateSlot={handleUpdateSlot}
                                        activeTab={activeTab}
                                        onTabChange={setActiveTab}
                                        editedSuggestions={editedSuggestions}
                                        onSuggestionChange={handleSuggestionChange}
                                        className="h-full shadow-2xl"
                                    />
                                </div>

                                {/* Bottom: Cover Letter Editor */}
                                <div className="flex flex-col h-[70vh] space-y-4">
                                    <div className="flex items-center gap-2 text-2xl font-bold text-white px-2">
                                        <div className="p-2 bg-secondary/10 rounded-lg">
                                            <FileText className="w-6 h-6 text-secondary" />
                                        </div>
                                        Cover Letter Editor
                                    </div>
                                    <div className="flex-1 bg-surface/60 backdrop-blur-xl border border-white/10 rounded-3xl overflow-hidden shadow-2xl p-8 relative group">
                                        <div className="absolute top-4 right-4 px-3 py-1 bg-background/20 rounded-full text-xs text-zinc-500 font-mono">
                                            LaTeX / Markdown Supported
                                        </div>
                                        <textarea
                                            value={coverLetterText}
                                            onChange={(e) => setCoverLetterText(e.target.value)}
                                            className="w-full h-full bg-transparent text-zinc-200 resize-none outline-none font-mono text-sm leading-relaxed"
                                            placeholder="Generating cover letter..."
                                            spellCheck={false}
                                        />
                                    </div>
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
                                        className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-green-500/10 text-green-400 mb-2 border border-green-500/20 shadow-[0_0_30px_rgba(34,197,94,0.2)]"
                                    >
                                        <CheckCircle2 className="w-10 h-10" />
                                    </motion.div>
                                    <h2 className="text-4xl font-bold text-white">Ready for Apply</h2>
                                    <p className="text-zinc-400">Your documents have been optimized for <span className="text-white font-semibold">{companyName}</span>.</p>
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
                                    className="mt-12 flex justify-center"
                                >
                                    <button
                                        onClick={() => setStep('workspace')}
                                        className="px-8 py-3 bg-white/5 hover:bg-white/10 text-white rounded-full transition-all flex items-center gap-2 border border-white/10 cursor-pointer"
                                    >
                                        <ArrowRight className="w-4 h-4 rotate-180" /> Back to Workspace
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

