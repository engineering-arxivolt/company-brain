export const CAREER_OPS_FIT_SKILL = {
  id: "system:career-ops-fit",
  name: "Career Ops Fit Scoring",
  description:
    "Score job postings 1-to-5 for fit before investing time; auto-reject below 3, only surface 4+.",
  body: `# Career Ops Fit Scoring Rubric

## Purpose
Score every job posting 1-to-5 before the candidate invests time. Only surface postings scoring 4+; auto-reject 1-2 with a one-line reason. Never present a raw posting without a score.

## Scoring criteria (1-5)

| Score | Fit | Rule |
|-------|-----|------|
| 5 | Excellent | Role matches target title/seniority, skills overlap ≥70%, location/work-mode match, company stage/sector matches, compensation in range. |
| 4 | Strong | Meets most criteria with one minor gap (e.g., one missing skill, slightly off location). Worth applying. |
| 3 | Marginal | Partial match but meaningful gaps (e.g., wrong seniority, missing key skill, wrong work mode). Skip unless nothing better exists. |
| 2 | Weak | Several gaps; only tangential relevance. Do not apply. |
| 1 | Poor | Clear mismatch — wrong function, wrong seniority, non-remote when remote-only, etc. Auto-reject. |

## Auto-reject rules (score 1-2, do not surface)
- Title/seniority clearly outside target (e.g., IC applying to manager-only, entry-level applying to Staff+)
- Work mode explicitly on-site when candidate is remote-only
- Location not in target regions and no relocation/remote option
- Required skill the candidate explicitly does not have (not "nice to have")
- Compensation band (if listed) below minimum

## What to check for each posting
1. **Title & seniority** — does it match the candidate's target?
2. **Skills** — required vs nice-to-have; count overlaps with candidate's stack
3. **Location / work mode** — remote, hybrid, on-site; target regions
4. **Company** — stage, sector, size; any known red flags from memory
5. **Compensation** — listed band vs candidate's minimum
6. **Ghost job check** — posting age, whether the check-jobs-open tool confirms it is still open

## Output format
When scoring a posting, always output:
1. Score (1-5)
2. One-line rationale citing evidence from the posting
3. Verdict: APPLY / SKIP / HOLD
4. If 4+: suggest tailoring points for resume/cover letter

## Evidence rule
Score only from the posting's actual text and verified company data. Do not infer requirements not stated. If the posting lacks enough info to score, mark it HOLD and note what's missing.` as const,
  version: 1,
  usageCount: 0,
  lastUsedAt: null,
  updatedAt: Date.UTC(2026, 7, 10),
} as const