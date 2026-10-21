# CLAUDE.md

Guidance for Claude Code working in this repository. [`AGENTS.md`](AGENTS.md) carries the same rules for any agent — **if you change one, change the other.**

## What This Repository Is

**HRMS** — a multi-tenant HR management suite for Indonesian SMEs: employees, attendance with location and photo evidence, leave, and a payroll framework, delivered as a PWA. A pnpm + Turborepo modular monolith (`apps/web` Next.js, `apps/worker`, `apps/auth` built but not enabled; domain logic in `packages/core`) on one PostgreSQL 18 database with forced row-level security.

Most of the plan is already built. The documents are the reference; [`TASKS/`](TASKS/) says what is left; [`MEMORY/`](MEMORY/) says what was done and why.

## Documentation Map — Read Before You Build

Start at [`docs/README.md`](docs/README.md). Then, by task:

| If you are working on… | Read first |
|---|---|
| Anything — what to do next | `TASKS/PROGRESS.md` (Next Up), then the task's card |
| The product, principles P1–P16 | `docs/PLAN/00` §3.2 |
| Architecture as built, phases, gates | `docs/PLAN/12` (wins over `01` and `04` where they disagree) |
| What is proven, divergences, silent bugs found | `docs/PLAN/13` |
| Auth service, Redis, broker, tokens, the split | `docs/PLAN/14` — the split stops at stage 5 in use (ADR-032) |
| Data model | `docs/PLAN/02`, then `packages/db/prisma/schema.prisma` |
| Roles, permissions, menus | `docs/PLAN/05` |
| Tenancy and authentication | `docs/PLAN/06`, `docs/PLAN/17` §1–2 |
| Migrations | `docs/PLAN/09` |
| Attendance evidence, geolocation, photos | `docs/PLAN/10` |
| PWA, service worker, offline queue | `docs/PLAN/11` |
| An endpoint | `docs/PLAN/15` (contract), `apps/web/src/lib/route-manifest.ts` |
| Tests | `docs/PLAN/16` |
| Security controls and gaps | `docs/PLAN/17`, then `docs/SECURITY/02` |
| Performance, observability, deployment | `docs/PLAN/18`, `19`, `20`, `ops/RUNBOOK.md` |
| Whether something is done | `docs/PLAN/21` |
| Risks | `docs/PLAN/22` |
| A new feature | `docs/PLAN/23` (spec template) |
| Auth, authorization, tenancy, PII, attendance evidence | **`docs/SECURITY/02`** — mandatory |
| A screen | `docs/UI-UX/00`, then `07` (pages), `09` (mobile), `11` (states), `13` (copy), `14` (acceptance) |
| An open question or known deviation | `TASKS/BACKLOG.md` |
| Why something is the way it is | `MEMORY/DECISIONS.md`, then the code comment — comments here explain *why* at length |

## Mandatory Workflow

1. **Pick a task** from `TASKS/PROGRESS.md`. Read every document in its *Plan refs* for this task.
2. **Write a spec** in `MEMORY/specs/<task-id>-<slug>.md` from `docs/PLAN/23` when the card says *Spec required: Yes* — anything touching authentication, authorization, tenant isolation, personal data, attendance evidence, payroll or money, or the data model (`TASKS/00-TASK-CONVENTIONS.md` §5).
3. **Write the abuse-case tests first** from `docs/SECURITY/02`, through the real request path, and see them fail.
4. **Implement** against the card's DoD and the global DoD (`TASKS/00-TASK-CONVENTIONS.md` §4).
5. **Correct any document the change makes false** — `docs/PLAN/13`, `docs/PLAN/22`, `docs/SECURITY/02` statuses — in the same commit.
6. **Record** in `MEMORY/`: a record, an index line, a changelog entry, an ADR for any decision or deviation.
7. **Update** `TASKS/PROGRESS.md` and the phase file.

For a small fix, use judgment — but not for the categories in step 2.

## Non-Negotiable Constraints

1. **All tenant data access goes through `withTenant()`.** Domain code never imports Prisma directly. Never grant `BYPASSRLS`, never make a runtime role a table owner, never add an RLS exception without a justification in the migration and the coverage test (`docs/PLAN/17` §1, `README.md`).
2. **Every new table with `tenant_id`** has RLS enabled and forced with a policy, and composite `(tenant_id, …)` foreign keys to tenant data — foreign keys are checked without RLS.
3. **Every route is registered in `ROUTE_MANIFEST`** with module and permission and written through `defineRoute` / `definePublicRoute` / `defineAdminRoute`. Tenant and admin planes never share a guard (P7, P11).
4. **The frontend hides; the backend refuses** (P9). A hidden button is not a control. Subscription is checked before permission: `402` before `403` (P8).
5. **The frontend is API-only.** Pages never import `@hrms/core`, `@hrms/db`, `@hrms/cache`, route handlers, or the manifest (`frontend-boundary.test.ts`).
6. **Migrations are additive** (P12). No `DROP`, `RENAME`, or `TRUNCATE`; non-transactional statements go in `migrations-online/`.
7. **History is never overwritten** (P13): period-based salary structures, versioned `statutory_configs`, append-only audit.
8. **Attendance evidence is scored, never auto-rejected** (P14). Location only at the moment of a punch; no coordinates on team views (P15). Only punches are written offline; sensitive data is never cached on the device (P16).
9. **Never log** PII (NIK, NPWP, bank accounts), passwords, tokens, or coordinates. Never put a tenant, user, or email in a metric label.
10. **No statutory payroll work** (PPh 21, BPJS, proration, THR, bank export) until Gate C is met. **No Phase 7+ module** until Gate D (`TASKS/README.md`).
11. **Never hand-write API reference documentation.** Change the manifest entry and the `DOCS` entry in `apps/web/src/lib/openapi.ts`.
12. **The backend is English; the frontend is Indonesian** (ADR-030). API responses, error messages, validation messages, logs, debug output, code, comments, and documentation are English. Every word a user sees in the frontend is Indonesian and comes from the frontend — **never render a server `message`**; map the error `code` (and `reason`) to Indonesian text. Seeded display data (menu labels, leave-type and holiday names) stays Indonesian. **Emails and push notifications are Indonesian** (ADR-034) — the one kind of backend output written for people; logs about sending them stay English.
13. **Never mark a security-sensitive task done without an abuse-case test** that was seen to fail.
14. **Never loosen a guard to make a build pass** — a test assertion, a lint rule, a manifest entry, a migration check. If a guard blocks you, the change is wrong or the guard needs an ADR.
15. **`docs/` is reference documentation.** Amend it deliberately through the deviation protocol (`TASKS/00-TASK-CONVENTIONS.md` §7), not as a side effect — except to correct a statement about current state that your change makes false.

## Tech Stack

| Layer | As built |
|---|---|
| Monorepo | pnpm 11, Turborepo, Node ≥ 24, TypeScript run with `--experimental-transform-types` |
| Web | Next.js 16 App Router — pages and `/api`, `/admin/api` route handlers; Tailwind CSS 4; AG Grid 36; hand-written service worker |
| Worker | Node; pg-boss by default, NATS JetStream when `BROKER_URL` is set |
| Auth service | `apps/auth` (`node:http`), built and **off** — authorization stays in-process; not enabled until SSO is adopted (ADR-032) |
| Domain | `packages/core` — framework-free modules exposed through each `index.ts` |
| Data | PostgreSQL 18, one database, a schema per module, forced RLS; Prisma 7 with the pg adapter |
| Cache / limits | Redis 8 when `REDIS_URL` is set; fail-open |
| Contracts | Zod (`packages/contracts`) |
| Tokens | EdDSA with JWKS; HS256 still verifies while `JWT_SECRET` is set |
| Tests | Vitest against real PostgreSQL, Redis, NATS — no mocks |
| Deployment | Docker Compose (`ops/docker-compose.yml`), profiles `split`, `broker`, `backup` |

Divergences from the plan's stack are in `TASKS/BACKLOG.md` Deviations.

## Working Conventions

- **Commits stage explicit paths.** Never `git add -A` or `git add .`. Check `git status` and `git log` first — another tool may be working in the same tree (`MEMORY/records/2026-09-13-concurrent-agent-commits.md`). Leave changes you did not make out of your commit, and say so.
- **One agent per working tree**; parallel work uses git worktrees.
- **Branch and commit names carry the task ID**: `fix/P3-12-trusted-client-address`; `P3-12: take the client address from the trusted proxy`.
- **Comments explain why**, in the depth the existing code does. A comment may not claim a test, guard, or behaviour that does not exist.
- **Cite plan documents as `docs/PLAN/NN §x`.** The numbers are stable (ADR-022).
- **When the plan and reality conflict, stop and surface it** — an ADR and a `DV-nn` backlog entry, then ask. A silent deviation is a bug nobody has found yet.

## Testing Expectations

`docs/PLAN/16`. In short:

- **Real services, never mocks.** Setup as owner; assert through `withTenant`. Fresh random tenants, cleaned up.
- **If a test cannot run against a real service, skip it, mark it, and record why in `docs/PLAN/13`.** An absent optional service skips with a message; a configured but unreachable one fails.
- **Every guard is seen to fail** against a deliberate violation before it is trusted (ADR-020).
- **Assert on codes and identifiers, not prose.**
- **Security tests go through the real handler**, not only the inner function — the `X-Forwarded-For` defect survived because its inner function was well tested and the header parsing in front of it was not.
- Run `pnpm verify` before calling anything done. There is **no CI yet** (`P0-09`), so say that it was run locally.

```bash
pnpm db:up && pnpm db:migrate && pnpm db:seed
pnpm verify
pnpm --filter @hrms/core test
```

## When You're Unsure

Look it up before deciding: `docs/`, then `TASKS/BACKLOG.md`, then `MEMORY/DECISIONS.md`, then the code comments. If the answer is not there, it is a real gap — add an open question to `TASKS/BACKLOG.md` with a recommendation and raise it, rather than deciding silently. Never present something as verified that you did not verify.

<!-- RTK_TOKEN_SAVER_START -->
# RTK Token Saver Rule (claude)

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
