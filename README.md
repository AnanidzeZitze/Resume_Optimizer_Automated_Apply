# Resume AI Optimizer

A Next.js application that optimizes your LaTeX resume using Google Gemini AI and generates a tailored cover letter.

## Features
- **Resume Optimization**: Analyzes your resume against a job description and suggests improvements using Google Gemini AI.
- **Cover Letter Generation**: Creates a Harvard-style cover letter in PDF format, tailored to the specific job and company.
- **Unified Workspace**: Edit both documents side-by-side with real-time feedback.
- **Smart Formatting**: Handles LaTeX syntax, bolding, and list structures automatically.
- **Privacy Focused**: Your data stays local until you explicitly hit analyze.

## Prerequisites
- Node.js (v18 or newer)
- npm or yarn
- A Google Gemini API Key
- **LaTeX Distribution**: You must have `pdflatex` installed and accessible in your system PATH.
  - **Mac**: `brew install mactex` (or BasicTeX)
  - **Windows**: MiKTeX or TeX Live
  - **Linux**: `sudo apt-get install texlive-latex-base texlive-fonts-recommended texlive-latex-extra`

## Setup & Installation

1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/your-username/resume-ai-optimizer.git
    cd resume-ai-optimizer
    ```

2.  **Install Dependencies**:
    ```bash
    npm install
    # or
    yarn install
    ```

3.  **Environment Setup**:
    Create a `.env.local` file in the root directory and add your API key:
    ```bash
    GEMINI_API_KEY=your_api_key_here
    ```

## 🚀 How to Use

### 1. Prepare Your Resume (`.tex`)
**CRITICAL**: You must mark up your LaTeX resume so the AI knows which parts to edit. Wrap the sections you want optimized with `SLOT` comments.

**Example:**
```latex
% SLOT: Professional Summary
\section{Summary}
Experienced software engineer with 5+ years of...
% END_SLOT

% SLOT: Experience 1
\textbf{Senior Developer} \hfill 2020--Present\\
\textit{Tech Corp}
\begin{itemize}
    \item Led team of 5 developers...
    \item Improved performance by 30\%...
\end{itemize}
% END_SLOT
```
*Note: The AI will ONLY see and optimize content between `% SLOT: Name` and `% END_SLOT` markers. Everything else (headers, contact info, formatting boilerplate) remains untouched.*

### 2. Run the Application
Start the development server:
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

### 3. Workflow
1.  **Upload**: Upload your marked-up `.tex` file.
2.  **Job Description**: Paste the job description you are applying for.
3.  **Analyze**: Click "Start Optimization".
    - The AI analyzes your resume against the JD.
    - It generates a tailored Cover Letter draft.
4.  **Workspace**:
    - **Resume Tab**: Review AI suggestions for each slot. Accept, edit, or revert changes.
    - **Cover Letter Tab**: Review/Edit the generated cover letter.
5.  **Finalize**: Click "Finalize & Download" to compile both documents into PDFs.

## Troubleshooting
- **LaTeX Errors**: If compilation fails, check the server console for logs. Ensure you aren't using unsupported packages.
- **Formatting Issues**: The AI tries to maintain your LaTeX structure, but complex nested environments might need manual adjustment.
- **API Errors**: Ensure your Gemini API key is valid and has quota.

## Tech Stack
- **Framework**: Next.js 14
- **Styling**: Tailwind CSS
- **AI**: Google Generative AI (Gemini Flash 1.5)
- **PDF Processing**: `pdflatex` (server-side), `pdfjs-dist`
- **Icons**: Lucide React
- **Animations**: Framer Motion
