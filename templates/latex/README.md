# LaTeX Templates — Joseph Mindo (Kenya → Worldwide Remote / Visa-Sponsored Roles)

Two ATS-friendly templates personalized with Joseph's actual 5-year engineering background:

- `resume.tex` — Clean, single-column CV (A4, no photo) with Joseph's real experience at GRIFFIN Global Technologies, Nathan Digital, LanguaTalk Inc, PowerLearn Project, and AdanianLabs
- `cover-letter.tex` — Professional cover letter with relocation/visa paragraph

## Design choices (safe for international ATS + visa applications)

| Choice | Reason |
|---|---|
| **No photo** | US/UK/Canada employers don't want photos; avoids bias and ATS parsing issues |
| **Single column** | Multi-column layouts break many ATS parsers |
| **Standard fonts** (`lmodern`) | Available in every LaTeX installation; renders consistently |
| **A4 paper** | International standard; change to `letterpaper` for US-only applications |
| **No tables/graphics** | ATS parsers extract text; tables and images can scramble order |
| **Subtle colors only** | Grayscale-safe; prints and scans cleanly |
| **Visa/relocation flagged upfront** | Header states "Open to relocation worldwide · Visa sponsorship welcome · Remote-first" |
| **Higher-currency focus** | Professional Summary explicitly targets USD/EUR/GBP/CHF markets |

## How we know they compile

1. **texlive is pre-installed in the company-brain sandbox** (`sandbox/Dockerfile` includes `texlive-latex-base`, `texlive-latex-recommended`, `texlive-fonts-recommended`, `latexmk`).
2. **Compile test:** Run `./compile-test.sh` inside a sandbox session. Both should produce `.pdf` files with no errors.
3. **Placeholder validation:** `<<...>>` fields in the cover letter are per-job customization points the AI fills in before compiling.

## Using from company-brain

The AI can:

1. Start a sandbox session
2. Copy `templates/latex/resume.tex` and `templates/latex/cover-letter.tex` into the workspace
3. Replace `<<...>>` placeholders in the cover letter with the target company/job details
4. Run `latexmk -pdf resume.tex` and `latexmk -pdf cover-letter.tex` to compile
5. Pull the resulting `.pdf` files as sandbox artifacts and upload them to Slack

## Per-application tailoring (what the AI changes each time)

| Field | Source |
|---|---|
| `<<HIRING MANAGER NAME>>` | Job posting / company research |
| `<<COMPANY NAME>>` | Job posting |
| `<<JOB TITLE>>` | Job posting |
| `<<COMPANY MISSION OR PRODUCT>>` | `context.dev` company research + website |
| `<<KEY ACHIEVEMENT>>` | Matched from Joseph's resume to the job's requirements |
| `<<SPECIFIC REQUIREMENT>>` | From the job description |
| `<<REASON>>` | `context.dev` research on the company |

## Compile test script

`compile-test.sh` runs `latexmk -pdf` on both templates and checks the `.log` files for errors.

