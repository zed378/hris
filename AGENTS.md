# AGENTS.md

Instructions for any AI coding agent (Claude Code, Codex, Cursor, Kilo Code, or otherwise) working in this repository. Follows the [agents.md](https://agents.md) convention and must stay consistent with [`CLAUDE.md`](CLAUDE.md) — **if you update one, update the other.**

## Project Summary

**HRMS** is a multi-tenant HR management suite for Indonesian SMEs — employees, attendance with location and photo evidence, leave, and a payroll framework — delivered as a PWA. It is a modular monolith (pnpm + Turborepo): `apps/web` (Next.js 16: pages and every API route), `apps/worker` (background jobs), `apps/auth` (auth service, built but not enabled — authorization stays in-process, ADR-032), domain logic in `packages/core`, one PostgreSQL 18 database with forced row-level security.

The engineering, security, and design reference lives in **`docs/`** ([`docs/README.md`](docs/README.md)). What remains to be done is in **`TASKS/`**; what was done and why is in **`MEMORY/`**. Look things up there rather than re-deriving them.

## Setup Commands

Prerequisites: Node ≥ 24, pnpm 11, Docker.

```bash
cp .env.example .env              # development values pre-filled
pnpm install
pnpm db:up                        # PostgreSQL 18 (port 5433) and Redis
pnpm db:migrate                   # Prisma migrations, then online migrations
pnpm db:seed                      # demo tenant and superuser; prints the TOTP secret

pnpm --filter @hrms/web dev       # web and API on :3000
pnpm --filter @hrms/worker dev    # outbox pump and jobs
```

Demo tenant: `demo` / `owner@demo.test` / `DemoPassword123`. Demo superuser: `admin@hrms.test` / `AdminPassword123` with TOTP (`pnpm dev:totp <secret>`).

NATS for the broker tests: `docker run -d --name hrms-nats -p 4222:4222 nats:alpine -js`.

## Build and Test Commands

```bash
pnpm verify                              # lint:migrations → lint → typecheck, test, build
pnpm lint:migrations                     # refuses destructive migrations
pnpm lint                                # includes module boundary rules
pnpm --filter @hrms/core test            # one package
pnpm --filter @hrms/web test             # gateway, manifest, menu, boundary, service worker
pnpm --filter @hrms/auth-service test    # auth service over real HTTP
pnpm --filter @hrms/db test              # tenant isolation, RLS coverage, online migrations
pnpm db:migrate:online                   # CONCURRENTLY migrations only
docker compose -f ops/docker-compose.yml up --build                          # full stack
docker compose -f ops/docker-compose.yml --profile split --profile broker up # split + NATS
```

Do not use `pnpm ci` — that is pnpm's clean-install command. There is **no CI pipeline yet** (`TASKS` `P0-09`); `pnpm verify` runs only when you run it.

## Where to Find the Spec for Any Task

| Task area | Document |
|---|---|
| What to do next | `TASKS/PROGRESS.md` → the phase file's task card |
| Principles P1–P16 | `docs/PLAN/00` §3.2 |
| Architecture as built, phases, gates | `docs/PLAN/12` |
| Implementation status, silent bugs found | `docs/PLAN/13` |
| Auth service, tokens, Redis, broker | `docs/PLAN/14` (the split stops at stage 5 in use — ADR-032) |
| Data model | `docs/PLAN/02`; `packages/db/prisma/schema.prisma` |
| Permissions and menus | `docs/PLAN/05` |
| Multitenancy and authentication | `docs/PLAN/06` |
| Migrations | `docs/PLAN/09` |
| Attendance evidence | `docs/PLAN/10` |
| PWA and offline | `docs/PLAN/11` |
| API contract, error codes | `docs/PLAN/15` |
| Testing rules | `docs/PLAN/16` |
| Security controls and gaps | `docs/PLAN/17` |
| Performance, observability, deployment | `docs/PLAN/18`, `19`, `20`; `ops/RUNBOOK.md` |
| Acceptance criteria, risks | `docs/PLAN/21`, `22` |
| Feature spec template | `docs/PLAN/23` |
| Threat model | `docs/SECURITY/00`–`05` — **`02` is mandatory for security-sensitive work** |
| Screens | `docs/UI-UX/00`–`14` |
| Open questions, deviations | `TASKS/BACKLOG.md` |
| Past decisions | `MEMORY/DECISIONS.md` |

## Feature Workflow

1. Take a task from `TASKS/PROGRESS.md`; read its *Plan refs*.
2. If *Spec required: Yes*, write `MEMORY/specs/<task-id>-<slug>.md` from `docs/PLAN/23` first.
3. Write abuse-case tests from `docs/SECURITY/02` through the real request path; see them fail.
4. Implement against the task DoD and the global DoD in `TASKS/00-TASK-CONVENTIONS.md` §4.
5. Correct documents the change makes false; add a `MEMORY/` record, index line, changelog entry, and an ADR if needed; update `TASKS/PROGRESS.md`.

## Code Style

- TypeScript throughout; ESLint with `eslint-plugin-boundaries` — cross-module imports only through a module's `index.ts`.
- Domain logic in `packages/core`, framework-free. Route handlers stay thin.
- Request bodies validated with Zod before use. Errors use the envelope and codes in `packages/contracts/src/errors.ts`.
- Raw SQL only through tagged templates (`$queryRaw\`…\``), never string-built.
- `packages/observability` logger only — `no-console` outside tests and scripts.
- Comments explain **why**, at the depth the existing code does. Never claim in a comment a test or guard that does not exist.
- Code, comments, and docs in English; user-facing strings in Indonesian.
- Tailwind utility classes; follow `docs/UI-UX/05` and `06`.

## Hard Rules (Do Not Violate)

1. **Tenant data only through `withTenant()`.** No `BYPASSRLS`, no runtime role owning tables, no new RLS exception without justification in the migration and `rls-coverage.test.ts`.
2. **New `tenant_id` tables**: RLS enabled and forced, a policy, composite tenant foreign keys.
3. **Every route in `ROUTE_MANIFEST`** with module and permission, through the right wrapper. Never mix the tenant and admin guards.
4. **Backend refuses what the frontend hides.** `402` before `403`.
5. **Pages never import server packages**, route handlers, or the manifest.
6. **Migrations are additive.** No `DROP`, `RENAME`, `TRUNCATE`.
7. **History is never overwritten**; audit logs are append-only.
8. **Evidence is scored, never auto-rejected**; no coordinates on team views; only punches are written offline; nothing sensitive cached on the device.
9. **Never log** PII, passwords, tokens, or coordinates; never label metrics by tenant, user, or email.
10. **No statutory payroll work before Gate C; no Phase 7+ module before Gate D.**
11. **No hand-written API reference** — manifest plus `openapi.ts` `DOCS`.
12. **Backend English, frontend Indonesian** (ADR-030). API responses, error and validation messages, logs, and debug output are English. The frontend shows only its own Indonesian text — never a server `message`. Seeded display data stays Indonesian. Emails and push notifications are Indonesian (ADR-034).
13. **No security-sensitive task is done without an abuse-case test seen to fail.**
14. **Never loosen a guard to pass a build.**
15. **`docs/` changes deliberately** — through the deviation protocol, or to correct a current-state statement your change makes false.
16. **Tests use real services — no mocked data layers.** If a real-service test is impossible, skip it, mark it, and record why in `docs/PLAN/13`.
17. **Stage commits by explicit path — never `git add -A` or `git add .`** Check `git status` and `git log` for other agents' changes and leave them out. One agent per working tree.

## PR and Change Instructions

- Branch: `feat|fix|chore/<task-id>-<slug>`. Commit subject: `<task-id>: <what>`.
- The body states: the task ID, the plan sections implemented, the tests added and whether each was seen to fail, whether `pnpm verify` ran (locally or in CI), and any deviation with its ADR.
- One task per PR where possible. Include the `MEMORY/` record and `TASKS/` updates in the same PR.
- A change touching `packages/db/prisma/migrations`, `route-manifest.ts`, `eslint.config.js`, `define-*route.ts`, `packages/core/src/auth`, `packages/core/src/iam`, or any test assertion's strictness needs explicit review.

## When Uncertain

Check `docs/`, `TASKS/BACKLOG.md`, `MEMORY/DECISIONS.md`, and the code comments. If the answer is not there, add an open question to `TASKS/BACKLOG.md` with a recommendation and ask — do not invent an architectural decision. Never report something as verified that was not.

<!-- RTK_TOKEN_SAVER_START -->
# RTK Token Saver Rule (agents)

## RTK (Rust Token Killer) Optimization Rule
Prefix every shell/terminal execution command with `rtk`:
- `rtk git status`, `rtk git diff`, `rtk git log -n 5`
- `rtk npm test`, `rtk npm run build`, `rtk pnpm test`, `rtk yarn test`
- `rtk cargo check`, `rtk cargo test`, `rtk cargo build`
- `rtk pytest`, `rtk vitest`
- `rtk ls src/`, `rtk tree -L 2`, `rtk rg "pattern"`

Keep the prefix inside chains: `rtk git add . && rtk git commit -m "msg"`.
Commands RTK has no filter for run as-is, so the prefix is always safe.

### Output & Token Optimization
Command output is condensed to save 60-90% LLM context window tokens while preserving every critical signal, error, and exit code.
- `rtk gain` / `rtk gain --history` - View token savings scoreboard.
- `rtk proxy <cmd>` - Run a command unfiltered if raw output is strictly needed.
- `RTK_DISABLED=1 <cmd>` - Skip RTK for one command.

## 3-Tier Hybrid Web Research & Scraping Policy (Upstream: fastcrw/crw & lightpanda-io/browser)
When your IDE agent receives a task requiring web research or extraction, it follows this strict 3-tier routing logic:

1. **Discovery (Tier 1 - Default Search)**:
   - The agent uses its built-in search tool (`search_web` / native search) to find target URLs or documentation links.
2. **Fast Extraction (Tier 2 - fastCRW)**:
   - The agent attempts to fetch the URL using fastCRW (`crw scrape <url>`, `crw_scrape`, or `http://127.0.0.1:3000`).
   - If the page is server-rendered (like a blog, GitHub README, or docs site), fastCRW instantly grabs clean Markdown/text, saving 70-90% context tokens without JS engine overhead.
3. **Deep Dynamic Rendering (Tier 3 - Lightpanda Local via MCP)**:
   - If fastCRW returns empty content, a rendering error, or hits a client-side JavaScript wall (e.g., a React/Vue SPA app or login-gated dashboard), the agent automatically falls back to Lightpanda Local via MCP (`lightpanda mcp`).
   - Lightpanda executes the JS via V8 and feeds a clean Accessibility Tree or Markdown back into the IDE context window using ~10x less memory than headless Chrome.


## Mandatory Semantic Knowledge Graph First Policy (Token Saver Enforcement)
Autonomous AI agents in ANY IDE MUST ALWAYS query the pre-indexed semantic knowledge graphs to provide answers BEFORE falling back to raw file reads that waste prompt tokens:

### 1. Code-Based Files -> CodeGraphContext (Upstream: CodeGraphContext/CodeGraphContext)
- **Code Query Engine:** For all code architecture, symbol definitions, function signatures, call hierarchies (callers/callees), class inheritance, and module dependencies, AI agents MUST query the CodeGraphContext index (/codegraph-query, `cgc query`, `cgc find`, or CodeGraphContext MCP tools) FIRST.
- **Zero-Waste Fallback:** NEVER dump or read entire source code files or directory trees into LLM prompt context when answering code questions. Only fall back to localized file reads (and then only targeted slices) if the knowledge graph query does not provide sufficient detail.
- **Live Synchronization:** The project code graph is continuously kept updated via background incremental sync / `cgc watch` / on-save triggers.

### 2. Non-Code Files -> JevGraph (Upstream: chenmingtang830/jevgraph)
- **Document Query Engine ONLY:** JevGraph is strictly designated for non-code files (documentation, Markdown specs, PRDs, PDFs, Word docs `.docx`, slides `.pptx`, text `.txt`).
- **Bounded Evidence:** When ingesting large specs, PRDs, PDFs, or architectural documentation, build or query bounded evidence-backed knowledge graphs (/jevgraph-build, /jevgraph-query) with character-level page maps instead of loading raw long documents into prompt context.
- **Strict Separation:** NEVER use JevGraph for source code AST indexing; code files are strictly handled by CodeGraphContext.


## Headroom Context Compression (Upstream: headroomlabs-ai/headroom)
- Utilize Headroom context compression and Compress-Cache-Retrieve (CCR) for heavy JSON structures, file reads, and tool payloads to minimize prompt tokens.


## Anti-Slop Filter & Quality Rules (Upstream: miqdadbadjuber/anti-slop)
Follow Anti-Slop rules to prevent generic AI slop in generated UI, copy, and code comments (Mode: DURING):
- **Filter, Not Style Guide:** Run purpose tests before aesthetic choices (reject ungrounded neon glows, fake metrics, generic sparkle badges).
- **Liveliness & Grounding:** Rely on `DESIGN.md` or explicit brief for design soul; enforce WCAG AA human accessibility.
- **Dedicated Skills:** Read `skills/antislop/SKILL.md` (core), `skills/antislop-ui/SKILL.md`, `skills/antislop-copywriting/SKILL.md`, `skills/antislop-human/SKILL.md`, `skills/antislop-layoutmobile/SKILL.md`, `skills/antislop-code/SKILL.md` when performing relevant tasks.


## Output & Generation Token Saver Rule (Ponytail Mode: FULL)
- **YAGNI & Shortest Diff:** Only write code that must exist. Reach for standard library before custom code or new dependencies. Shortest working diff wins.
- **Terse Responses:** Code first. At most 3 short lines of explanation: what was skipped, when to add it. No essays, no unsolicited design tours, no feature walkthroughs.

## Terse Agent Directives
- Eliminate pleasantries, greetings, and conversational filler. Provide direct answers and actionable code.
- Avoid reprinting unchanged code blocks. Use targeted search/replace blocks or concise snippets.

## Context Optimization (Compact Diffs & Outlines)
- Inspect git changes using compact single-line diffs: `rtk git diff -U1` instead of wide multi-line context.
- When exploring codebases, inspect function signatures / AST outlines (/rtk-outline) before reading entire files into context.

## ECC Context Management & Compaction Protocol (Upstream: affaan-m/ECC)
Autonomous AI agents MUST actively manage conversation context window load to prevent token bloat and degraded reasoning:
1. **Strategic Compaction at Milestones:** At major phase completions or after 50+ tool calls, invoke strategic compaction (/strategic-compact) to summarize completed steps, pruned raw outputs, and focus active memory strictly on pending requirements.
2. **Context Keeper (`ck`) Snapshots:** Before major context purges, architectural refactors, or switching tasks, persist durable checkpoint files (`.agents/ck/context.json` and `.agents/ck/CONTEXT.md` or invoke /ck:save) so state is never lost across conversation boundaries.
3. **Anti-Loop Council & Agent Evaluation:** If stuck in repeated failed edits, build verification errors, or circular debug loops (>3 failed attempts), invoke /council or /agent-evaluator to obtain root-cause guidance and stop wasting tokens on trial-and-error repetition.

## Upstream Engine Integration & Latency Guardrails Standards
Whenever a new upstream engine or external tool (e.g. `fastcrw/crw`, `CodeGraphContext`, `JevGraph`) is introduced or updated:
1. **Holistic Dashboard Integration (8 Surfaces Required)**:
   - Header action toggle button (`Turn <Tool> ON / OFF`)
   - Setup alert banner (missing chips + AI install prompt generator)
   - Dedicated dashboard section & Quick Action triggers
   - Multi-channel savings breakdown navigation tabs & distribution weights
   - System Health diagnostics row with status, AI install prompt, sync, and uninstall actions
   - Upstream versions dropdown listing
   - Upstream Sync Picker (`showSyncPicker`) and Uninstall Picker (`showUninstallPicker`)
   - Footer upstream reference links
2. **Zero-Noise Latency Benchmarks**: "Test Upstream Latencies" must selectively ping and display only **installed** upstream components, silently omitting/ignoring uninstalled tools so users never see failed pings or clutter for optional tools.
3. **Footer Version Number Invariant**: The current plugin release version must always be presented beside "Token Saver" in front of "• GitHub".

<!-- RTK_TOKEN_SAVER_END -->
