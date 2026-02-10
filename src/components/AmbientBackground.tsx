'use client';

export const AmbientBackground = () => (
    <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10 bg-background">
        <div className="absolute top-[-10%] left-[-10%] w-[50vw] h-[50vw] bg-red-600/20 rounded-full blur-[120px] animate-pulse-glow" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[50vwdiv] h-[50vw] bg-red-900/10 rounded-full blur-[120px] animate-pulse-glow delay-1000" />
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 brightness-100 contrast-150 mix-blend-overlay"></div>
    </div>
);
