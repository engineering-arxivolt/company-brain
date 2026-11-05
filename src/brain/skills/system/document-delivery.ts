export const DOCUMENT_DELIVERY_SKILL = {
  id: "system:document-delivery",
  name: "Document Delivery (PDF, resume, cover letter)",
  description:
    "Produce a file the asker can open: compile it in the sandbox, verify the bytes exist, then share it with sandbox_get_artifact and only claim delivery once the tool returns uploaded: true. Tailored CV + cover letter for a job posting run through the deterministic STAR pipeline — the model only writes the chat message.",
  body: `# Document Delivery

## Why this exists
A file that exists in the workspace has NOT been sent. The asker only has it once
sandbox_get_artifact returns uploaded: true for that exact path. Narrating
"both PDFs are here" without that call is the single most common way a document
task fails: the work is real, the delivery never happened.

## Tailored applications (CV + cover letter) — the deterministic pipeline
When the ask is a CV or cover letter adapted to a job posting, the turn ALREADY
runs the deterministic pipeline around you: the base CV is parsed, a tailoring
plan is asked for and sanitised, a keyword-coverage check against the posting
runs (with one automatic redo when the plan under-represents the posting's own
vocabulary), LaTeX is rendered in code, compiled in the sandbox, verified
(pdfinfo/pdftotext), normalised with gs and uploaded. You will see the delivery
context naming the files. Your job in that turn:

- **Write the chat message only.** Name the files, the page counts you were
  given, and what was emphasised for this posting. Do NOT re-render, do not
  compile anything yourself, do not call sandbox tools for this task — a
  hand-written LaTeX CV loses to the pipeline every time.
- **STAR bullets.** STAR = Situation, Task, Action, Result. The pipeline asks
  the tailoring model for cut-down STAR bullets: Situation and Task folded
  into a short opening clause, a strong action verb, and a Result that uses a
  number the base CV actually contains. If you comment on the CV, speak in
  those terms — "led with the outcome", "mirrored the posting's ledgers
  vocabulary" — never suggest inventing facts.
- **Two pages is the ceiling.** The pipeline measures the compiled PDF and
  trims from the least job-relevant material if it exceeds two pages. Do not
  promise one page; report what was delivered.
- **Coverage decides quality.** The plan is scored on how much of the
  posting's own vocabulary (TypeScript, PostgreSQL, ledgers — whatever the
  posting names) appears in the summary, bullets and skill badges. If the
  asker later says "you missed X", treat X as a requirement, check the base CV
  for real supporting facts, have the documents rebuilt, and save the
  correction as part of the base.

## Code-drawn art and animation — the anidoodle pack
When the ask is an illustration, diagram, explainer, poster, loop or short film drawn in code
(the deterministic, free alternative to an image model), use the **anidoodle** pack:
1. import_skills({ pack: "anidoodle" }) — owner/admin only; imports one playbook.
2. sandbox_start({ repoUrl: "https://github.com/alexgreensh/anidoodle" }) to clone the engine,
   then read anidoodle/plugins/anidoodle/skills/anidoodle/SKILL.md for the intake and style list.
3. Scaffold and render with its tools: node tools/scaffold.mjs <name> --format 9x16 --duration 8,
   node tools/still.mjs <name> --frames 24 --sheet sheet.png for a still,
   node tools/render.mjs <name> --out out/<name>.mp4 for a film, node tools/gate.mjs <name> to prove it.
4. Return the rendered files with sandbox_get_artifact, and state the checks you actually ran.
Pick it when the picture should be exact and repeatable: diagrams, type, charts-as-art, explaining a
mechanism in 32 styles. Use an image model when the picture should look photographic or painterly
instead. It needs a browser in the sandbox for the render step — if the image lacks one, say so and
offer the operator the local route rather than claiming a render happened.

## Flow stills and clips — the operator's own credits
Flow is **the** picture maker for this workspace: their own account, their credits, their references and
their characters. Never call another image or video model (no fal, runway, replicate or "generate an
image" tool from a connected app) — those are withheld for this reason, and if one is somehow visible,
say Flow is the route rather than using it.

A request is a Flow job when it asks for a picture in any wording: "make a still of …", "flow clip of …",
"a product shot of this", or any picture attached with a creative instruction ("using the same character
have her holding this bag"). The words "flow" and "image" are not required. Say what is being made
and stop: the job is the answer, and the file lands in the thread in about a minute. Stills cost no
credits; a clip spends them and the job carries its own ceiling.

Continuity: a picture attached with a person in it establishes a **character**, remembered for the
workspace. Later requests that say "her", "him" or "the same character" reuse that character and treat
new pictures as props (the product, the setting), so the face stays the same across a series.

## LaTeX-grade documents — the latex pack
When the ask is a document type beyond the house reports — a thesis, conference paper, poster or
beamer deck, invoice, cheat sheet, exam, multi-language or OCR-to-LaTeX document — use the **latex**
pack: 1. import_skills({ pack: "latex" }) — owner/admin only; imports the playbook. 2. sandbox_start({
repoUrl: "https://github.com/ndpvt-web/latex-document-skill" }) to clone the templates, compile scripts
and reference guides, then work from the cloned directory (its scripts/install_deps.sh covers missing
packages; the sandbox already ships a LaTeX toolchain, so try compiling first). 3. Return compiled PDFs
with sandbox_get_artifact, and state the checks you actually ran. The house report and campaign
pipelines stay the default for research reports and campaign packs — the latex pack is for formats the
house renderer does not have.

## Where the facts come from — the base CV
A CV here is *tailored*, never invented. There is one base CV and every
application is a cut of it aimed at one posting. Find it in this order:
1. **A "<base_cv>" block in your context is the base.** It is put there for this
   turn. Use it directly — do not search memory for it and do not ask for it.
2. **A CV attached in this thread is the base.** Read the attachment
   (PDF/DOCX/text) and treat it like the block. Prefer it over a stale memory if
   the two disagree, and say which one you used.
3. **Otherwise search memory once** — search_company_brain with
   "base CV resume employers roles dates education skills". If it is there, use
   it; if it is not, ask once for the CV or the facts, then save what you get
   with save_memory titled "Base CV — <name>" so the next application starts
   from it.
4. **Keep it current.** When the asker corrects a role, date, or achievement, or
   says "remember this", save the corrected base in that turn (forget the stale
   one if you are replacing it). The base stays adaptive because it is
   maintained, not because it is regenerated from nothing each time.
5. **Tailor, do not fabricate.** Mirror the posting's vocabulary for experience
   the base actually contains; reorder and trim for relevance; drop what the
   posting does not care about. Never add an employer, date, degree, metric or
   skill the base CV and the thread do not support.

## Required sequence (for documents you render yourself)
1. **Write the source** into the sandbox (sandbox_write_file or sandbox_run with a heredoc).
2. **Compile it for real** with latexmk:
   \`cd <dir> && latexmk -pdf -interaction=nonstopmode <file>.tex\`
   Read the exit status and the .log. A run that reports an error has NOT produced a usable PDF.
3. **Prove the PDF exists** — ls -l the .pdf and check the size is non-zero. Do not infer success from a
   previous session: the workspace keeps files, and an old .pdf is not this request's .pdf.
4. **Deliver each file** with sandbox_get_artifact, once per file:
   - omit channel to send it into the current conversation;
   - pass the channel the asker named ("#product-development") when they asked for a specific one.
5. **Read the result.** Report success only for files that returned uploaded: true. If a call returns
   isError, say which file failed and why — never the opposite.

## LaTeX budget in this image
texlive-latex-base, texlive-latex-recommended and texlive-fonts-recommended are installed.
Available and safe: geometry, hyperref, xcolor, lmodern, fontenc, inputenc, booktabs, tabularx,
fancyhdr, ragged2e, parskip, multicol, longtable, graphicx, enumitem is NOT available.
Not available (texlive-latex-extra): titlesec, enumitem, lastpage, fontawesome5, and most
specialised .sty files. If pdflatex says "File \`X.sty' not found", drop X and rebuild that
heading/list with core LaTeX (e.g. \\Large\\bfseries plus \\hrule for a section rule), then recompile.

## Escaping rules that break real compiles
- Every underscore in prose is a math subscript: write TYPE\\_TEXT, not TYPE_TEXT
  ("Missing $ inserted" is the symptom).
- & % # _ outside \\textbf{} etc. need a backslash; use \\% for percentages.
- Do not leave <<PLACEHOLDER>> text in a delivered document.

## Length and quality gate (resume / cover letter)
- Resume: 1-2 pages at 10pt (two is the ceiling the pipeline enforces by
  trimming the least job-relevant material). Cover letter: exactly 1 page, addressed to a named company and role.
- A page count you did not see in the log is a page count you cannot claim.
- State the page count and file size you actually observed, per file.

## Starting skeleton (core LaTeX only, compiles in this image)
Start from this preamble, then fill the body from verified facts about the asker:

\\documentclass[10pt,a4paper]{article}
\\usepackage[utf8]{inputenc}\\usepackage[T1]{fontenc}\\usepackage{lmodern}
\\usepackage[margin=1.6cm]{geometry}\\usepackage{hyperref}\\usepackage{xcolor}
\\definecolor{headingcolor}{RGB}{40,60,90}\\definecolor{rulecolor}{RGB}{180,180,180}
\\hypersetup{colorlinks=true,linkcolor=headingcolor,urlcolor=headingcolor}
\\pagestyle{empty}
\\newcommand{\\cvsection}[1]{\\par\\vspace{8pt}{\\color{headingcolor}\\Large\\bfseries #1}\\par\\vspace{2pt}{\\color{rulecolor}\\hrule height 0.5pt}\\vspace{4pt}}
\\newcommand{\\entry}[4]{\\par\\vspace{4pt}{\\textbf{#1} \\hfill #2}\\par{\\small #3 \\hfill #4}\\par\\vspace{2pt}}
\\begin{document}
% header line, then \\cvsection{Professional Summary} / Experience / Projects / Education / Skills / References
\\end{document}

For a cover letter use margin=2.5cm with \\setlength{\\parindent}{0pt} and \\setlength{\\parskip}{6pt},
a flushright sender block, then the recipient block, salutation, 3-4 paragraphs and a sign-off.

## Job-link intake (when the asker pastes a posting URL)
- Greenhouse, Ashby, Lever, Workable and company careers pages are server-rendered or embed JSON:
  web_extract on the URL is enough, and boards-api.greenhouse.io/v1/boards/<company>/jobs?content=true
  returns clean JSON for Greenhouse.
- LinkedIn, Indeed and logged-in ATS views block automated fetches. Say so and ask the asker to paste the
  job description text, instead of inventing requirements.
- A fetch can land on a LISTING instead of the posting: Fuzu, LinkedIn and other single-page boards load the
  individual job client-side, so the URL returns "Jobs in Kenya" and a wall of cards. If the page you got
  back is an index (title reads like "Jobs in …", or there is no single responsibilities section), do not
  treat it as the posting and do not guess the requirements — ask for the specific job text or a direct
  posting URL, then continue.
- Extract exactly: title, company, location/work mode, required skills, nice-to-haves, visa or relocation
  notes. Mirror the posting's vocabulary for skills the asker actually has. Never invent an employer, date,
  degree or metric that is not in the asker's confirmed history.`,
  version: 5,
  usageCount: 0,
  lastUsedAt: null,
  updatedAt: Date.UTC(2026, 10, 4),
} as const
