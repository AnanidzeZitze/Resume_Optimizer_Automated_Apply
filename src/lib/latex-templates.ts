import { format } from 'date-fns';

export interface CoverLetterParams {
    name: string;
    email: string;
    phone?: string;
    linkedin?: string;
    website?: string;
    address?: string;
    companyName: string;
    body: string;
}

/**
 * Escapes special LaTeX characters.
 */
export function esc(text: string | null | undefined) {
    if (!text) return "";
    return text
        .replace(/\\/g, '\\textbackslash ')
        .replace(/&/g, '\\&')
        .replace(/%/g, '\\%')
        .replace(/\$/g, '\\$')
        .replace(/#/g, '\\#')
        .replace(/_/g, '\\_')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/~/g, '\\textasciitilde ')
        .replace(/\^/g, '\\textasciicircum ');
}

/**
 * Returns a complete LaTeX document for a cover letter using a specific style.
 */
export function getCoverLetterTemplate(params: CoverLetterParams, style: 'classic' | 'modern' = 'classic'): string {
    const { name, email, phone, linkedin, website, address, companyName, body } = params;
    const titleCaseName = name.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    const dateStr = format(new Date(), 'MMMM d, yyyy');

    // Remove existing document structure if present (to avoid nested document)
    const cleanBody = body
        .replace(/\\documentclass[\s\S]*?\\begin\{document\}/, '')
        .replace(/\\end\{document\}/, '')
        .replace(/^```latex\n?/, '')
        .replace(/\n?```$/, '')
        .trim();

    if (style === 'modern') {
        const contactLine = [
            esc(email),
            phone ? esc(phone) : null,
            linkedin ? `\\href{${linkedin}}{LinkedIn}` : null,
            website ? `\\href{${website}}{Website}` : null
        ].filter(Boolean).join(' \\, | \\, ');

        return `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{libertine}
\\usepackage{geometry}
\\geometry{a4paper, top=0.8in, bottom=0.8in, left=0.9in, right=0.9in}
\\usepackage{xcolor}
\\definecolor{accent}{HTML}{2563EB}
\\usepackage[hidelinks]{hyperref}
\\hypersetup{colorlinks=true, urlcolor=accent, linkcolor=accent}
\\usepackage{parskip}
\\setlength{\\parskip}{6pt}

\\begin{document}
\\pagestyle{empty}

{\\Huge \\textbf{\\color{accent}${esc(name)}}} \\\\[10pt]
{\\small ${contactLine}}

\\vspace{30pt}

${dateStr}

\\vspace{20pt}

\\textbf{To the Hiring Manager at ${esc(companyName)}},

\\vspace{10pt}

${cleanBody}

\\vspace{30pt}

\\textbf{Sincerely,} \\\\
\\textbf{${esc(titleCaseName)}}

\\end{document}
`;
    }

    // Classic style — name on first line, all contact info on one second line
    const sep = ' \\, {\\color{accent}$|$} \\, ';
    const linkedinHref = linkedin ? `\\href{${linkedin}}{LinkedIn}` : '';
    const websiteHref  = website  ? `\\href{${website}}{Website}`   : '';
    const contactRow   = [
        address ? esc(address) : '',
        phone   ? esc(phone)   : '',
        linkedinHref,
        websiteHref,
    ].filter(Boolean).join(sep);

    const headerRows = [
        `{\\huge \\textbf{${esc(name)}}}`,
        contactRow ? `{\\small ${contactRow}}` : '',
    ].filter(Boolean).join(' \\\\\n    ');

    return `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{mathpazo}        % Palatino — professional, elegant serif
\\usepackage{microtype}
\\usepackage[hyphens]{url}
\\usepackage{geometry}
\\geometry{a4paper, top=1.75cm, bottom=1.75cm, left=1.75cm, right=1.75cm}
\\usepackage{parskip}
\\setlength{\\parskip}{5pt}
\\setlength{\\emergencystretch}{10em} % prevent text overflowing margins
\\usepackage{xcolor}
\\definecolor{accent}{RGB}{30, 80, 160}
\\usepackage[hidelinks]{hyperref}
\\hypersetup{colorlinks=true, urlcolor=accent, linkcolor=accent}
\\usepackage{lastpage}

\\begin{document}
\\pagestyle{empty}
\\sloppy

\\begin{center}
    ${headerRows}
\\end{center}

\\vspace{-4pt}
{\\color{accent}\\rule{\\linewidth}{0.6pt}}
\\vspace{8pt}

${dateStr}

\\bigskip

To the Hiring Manager at \\textbf{${esc(companyName)}},

\\vspace{8pt}

${cleanBody}

\\bigskip

Sincerely, \\\\[0pt]
\\textbf{${esc(titleCaseName)}}

\\end{document}
`;
}
