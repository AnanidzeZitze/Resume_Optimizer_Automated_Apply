'use client';
import React, { useCallback, useState } from 'react';
import { Upload, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence } from 'framer-motion';

interface FileUploadProps {
    onFileSelect: (file: File) => void;
    selectedFile: File | null;
    label?: string;
    accept?: Record<string, string[]>; // Kept for compatibility
    className?: string;
    acceptText?: string;
}

export const FileUpload: React.FC<FileUploadProps> = ({
    onFileSelect,
    selectedFile,
    className,
    label = "Drop your resume here",
    acceptText = "Accepts .tex files"
}) => {
    const [isDragging, setIsDragging] = useState(false);

    const handleDrag = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === 'dragenter' || e.type === 'dragover') setIsDragging(true);
        else if (e.type === 'dragleave') setIsDragging(false);
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            onFileSelect(e.dataTransfer.files[0]);
        }
    }, [onFileSelect]);

    return (
        <div
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            className={cn(
                "relative group cursor-pointer transition-all duration-300 ease-out border-2 border-dashed rounded-2xl h-64 flex flex-col items-center justify-center overflow-hidden bg-surface/50 backdrop-blur-sm",
                isDragging ? "border-primary bg-primary/10 scale-[1.02]" : "border-surfaceHighlight hover:border-surfaceHighlight/80 hover:bg-surfaceHighlight/30",
                selectedFile ? "border-green-500/50 bg-green-500/5" : "",
                className
            )}
        >
            <input
                type="file"
                className="absolute inset-0 opacity-0 cursor-pointer z-10"
                onChange={(e) => e.target.files && onFileSelect(e.target.files[0])}
            />

            <AnimatePresence mode="wait">
                {selectedFile ? (
                    <motion.div
                        key="file-selected"
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.8, opacity: 0 }}
                        className="flex flex-col items-center text-center p-6 space-y-4"
                    >
                        <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center text-green-400">
                            <CheckCircle2 className="w-8 h-8" />
                        </div>
                        <div>
                            <h3 className="text-lg font-semibold text-zinc-100">{selectedFile.name}</h3>
                            <p className="text-sm text-zinc-400">{(selectedFile.size / 1024).toFixed(2)} KB</p>
                        </div>
                    </motion.div>
                ) : (
                    <motion.div
                        key="upload-prompt"
                        initial={{ scale: 0.8, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.8, opacity: 0 }}
                        className="flex flex-col items-center text-center p-6 space-y-4"
                    >
                        <div className="w-16 h-16 rounded-full bg-surfaceHighlight flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                            <Upload className="w-6 h-6 text-zinc-400 group-hover:text-primary" />
                        </div>
                        <div>
                            <h3 className="text-lg font-semibold text-zinc-100 group-hover:text-primary transition-colors">
                                {label}
                            </h3>
                            <p className="text-sm text-zinc-500 mt-1">{acceptText}</p>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};
