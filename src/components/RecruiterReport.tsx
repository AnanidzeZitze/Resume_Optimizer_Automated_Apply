
import React from 'react';
import { motion } from 'framer-motion';
import { X, CheckCircle2, AlertTriangle, TrendingUp, BarChart3 } from 'lucide-react';

interface AnalysisOverview {
    score: number;
    strengths: string[];
    weaknesses: string[];
    verdict: string;
}

interface RecruiterReportProps {
    overview: AnalysisOverview;
    onClose: () => void;
}

export function RecruiterReport({ overview, onClose }: RecruiterReportProps) {
    const getScoreColor = (score: number) => {
        if (score >= 8) return 'text-green-400 border-green-500/50 bg-green-500/10';
        if (score >= 5) return 'text-amber-400 border-amber-500/50 bg-amber-500/10';
        return 'text-red-400 border-red-500/50 bg-red-500/10';
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="bg-[#0A0A0A] border border-white/10 rounded-3xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl relative"
            >
                {/* Header */}
                <div className="sticky top-0 bg-[#0A0A0A]/90 backdrop-blur-md p-6 border-b border-white/5 flex justify-between items-center z-10">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-red-600/10 rounded-xl">
                            <BarChart3 className="w-6 h-6 text-red-600" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold text-white">Recruiter's Report</h2>
                            <p className="text-zinc-400 text-sm">Critical Analysis & Fit Check</p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 hover:bg-white/5 rounded-full text-zinc-400 hover:text-white transition-colors cursor-pointer"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="p-8 space-y-8">
                    {/* Score Section */}
                    <div className="flex flex-col items-center">
                        <div className={`w-32 h-32 rounded-full flex flex-col items-center justify-center border-4 ${getScoreColor(overview.score)} shadow-[0_0_30px_rgba(0,0,0,0.3)]`}>
                            <span className="text-5xl font-bold">{overview.score}</span>
                            <span className="text-xs uppercase font-bold opacity-80">/ 10</span>
                        </div>
                        <p className="mt-4 text-center text-zinc-300 italic max-w-md">
                            "{overview.verdict}"
                        </p>
                    </div>

                    <div className="grid md:grid-cols-2 gap-6">
                        {/* Strengths */}
                        <div className="space-y-4">
                            <h3 className="flex items-center gap-2 text-green-400 font-bold uppercase text-sm tracking-wider">
                                <CheckCircle2 className="w-4 h-4" /> Top Strengths
                            </h3>
                            <div className="space-y-2">
                                {overview.strengths.map((s, i) => (
                                    <div key={i} className="p-3 bg-green-500/5 border border-green-500/10 rounded-xl text-zinc-300 text-sm">
                                        {s}
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Weaknesses */}
                        <div className="space-y-4">
                            <h3 className="flex items-center gap-2 text-red-400 font-bold uppercase text-sm tracking-wider">
                                <AlertTriangle className="w-4 h-4" /> Improvement Areas
                            </h3>
                            <div className="space-y-2">
                                {overview.weaknesses.map((w, i) => (
                                    <div key={i} className="p-3 bg-red-500/5 border border-red-500/10 rounded-xl text-zinc-300 text-sm">
                                        {w}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="p-4 bg-red-600/5 border border-red-600/10 rounded-2xl flex items-start gap-4">
                        <div className="p-2 bg-red-600/10 rounded-lg text-red-600">
                            <TrendingUp className="w-5 h-5" />
                        </div>
                        <div>
                            <h4 className="text-white font-bold text-sm mb-1">What's Next?</h4>
                            <p className="text-zinc-400 text-sm">
                                We've generated tailored rewrites to address these weaknesses.
                                Use the workspace to review and apply the optimized content.
                            </p>
                        </div>
                    </div>
                </div>

                <div className="p-6 border-t border-white/5 flex justify-end">
                    <button
                        onClick={onClose}
                        className="px-6 py-3 bg-white text-black font-bold rounded-full hover:bg-zinc-200 transition-colors cursor-pointer"
                    >
                        Review Recommended Changes
                    </button>
                </div>
            </motion.div>
        </div>
    );
}
