import type { Config } from "tailwindcss";

const config: Config = {
    content: [
        "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
        "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    theme: {
        extend: {
            colors: {
                background: "#000000",
                surface: "#18181b",
                surfaceHighlight: "#27272a",
                primary: "#DC2626",    // Red-600 (Bold Red)
                secondary: "#991B1B",  // Red-800 (Darker Red)
            },
            animation: {
                "spin-slow": "spin 3s linear infinite",
                "pulse-glow": "pulse-glow 4s ease-in-out infinite",
            },
            keyframes: {
                "pulse-glow": {
                    "0%, 100%": { opacity: "0.4", transform: "scale(1)" },
                    "50%": { opacity: "0.8", transform: "scale(1.1)" },
                },
            },
        },
    },
    plugins: [],
};
export default config;
