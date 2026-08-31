# 08 — Expansion Module Catalogue & Priorities

---

## 1. The Selection Framework

Adding a module always feels right — every new module is a new reason to buy. Yet every module also adds support surface, regression load, UI complexity, and maintenance cost forever. So every proposal in this document is judged against six criteria.

| Criterion | Question | Weight |
|-----------|----------|--------|
| **Pain** | How often does this problem occur, and how expensive is getting it wrong? | 25% |
| **Stickiness** | Once adopted, how hard is it for the customer to leave? | 20% |
| **Data synergy** | Does this module strengthen the others, or stand alone? | 20% |
| **Willingness to pay** | Does the buyer see it as a cost saver or merely a nice feature? | 15% |
| **Build cost** | Person-months to production quality | 10% (inverse) |
| **Regulatory risk** | Does a miscalculation or misfiling carry a penalty? | 10% (inverse) |

### 1.1 Two Rules That Constrain This List

**Rule 1 — Depth before breadth.** Ten half-finished modules lose to four that genuinely finish the job. SME customers do not buy because of feature count; they buy because one previously painful job is now done.

**Rule 2 — Every module must connect to data that already exists.** A module that neither reads nor writes employee, attendance, or payroll data is essentially a different product that happens to be sold alongside. That is not expansion, that is a loss of focus.

### 1.2 Signals from the Reference Product

Two things worth reading off the reference page:

1. **An HSE-community-based distribution channel.** The Basic plan's checkout link points at `lynk.id/komunitashse`, while the other plans point at `lynk.id/hrscientist`. The vendor has access to a community of occupational health and safety practitioners. This is not a trivial detail: the **OHS/HSE** module has the shortest distribution path available, because its audience is already gathered and has already bought once. Every other module has to find its own market.

2. **The tiering structure is already proven acceptable.** Basic → Advanced → Ultimate with a 1.5–2× price step shows the market will pay more for more coverage. A new module needs a clear place in that structure, rather than becoming one more entry in a long list with no grouping logic.

---

## 2. The Proposal Catalogue

Complexity notation: **S** = 1–2 person-months, **M** = 3–5, **L** = 6–10, **XL** = > 10.

### 2.1 Group A — High Priority (recommended to build within 18 months)

---

#### A1. Onboarding & Offboarding

| | |
|---|---|
| **Problem** | A new hire starts with no laptop, no email access, and no BPJS registration. A leaver walks out with company assets while their accounts stay active for months |
| **Users** | HR Admin, IT, the direct manager, the new hire |
| **Contents** | Per-position checklist templates, automatic cross-department assignment, progress tracking, asset handover, exit clearance, exit interviews |
| **Host service** | `onboarding-service` (new) |
| **Dependencies** | `employee-service` (required), `recruitment-service` (optional — a candidate conversion triggers onboarding) |
| **Complexity** | M |
| **Tier** | Advanced |
| **Score** | High pain · high stickiness · high synergy |

**Why this is number one:** onboarding is cross-department orchestration, and cross-department orchestration is exactly what a spreadsheet cannot do. It is also the module with the highest stickiness — once a company's onboarding process runs in the system, moving it means changing how a dozen people work.

```typescript
// service.manifest.ts
export default defineService({
  key: 'onboarding',
  name: 'Onboarding & Offboarding',
  tier: 'ADVANCED',
  requires: ['core.organization'],
  enhances: ['recruitment', 'asset', 'training'],
  subscribes: [
    'recruitment.candidate.hired',      // triggers onboarding automatically
    'employee.employee.created',
    'employee.employee.terminated',     // triggers offboarding automatically
  ],
  publishes: [
    'onboarding.journey.started', 'onboarding.task.completed',
    'onboarding.journey.completed', 'offboarding.clearance.completed',
  ],
});
```

```sql
-- onboarding_db
CREATE TABLE journey_templates (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('ONBOARDING','OFFBOARDING')),
  name          text NOT NULL,
  position_ids  uuid[] NOT NULL DEFAULT '{}',   -- empty = applies to every position
  org_unit_ids  uuid[] NOT NULL DEFAULT '{}',
  is_active     boolean NOT NULL DEFAULT true
);

CREATE TABLE template_tasks (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL,
  template_id   uuid NOT NULL REFERENCES journey_templates(id) ON DELETE CASCADE,
  sequence      smallint NOT NULL,
  title         text NOT NULL,
  description   text,
  assignee_type text NOT NULL,        -- HR / IT / MANAGER / EMPLOYEE / SPECIFIC_ROLE
  assignee_role_key text,
  due_offset_days smallint NOT NULL,  -- relative to the start/leave date; negative = before
  requires_evidence boolean NOT NULL DEFAULT false,
  blocks_completion boolean NOT NULL DEFAULT false,   -- clearance cannot finish without this
  UNIQUE (template_id, sequence)
);

CREATE TABLE journeys (
  id            uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id     uuid NOT NULL,
  template_id   uuid NOT NULL REFERENCES journey_templates(id),
  employee_id   uuid NOT NULL,
  kind          text NOT NULL,
  reference_date date NOT NULL,       -- the start date or the leaving date
  status        text NOT NULL DEFAULT 'IN_PROGRESS',
  progress_pct  smallint NOT NULL DEFAULT 0,
  completed_at  timestamptz,
  version       integer NOT NULL DEFAULT 1
);

CREATE TABLE journey_tasks (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL,
  journey_id   uuid NOT NULL REFERENCES journeys(id) ON DELETE CASCADE,
  title        text NOT NULL,
  assignee_user_id uuid,
  due_date     date NOT NULL,
  status       text NOT NULL DEFAULT 'PENDING',   -- PENDING/DONE/SKIPPED/OVERDUE
  evidence_key text,
  completed_by uuid,
  completed_at timestamptz,
  skip_reason  text
);
CREATE INDEX idx_journey_tasks_inbox ON journey_tasks (tenant_id, assignee_user_id, status)
  WHERE status IN ('PENDING','OVERDUE');
```

---

#### A2. Reimbursement & Employee Claims

| | |
|---|---|
| **Problem** | Medical, transport, and meal claims are collected over WhatsApp and in envelopes, recapped by hand, and often missed by payroll |
| **Users** | Every employee (high transaction volume), HR, Finance |
| **Contents** | Submission with a photo of the receipt, ceilings per type and per position, an approval flow, payment through payroll or a separate transfer, reporting per cost centre |
| **Host service** | `claim-service` (new) |
| **Dependencies** | `employee-service`, `payroll-service` (for payment through wages) |
| **Complexity** | M |
| **Tier** | Advanced |

**Why it matters:** this is the only module on the list **almost every employee uses every month**. A module with daily contact creates habit, and habit creates retention. Other HR modules are generally touched only by the HR team.

**A scope warning:** keep it to employee claims. The moment it starts handling purchase requests, vendors, and accounting journals, it turns into an ERP module and will never be finished.

---

#### A3. OHS / HSE Management

| | |
|---|---|
| **Problem** | Workplace accident reports, PPE inspections, HIRADC, and mandatory safety filings still run on paper forms and Excel |
| **Users** | The safety officer, field supervisors, HR |
| **Contents** | Incident reporting (near misses included), root cause investigation, HIRADC/JSA, scheduled inspections, PPE tracking, the safety certification matrix, FR/SR statistics, mandatory reports |
| **Host service** | `hse-service` (new) |
| **Dependencies** | `employee-service`, `training-service` (certifications), `asset-service` (PPE) |
| **Complexity** | L |
| **Tier** | Ultimate, or an industry add-on |

**Why this is a strong candidate despite not being a classic HR module:** the vendor's distribution channel is already an HSE community (§1.2). That means customer acquisition cost for this module is far lower than for any other on the list. On top of that, occupational safety is mandatory in manufacturing, construction, and mining — the same segments with the most complex shift attendance needs, so drawing them in through safety and then selling attendance is a sensible path.

**A note of caution:** this module is the furthest from HR domain competence. Building it requires a safety expert, not an HR expert. Do not start it without securing access to that expertise.

---

#### A4. Business Travel (SPPD) & Cash Advances

| | |
|---|---|
| **Problem** | Travel advances are recorded in a notebook, the accounting comes in late, and unused advances are never recovered |
| **Users** | Employees, managers, Finance, HR |
| **Contents** | Travel requests, per diem calculation by grade, advances, settlement with evidence, resolving the difference through payroll. Employee cash advances/loans with automatic instalment deductions |
| **Host service** | `claim-service` (one service shared with A2 — the concept is identical: submission, approval, financial settlement) |
| **Dependencies** | `payroll-service` (required — instalment deductions) |
| **Complexity** | M |
| **Tier** | Advanced |

**The Indonesian context:** cash advances are an almost universal practice in Indonesian SMEs and are almost never handled by foreign HR software. Instalment deductions that flow automatically into payroll are a very concrete differentiator and easy to explain to a buyer.

---

#### A5. Contract Management & Compliance Reminders

| | |
|---|---|
| **Problem** | A fixed-term contract expires unnoticed and automatically becomes permanent. Safety certificates, operator licences, and work permits expire with no warning |
| **Users** | HR Admin, Legal |
| **Contents** | Tracking the validity of contracts, certificates, and permits. Tiered reminders (90, 30, and 7 days out). A renewal flow. Contract templates. Digital signing (optional) |
| **Host service** | An extension of `employee-service` — not a new service |
| **Dependencies** | — |
| **Complexity** | S |
| **Tier** | Basic (the highest value-per-cost on the list) |

**Why this is the best candidate on value-to-cost ratio:** its complexity is small (the contract and document data already lives in `employee-service`; all that is added is the reminder engine), yet the consequence of failure is large and easy for a buyer to grasp. One fixed-term contract that lapses into a permanent one is a permanent legal loss worth far more than a year's subscription.

---

### 2.2 Group B — Medium Priority (candidates for months 18–30)

---

#### B1. Training & Certification

| | |
|---|---|
| **Problem** | Training history is scattered, mandatory certificates expire, and the training budget is not tracked |
| **Contents** | A training catalogue, enrolment, per-employee history, a competency matrix, certificate validity, budget vs actuals, post-training evaluation |
| **Host service** | `training-service` (new) |
| **Dependencies** | `performance-service` (competency gaps), `planning-service` (IDPs), `hse-service` (safety certifications) |
| **Complexity** | M |
| **Tier** | Ultimate |

**The scope boundary to hold:** this is **training record-keeping**, not an LMS. Do not build a video player, quizzes, SCORM, or discussion forums. A full LMS is a product of its own with a team of its own; mixing it into an HRIS produces both a poor LMS and a heavy HRIS.

---

#### B2. Asset & Inventory Management

| | |
|---|---|
| **Problem** | Laptops, vehicles, uniforms, and PPE are untracked; items disappear when an employee leaves |
| **Contents** | Asset registration, assignment to an employee, handover records, maintenance schedules, simple depreciation, integration with offboarding clearance |
| **Host service** | `asset-service` (new) |
| **Dependencies** | `employee-service`, `onboarding-service` |
| **Complexity** | M |
| **Tier** | Advanced |

This module multiplies the value of A1 (onboarding/offboarding) — exit clearance without an asset list is just an empty checklist.

---

#### B3. Advanced Shift Scheduling (Roster Planning)

| | |
|---|---|
| **Problem** | Manufacturing/retail/hospital shift schedules are built by hand in Excel every week and frequently breach working-hour limits |
| **Contents** | Repeating shift patterns, demand-based scheduling, employee shift swaps with approval, rule validation (minimum rest, overtime limits), a cost estimate before the schedule is locked |
| **Host service** | An extension of `attendance-service` |
| **Complexity** | L |
| **Tier** | Ultimate, or an industry add-on |

**The module with the highest willingness to pay** in the manufacturing and hospital segments, because poor scheduling translates directly into overtime cost. But the algorithmic complexity is real (this is a constrained optimisation problem), so it should not be underestimated.

---

#### B4. Employee Survey & Engagement

| | |
|---|---|
| **Contents** | Pulse surveys, eNPS, satisfaction surveys, anonymous answers with a minimum respondent threshold, trends per unit |
| **Host service** | `engagement-service` (new) |
| **Complexity** | S–M |
| **Tier** | Ultimate |

A cheap module to build with high perceived value for management. Mind the anonymity threshold: survey results for a 4-person unit must not be shown per unit — exactly the same problem discussed in document `07` §4.4.

---

#### B5. HR Helpdesk (Ticketing)

| | |
|---|---|
| **Problem** | Employee questions (employment letters, attendance corrections, BPJS questions) arrive via HR's personal WhatsApp with no trail |
| **Contents** | Categorised tickets, SLAs, a knowledge base, automatic letter templates, HR workload reporting |
| **Host service** | `helpdesk-service` (new) |
| **Complexity** | M |
| **Tier** | Advanced |

This module gives HR a quantitative argument for more headcount — data they never previously had.

---

#### B6. Compliance & Mandatory Reporting

| | |
|---|---|
| **Contents** | The mandatory employment report (WLKP), the BPJS recap, e-SPT 1721 support, foreign worker reports, an archive of filing evidence |
| **Host service** | Extensions of `payroll-service` and `employee-service` |
| **Complexity** | M, but **maintenance-heavy** (the formats change with the regulations) |
| **Tier** | Ultimate |

**An honest warning:** this module produces permanent maintenance debt. Every change to a government reporting format becomes mandatory work with a non-negotiable deadline. Build it only with a committed ongoing resource, never as a one-off project.

---

### 2.3 Group C — Long-Term Candidates

| Module | Short note |
|--------|------------|
| **Compensation Review Cycle** | Performance-based salary increase cycles, budget simulation, a merit matrix. Depends on a mature `performance-service` |
| **Succession & Talent Pool** | The 9-box already exists in performance; this adds a succession map and successor readiness |
| **Advanced People Analytics** | Turnover prediction, cost-to-hire, pay gap analysis. Needs 12–24 months of history to mean anything — do not build it too early |
| **Outsourcing Vendor Management** | Relevant to companies with a large contracted workforce; contract complexity is high |
| **Timesheet & Project Costing** | For consultancies/agencies: billable hours per project. A different segment from the core market |
| **Multi-Entity / Company Group** | One tenant with several legal entities, separate payroll, consolidated reporting. **This is the correct answer to the "see another tenant's data" request** (doc. 07 R25) |
| **Integration Hub & Open API** | Webhooks, a public API, accounting connectors. Monetised per call or per tier |
| **Whistleblowing Channel** | Anonymous reporting with strict confidentiality; technically an extension of `relation-service` with a harder ACL |
| **Employee Benefits Marketplace** | Supplementary insurance, wellness. A commission business model — essentially a different line of business |

---

## 3. What Should **Not** Be Built

This list matters as much as the one above.

| Idea | Reason for refusal |
|------|--------------------|
| **A full LMS** (video, SCORM, quizzes, forums) | A product of its own with a team of its own. Recording training history (B1) and integrating with a third-party LMS is enough |
| **Full accounting and finance** | Direct competition with Accurate/Jurnal/Xero, all far more mature. Build a journal export, not a general ledger |
| **Multi-country payroll** | Each country is a months-long project. Master Indonesia properly first |
| **Video interviews & AI screening** | High cost, low differentiation, and plenty of specialist providers. Integrate, do not build |
| **Internal chat / social feed** | Loses badly to WhatsApp and Slack. One-way announcements are enough |
| **Attendance hardware** | A manufacturing business, not a software one. Build the connector only |
| **General project management** | Not HR. A timesheet for payroll is a different thing from Asana |
| **CRM / sales** | Entirely outside the domain |

**The pattern worth recognising:** every idea in this table feels like "just one more feature" the first time it is proposed — usually by a large customer willing to pay. That is precisely what makes it dangerous. The simple test: if the feature reads no employee, attendance, or payroll data, it is not an expansion of this product.

---

## 4. Priority Recommendation

### 4.1 The 18-Month Shortlist

If only five may be chosen, in this order:

| # | Module | Why this position | Complexity | Tier |
|---|--------|-------------------|------------|------|
| 1 | **Contracts & Compliance Reminders** (A5) | The highest value-to-cost ratio; an extension of an existing service; the legal risk is easy to explain to a buyer | S | Basic |
| 2 | **Reimbursement & Claims** (A2) | The only module touched daily by every employee; the strongest retention driver | M | Advanced |
| 3 | **Onboarding & Offboarding** (A1) | The highest stickiness; makes use of all the data that already exists | M | Advanced |
| 4 | **Travel & Cash Advances** (A4) | Shares a service with A2, so its marginal cost is low; distinctly Indonesian | M | Advanced |
| 5 | **OHS / HSE** (A3) | The lowest customer acquisition cost thanks to the existing community channel | L | Ultimate |

**Total addition: ± 18–22 person-months**, spread out after Phase 4.

### 4.2 The Ordering and Its Reasons

This order is not based on size of value but on **the combination of value and momentum**:

- Numbers 1 and 2 are deliberately quick to finish, so there is proof of new value delivered before starting a large module.
- Numbers 2 and 4 share one service (`claim-service`), so building them consecutively is far cheaper than building them far apart.
- Number 5 is last because it needs domain expertise the team may not have, and acquiring that takes time.

### 4.3 Decisions Needed Before Starting

| Question | Why it has to be decided first |
|----------|-------------------------------|
| Is OHS/HSE a separate product line or an HRIS module? | If separate, it needs its own dashboard, roles, and even its own buyer (the safety officer, not HR). The answer changes the architecture |
| Does Reimbursement pay through payroll or a separate transfer? | Paying through payroll creates a hard dependency on `payroll-service`, which means the module cannot be sold to Basic plan customers |
| Who is the domain expert for OHS and mandatory reporting? | Neither module can be built from documents alone |
| Does Multi-Entity make the list? | It is the only architecturally correct answer to the "see another company's data within a group" request (doc. `07` R25). If many prospects are company groups, its priority rises sharply |

---

## 5. Architectural Impact

### 5.1 A New Service vs Extending an Existing One

| Module | Decision | Reason |
|--------|----------|--------|
| Contracts & Compliance (A5) | Extend `employee-service` | The contract and document data is already there; splitting it out only adds cross-service calls |
| Reimbursement (A2) + Travel/Advances (A4) | One new `claim-service` | The concept is identical: submission → approval → financial settlement. Splitting them produces two services that are 70% the same code |
| Onboarding (A1) | A new `onboarding-service` | Cross-department task orchestration is its own domain with its own lifecycle |
| OHS/HSE (A3) | A new `hse-service` | The domain furthest from HR; a firm boundary makes selling it separately easier later |
| Training (B1) | A new `training-service` | Self-contained, and read by many other modules |
| Assets (B2) | A new `asset-service` | An asset's lifecycle is independent of an employee's |
| Roster (B3) | Extend `attendance-service` | Schedules and attendance are one bounded context; splitting them creates tight cross-service coupling |

**The principle applied:** a new service is created when the domain has a lifecycle and a language of its own. An extension is chosen when the data already exists and separation would only produce gRPC round trips.

If all of Group A and Group B were built, the service count would reach **24** (18 today + 6 new). That crosses the threshold at which the operational load needs re-examining — see §7.

### 5.2 New Cross-Service Events

```typescript
// packages/contracts/src/events/expansion.ts
'onboarding.journey.started'        // → notification, asset (prepare assets), training (enrol in induction)
'onboarding.journey.completed'      // → employee (mark onboarding done), reporting
'offboarding.clearance.completed'   // → payroll (allow the final settlement), auth (deactivate the account), asset
'claim.submitted'                   // → notification
'claim.approved'                    // → payroll (add to the next salary component)
'loan.installment.scheduled'        // → payroll (instalment deduction)
'contract.expiring'                 // → notification, onboarding (prepare the renewal)
'certification.expiring'            // → notification, hse (block assignment if the certificate has lapsed)
'asset.assigned' / 'asset.returned' // → onboarding, reporting
'hse.incident.reported'             // → notification (escalation), relation (where negligence is involved)
'training.completed'                // → performance (update the competency), planning (IDP progress)
```

One dependency needs particular attention: **`offboarding.clearance.completed` becomes the gate for the payroll final settlement.** That means `payroll-service` now has a new precondition coming from a service the tenant may not have subscribed to. It is handled by principle P3 from document `00`: if the onboarding module is not enabled, payroll does not wait for an event that will never arrive.

```typescript
// services/payroll-service/src/application/final-settlement.usecase.ts
async canRunFinalSettlement(tenantId: string, employeeId: string): Promise<GateResult> {
  const hasOnboarding = await this.subscription.hasModule(tenantId, 'onboarding');

  // Module not subscribed → there is no clearance gate at all.
  // An event consumer must tolerate an event that never arrives.
  if (!hasOnboarding) return { allowed: true };

  const clearance = await this.clearanceRef.find(tenantId, employeeId);
  if (!clearance?.completedAt) {
    return { allowed: false,
      reason: 'Clearance offboarding belum selesai. Selesaikan serah terima aset terlebih dahulu.' };
  }
  return { allowed: true };
}
```

---

## 6. Impact on Plans & Pricing

### 6.1 A Proposed Plan Structure After the Expansion

| Plan | Modules | Positioning |
|------|---------|-------------|
| **Basic** | core.organization, attendance, leave, performance, **contract-compliance** | Basic HR administration + a legal risk safeguard |
| **Advanced** | Basic + payroll, planning (RACI/DACI), relation, **claim**, **onboarding**, **asset**, **helpdesk** | End-to-end HR operations |
| **Ultimate** | Advanced + recruitment, planning (FTE, IDP), **training**, **engagement**, **compliance-reporting** | Full employee lifecycle management |
| **Industry add-ons** | **hse**, **roster-planning**, **multi-entity** | Bought separately according to industry need |

**The important change from the reference structure:** moving `contract-compliance` into Basic. The cheapest module to build goes into the cheapest plan, as the differentiator against the Excel product — something a spreadsheet literally cannot do is send a reminder.

### 6.2 Industry Add-ons as a Separate Category

OHS/HSE, Roster Planning, and Multi-Entity are not folded into the plan tiers but sold as add-ons. The reason: all three are extremely valuable to a small fraction of customers and nearly worthless to most. Folding them into Ultimate means raising the Ultimate price for everyone for features only 20% will use.

Technically the architecture already supports this fully: `tenant_modules.source` already distinguishes `PLAN` from `ADDON` (document `02`, §3).

---

## 7. Roadmap Impact & Capacity Limits

### 7.1 Phase Placement

| Phase | Expansion module |
|-------|------------------|
| **Phase 2** (alongside payroll) | **A5 — Contracts & Compliance** (complexity S, builds on the already-finished `employee-service`; does not disturb the payroll critical path) |
| **Phase 4** (alongside the marketplace) | **A2 — Reimbursement** and **A4 — Travel & Cash Advances** (one service, built consecutively) |
| **Phase 5** | **A1 — Onboarding & Offboarding**, **B2 — Assets** (mutually reinforcing, built as a pair) |
| **Phase 6 (new)** | **A3 — OHS/HSE** as an industry add-on; **B1 — Training** |
| Reviewed later | All of the remaining Group B and Group C, against real usage data |

**Estimate additions:**

| Group | Person-months |
|-------|---------------|
| A5 (Phase 2) | 2 |
| A2 + A4 (Phase 4) | 8 |
| A1 + B2 (Phase 5) | 9 |
| A3 (Phase 6) | 8 |
| **Shortlist total** | **± 27** |

The project total becomes **± 264 person-months** before the buffer, **± 317** after the 20% buffer.

### 7.2 Capacity Limits That Have to Be Acknowledged

With 24 services, two things need an honest review:

1. **The Platform/SRE ratio.** Two FTE is enough for 18 services. At 24 services with 24 databases, 24 deploy pipelines, and 24 alert sets, a third is likely necessary. This is not a one-off cost — it is an ongoing cost for the life of the product.

2. **When to stop adding services.** Every new module after this should be evaluated with the question: does it genuinely need its own service, or can it be a bounded context inside an existing one? The natural tendency of a team accustomed to microservices is to create a new service for everything, and that ends in a fleet nobody can run locally.

**The indicator to watch:** if the median number of services touched per PR consistently rises above 2, the service boundaries are wrong and adding new modules must stop until they are fixed. This metric already exists in document `04`, §12.

---

## 7.3 Migrating a New Module

Every expansion module adds tables, columns, permissions, and menus. All of it follows the rules of document `09`:

| Kind of addition | How |
|------------------|-----|
| A new service and database (`claim_db`, `onboarding_db`, and so on) | `CREATE DATABASE` + `00_foundation.sql` + `apply_rls_everywhere()`. The only `CREATE DATABASE` case, with no `DROP` of any kind |
| A new table in an existing service (`contract-compliance` in `employee_db`) | `CREATE TABLE IF NOT EXISTS` + RLS |
| A new column on a table that already holds data | Nullable or with a constant default; `NOT NULL` only through the four-step pattern (doc. `09` §3.3) |
| New permissions and menus | `INSERT ... ON CONFLICT DO NOTHING` during `onEnable` |
| New events | Additive; existing contracts are unchanged |
| A new column on `employee_ref` across many services | The mandatory order in document `09` §6.3 — source first, consumers after |

**What needs particular care:** `claim-service` adds a new deduction component to payroll (cash advance instalments). That means new columns or rows in `payroll_db`, and payslips already issued **must not change because of it**. Adding a component follows the time-dimensioned pattern in document `09` §9.3: the new component gets its own `effective_from` rather than overwriting the old configuration.

---

## 8. Risks

| # | Risk | Prob. | Impact | Mitigation |
|---|------|-------|--------|------------|
| **R26** | **Expanding breadth ahead of depth** — many modules, all half-baked | **High** | **High** | The 5-module shortlist with an explicit gate: the next module does not start until the previous one's adoption exceeds 30% of the eligible customer base |
| R27 | The compliance module (B6) becomes permanent maintenance debt | High | Medium | Build it only with a committed ongoing resource; make the reporting formats versioned configuration rather than code |
| R28 | OHS/HSE is built without a domain expert | Medium | High | Do not start before a safety expert is engaged; validate with 3 manufacturing companies before writing code |
| R29 | The service count exceeds the team's operational capacity | Medium | High | A review threshold at 20 services; prefer extending an existing service over creating a new one |
| R30 | A new dependency makes an old module fail when the new module is not subscribed | Medium | Medium | Principle P3: every event consumer must tolerate an event that never arrives; tested explicitly |
| R31 | Industry add-ons split the team's focus across two different markets | Medium | Medium | OHS/HSE runs as a separate track with a small dedicated team, not loaded onto the core team |

---

## 9. Module Evaluation Metrics

Every released module is evaluated after 90 days. A module that misses the threshold is not automatically removed, but it must receive no further investment until the cause is understood.

| Metric | Threshold |
|--------|-----------|
| Adoption (eligible tenants that enable it) | ≥ 30% within 90 days |
| Active use (tenants using it at least once a month) | ≥ 60% of those who enabled it |
| Contribution to plan upgrade conversion | Measurable, ≥ 10% of upgrades cite it |
| Support tickets per active tenant per month | < 0.5 |
| Effect on retention | Tenants with this module churn below the average |

> The 30% adoption threshold is chosen deliberately: a module used by only a quarter of the customers eligible for it usually signals one of three things — it does not solve a real problem, it is too hard to use, or nobody knows it exists. All three need fixing before the next module is added.
