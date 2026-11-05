# Base CV — Joseph Mindo

> The base every application is tailored from — never invented per job.
>
> **How it gets into the system:** publish this file to KV for the user, once
> (re-publish whenever it changes):
>
> ```sh
> npx wrangler kv key put --binding=BRAIN_KV \
>   "career_profile:<userId>" --path=templates/cv-base.md --remote
> ```
>
> On the next CV/cover-letter turn the worker copies it into that user's private
> memory as a `career_profile` document (idempotent — a content digest decides
> whether to re-write), where the document-delivery playbook already looks for it.
> No pasting in Slack required.
>
> Facts mirror `resume.tex`; keep the two in sync when either changes.

## Contact

- Location: Nairobi, Kenya
- Email: josephmindo27@gmail.com
- Phone: +254710431513
- LinkedIn: linkedin.com/in/josephmindo
- GitHub: github.com/Mindo-Joseph
- Portfolio: site-joe.vercel.app
- Availability: open to worldwide relocation with visa sponsorship; remote-first

## Professional summary

Versatile Software Engineer with 5 years of experience building scalable
applications with Vue.js, React.js, Node.js/Express, Ruby on Rails, Flutter and
Go. Proven track record in container orchestration, AI app generation and browser
automation. Seeking worldwide remote or visa-sponsored roles in USD/EUR/GBP/CHF
markets where full-stack and AI expertise drive high-impact outcomes.

## Experience

**Engineer — GRIFFIN Global Technologies** (July 2025 – Present)
- Built a bi-directional reconciliation engine that automatically re-aligns nested HTML canvas layout elements on resize.
- Diagnosed and eliminated non-deterministic failures from a race condition between async persistence and synchronous state validation.
- Traced and fixed a silent pricing defect where stale relational data inflated material estimates on customer-facing invoices.
- Hardened authentication session lifecycle across all HTTP clients to guarantee token invalidation on expiry.
- Closed four production risks spanning reliability, spatial accuracy, financial integrity and security on one customer-critical platform.

**Frontend Developer — Nathan Digital** (September 2024 – June 2025)
- Spearheaded a performance overhaul of the main platform by refactoring legacy code, eliminating redundant processes and implementing a more efficient data-fetching strategy — 50% reduction in API calls with a more responsive, stable experience.
- Built and tested frontend deployments in CI/CD, resolving pre-production bugs to enable smoother, more frequent releases.

**Software Developer — LanguaTalk Inc.** (August 2023 – August 2024)
- Drove a significant increase in user engagement (users spending 30+ minutes learning) by designing and implementing an intuitive, user-centric frontend.
- Used Generative AI (ElevenLabs Text-To-Speech, BrowserUse web scraping) to create podcasts and learning materials from news articles.
- Launched a targeted AI-powered marketing campaign for LATAM regions, expanding the platform into new markets.

**Technical Instructor — PowerLearn Project** (June 2022 – July 2023)
- Mentored 50+ aspiring software engineers in mobile technology (Flutter).
- Contributed to an interactive Learning Management System that boosted course completions by 25%.

**Software Developer — AdanianLabs** (June 2022 – July 2023)
- Built USSD applications enabling farmers and rural customers to buy farm products offline via simple mobile phone interactions.
- Built Node.js backend systems for e-commerce in areas with limited internet connectivity.
- Delivered an end-to-end USSD e-commerce platform processing thousands of daily orders, integrating inventory management, payment gateways and logistics coordination.


## Key projects

**Arxivolt Runtime / Miren Platform** (2024 – Present; Go, containerd, etcd)
Container orchestration platform on containerd with strong isolation guarantees,
entity-based architecture and an etcd distributed state store. Built the Forge AI
app-factory layer that generates deployable applications from natural-language
prompts. Multi-tenant projects, HTTP ingress, hot reload, CLI tool, secure
webhook-based deploy pipeline.

**Company Brain** (2024 – Present; TypeScript, Cloudflare Workers, MCP)
Slack-based AI agent on Cloudflare Workers with Durable Objects. Built an MCP
runtime connecting to external servers, an isolated code sandbox for
LaTeX-to-PDF compilation, web search/browse tools, a skill system for process
playbooks, and a scheduler for follow-up reminders. Used for automated job
sourcing, scoring and tailored document generation.

**arxivolt-engine** (2024 – Present; TypeScript, Cloudflare Workers, D1)
Cloudflare Worker source for arxivolt.com and product subdomains. Redirect
resolution with a D1 backend, SEO page clusters and live-script injection;
redirect validation, kill-switch via Worker variables, idempotent D1 migrations.

**Jev Ultrafast** (2024 – Present; Python, TypeSafe, LLM)
Browser agent with a dynamic indexed action space. The LLM selects operations
(CLICK, TYPE_TEXT, SELECT, SCROLL, WAIT, DONE, BLOCKED) against an element table;
demonstrated end-to-end automation (Zürich to London on Google Flights in 7.1
seconds) generating text only where needed, minimising token cost.

**PesaCast** (2024 – Present; Kotlin, Android, Tauri, Rust, React)
M-PESA SMS interception and transaction monitoring. Android app reads incoming
SMS, parses transaction data, and sends it to a desktop app over BLE GATT or
encrypted WiFi WebSocket (ECDH P-256 + HKDF + AES-256-GCM). Open source (MIT),
local-first, no cloud dependency.

## Education

- BSc Computer Science — Laikipia University
- Full-Stack Software Development Bootcamp — Microverse

## Certifications

- AWS Educate — Introduction to Generative AI (March 2025)

## Skills

- **Languages:** TypeScript, JavaScript, Ruby, C#, Dart, Go, HTML, CSS/SASS
- **Frameworks & libraries:** Vue.js, React.js, Node.js (Express), Ruby on Rails, Flutter, Material Design, Tauri, Go
- **Databases:** MongoDB, MySQL, PostgreSQL, etcd, D1, SQLite
- **DevOps & tools:** Git, Jira/Atlassian, CI/CD, Docker, containerd, Agile, Cloudflare Workers, Wrangler
- **AI / emerging:** GenAI, ElevenLabs TTS, BrowserUse, LLM-driven browser agents, TypeSafe Jev, MCP, LaTeX PDF compilation

## References

- Alex Redfern — LanguaTalk Inc. — alexred20@googlemail.com — linkedin.com/in/alex-redfern-2ab9041b
- Don Pottinger — LanguaTalk Inc. — don.pottinger@gmail.com — linkedin.com/in/donpottinger
- Calvin Mwangi — Nathan Digital — munenecalvn@gmail.com — linkedin.com/in/calvin-munene
