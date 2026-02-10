import React, { useState, useEffect } from 'react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { Slot } from '@/lib/latex-parser';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowRight, Check, RotateCcw, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

// UI interface for slot with analysis
export interface SlotAnalysis {
    slotName: string;
    originalContent: string;
    suggestedContent: string;
    reasoning: string;
}

interface ResumeEditorProps {
    slots: Slot[];
    suggestions: SlotAnalysis[];
    modifiedSlots: Record<string, string>;
    onUpdateSlot: (slotName: string, newContent: string) => void;
    className?: string;
    // New props for state persistence
    activeTab: string;
    onTabChange: (tab: string) => void;
    editedSuggestions: Record<string, string>;
    onSuggestionChange: (slot: string, value: string) => void;
}

export function ResumeEditor({
    slots,
    suggestions,
    modifiedSlots,
    onUpdateSlot,
    className,
    activeTab,
    onTabChange,
    editedSuggestions,
    onSuggestionChange
}: ResumeEditorProps) {

    // Initialize props if needed (handled by parent now)

    const handleApplySuggestion = (slotName: string) => {
        const suggestionContent = editedSuggestions[slotName] || suggestions.find(s => s.slotName === slotName)?.suggestedContent;
        if (suggestionContent) {
            onUpdateSlot(slotName, suggestionContent);
        }
    };

    const handleRevert = (slotName: string) => {
        const original = slots.find(s => s.name === slotName);
        if (original) {
            onUpdateSlot(slotName, original.originalContent);
        }
    };

    const handleChange = (slotName: string, value: string) => {
        onUpdateSlot(slotName, value);
    };

    const handleSuggestionChange = (slotName: string, value: string) => {
        onSuggestionChange(slotName, value);
    };

    // Fallback if activeTab not set yet
    const currentTab = activeTab || slots[0]?.name || '';
    const activeSlot = slots.find(s => s.name === currentTab);
    const activeSuggestion = suggestions.find(s => s.slotName === currentTab);
    const isModified = activeSlot && modifiedSlots[currentTab] !== activeSlot.originalContent;

    return (
        <div className={cn("flex flex-col h-full bg-surface/60 backdrop-blur-xl border border-white/10 rounded-3xl overflow-hidden shadow-2xl", className)}>

            {/* Header / Tabs */}
            <div className="flex items-center overflow-x-auto p-2 border-b border-white/5 bg-surface">
                {slots.map(slot => (
                    <button
                        key={slot.name}
                        onClick={() => onTabChange(slot.name)}
                        className={cn(
                            "px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap mr-2 cursor-pointer",
                            currentTab === slot.name
                                ? "bg-primary/20 text-primary border border-primary/20"
                                : "text-zinc-400 hover:text-white hover:bg-white/5"
                        )}
                    >
                        {slot.name}
                        {modifiedSlots[slot.name] !== slot.originalContent && (
                            <span className="ml-2 w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
                        )}
                    </button>
                ))}
            </div>

            {/* Content Area */}
            <div className="flex-1 grid lg:grid-cols-2 overflow-hidden">

                {/* Editor Column */}
                <div className="flex flex-col border-b lg:border-b-0 lg:border-r border-white/5 p-6 space-y-4 overflow-y-auto">
                    <div className="flex justify-between items-center text-sm text-zinc-400">
                        <span className="font-semibold text-zinc-200">Current Content</span>
                        <button
                            onClick={() => currentTab && handleRevert(currentTab)}
                            disabled={!isModified}
                            className="flex items-center gap-1 hover:text-white disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                        >
                            <RotateCcw className="w-3 h-3" /> Revert
                        </button>
                    </div>
                    {activeSlot && (
                        <textarea
                            value={modifiedSlots[currentTab] ?? activeSlot.originalContent}
                            onChange={(e) => handleChange(currentTab, e.target.value)}
                            readOnly
                            className="flex-1 w-full bg-surfaceHighlight/30 border border-white/5 rounded-xl p-4 font-mono text-sm text-zinc-300 resize-none cursor-not-allowed opacity-75"
                            spellCheck={false}
                        />
                    )}
                </div>

                {/* AI Suggestion Column */}
                <div className="flex flex-col p-6 space-y-4 overflow-y-auto bg-surface">
                    <div className="flex justify-between items-center text-sm">
                        <span className="font-semibold text-primary flex items-center gap-2">
                            <Sparkles className="w-4 h-4" /> AI Recommendation
                        </span>
                        {activeSuggestion && (
                            <button
                                onClick={() => currentTab && handleApplySuggestion(currentTab)}
                                className="flex items-center gap-1 bg-primary/10 hover:bg-primary/20 text-primary px-3 py-1 rounded-full text-xs font-medium transition-colors border border-primary/20 cursor-pointer"
                            >
                                <Check className="w-3 h-3" /> Apply
                            </button>
                        )}
                    </div>

                    {activeSuggestion ? (
                        <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="space-y-4 flex-1 flex flex-col"
                        >
                            <div className="p-4 bg-primary/5 border border-primary/10 rounded-xl">
                                <p className="text-zinc-300 italic text-sm">"{activeSuggestion.reasoning}"</p>
                            </div>

                            <textarea
                                value={editedSuggestions[currentTab] ?? activeSuggestion.suggestedContent}
                                onChange={(e) => handleSuggestionChange(currentTab, e.target.value)}
                                className="flex-1 w-full bg-surfaceHighlight/30 border border-white/5 rounded-xl p-4 font-mono text-sm text-zinc-400 focus:outline-none focus:border-primary/50 transition-colors resize-none whitespace-pre-wrap"
                                spellCheck={false}
                            />
                        </motion.div>
                    ) : (
                        <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 opacity-50">
                            <Sparkles className="w-12 h-12 mb-4" />
                            <p>No specific suggestions for this section.</p>
                        </div>
                    )}
                </div>

            </div>
        </div>
    );
}
