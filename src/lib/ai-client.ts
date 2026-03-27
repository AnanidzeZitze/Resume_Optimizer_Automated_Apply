import { GoogleGenerativeAI } from "@google/generative-ai";

export async function generateContent(prompt: string, modelName: string = "gemini-2.0-flash") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set");
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: modelName });

    const result = await model.generateContent(prompt);
    return result.response.text();
}

export async function generateJSON(prompt: string, modelName: string = "gemini-2.0-flash") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set");
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { responseMimeType: "application/json" }
    });

    const result = await model.generateContent(prompt);
    return result.response.text();
}
