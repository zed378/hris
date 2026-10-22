# P6-13 — Permission Ceiling for Role and Grant Administrators

Status: **Implemented** — see `MEMORY/CHANGELOG.md` 2026-10-22
Task: `TASKS/PHASE-6-COMMERCIALISATION-HARDENING.md` P6-13
Plan refs: `docs/SECURITY/02` §5(a), `docs/PLAN/05` §4 and §7, risk F12, ADR-035

---

## 1. Business Objective

A tenant can delegate role and grant administration to a custom role ("HR Admin" holding `iam.role.manage` and `iam.grant.manage`). Today that delegate can confer any permission — `payroll.run.execute` on their own role, a direct grant to themselves, or strip `TENANT_OWNER` of its own access. Delegation is therefore equivalent to handing over ownership. Done when nobody but `TENANT_OWNER` can confer access they do not themselves hold, or alter the owner's access.

## 2. Actors

The tenant owner (Pak Budi); a delegated HR administrator (Mbak Dewi) holding a custom role with IAM permissions; the employees whose access is changed.

## 3. Functional Requirements

- **FR1 — Ceiling.** An actor who does not hold the `TENANT_OWNER` role may confer only permissions they hold. "Hold" means steps 1–3 of `docs/PLAN/05` §4: role permissions plus unexpired GRANTs minus DENYs — **before** the subscription filter (§13).
- **FR2 — What confers.** Each of these confers permissions and is checked:
  - `setRolePermissions`: the permissions **added** (requested − current). Permissions already on the role and removals are not checked — an administrator must be able to save a matrix row that already contains permissions they lack, and must always be able to remove access.
  - `setUserGrant` with `GRANT`: the permission.
  - `removeUserGrant` of a `DENY`: the permission (lifting a DENY restores access).
  - `inviteUser` and `inviteEmployeesAsUsers`: every permission of the assigned role.
- **FR3 — Removing access stays possible.** `setUserGrant` with `DENY`, `removeUserGrant` of a `GRANT`, and removing permissions from a role are not subject to the ceiling.
- **FR4 — Owner protection.** A non-owner may not change the `TENANT_OWNER` role's permissions, assign the `TENANT_OWNER` role, or set or remove a grant on a user who holds `TENANT_OWNER`. Without this, a delegate could DENY `iam.role.manage` to the owner, or empty the owner role, and lock the owner out of their own tenant.
- **FR5 — Owner.** A holder of `TENANT_OWNER` is not subject to FR1–FR4.
- **FR6 — Distinct refusal.** A refusal is `403` with code `PERMISSION_CEILING`, and `details.permissions` listing the permissions the actor lacks, or `details.role = ["TENANT_OWNER"]` for owner protection. Nothing is written.

## 4. Non-Functional Requirements

Two extra reads per IAM write (actor roles, actor grants). IAM writes are rare administrative actions; no latency target applies. Bulk invite checks once per call, not per row.

## 5. Dependencies

None. No environment variable, no subscription change.

## 6. Database Changes

Not applicable — the rule is enforced in `packages/core/src/iam`; it needs no new column or table.

## 7. API Contract

No new routes. Existing routes gain one refusal:

| Route | New refusal |
|---|---|
| `PUT /api/roles/[id]/permissions` | 403 `PERMISSION_CEILING` |
| `PUT /api/users/[id]/grants` | 403 `PERMISSION_CEILING` |
| `DELETE /api/users/[id]/grants` | 403 `PERMISSION_CEILING` |
| `POST /api/users` | 403 `PERMISSION_CEILING` |
| `POST /api/users/from-employees` | 403 `PERMISSION_CEILING` |

The routes now map every `IamError` kind consistently (`not_found` 404, `conflict` 409, `ceiling` 403) through one helper, where before `conflict` from the grant and role routes surfaced as 404.

## 8. Frontend Changes

`ErrorCode.PERMISSION_CEILING` is added to `packages/contracts`. The Indonesian text for it belongs to `PF-20` (message catalogue); until then the roles screen shows its existing generic failure. Recorded on `PF-20`.

## 9. Backend Changes

- `packages/core/src/iam/ceiling.ts` — `assertCanConfer(tx, tenantId, actorUserId, { permissions, targetUserId?, roleCode? })`.
- `packages/core/src/iam/resolve-access.ts` — the precedence rule (steps 1–3) extracted into `applyPrecedence`, used by both `resolveEffectiveAccess` and the ceiling, so the two cannot drift.
- `packages/core/src/iam/administration.ts` — `IamError` gains kind `ceiling` and `details`; every conferring function calls the ceiling before writing.
- `apps/web/src/lib/iam-error.ts` — one `IamError` → response mapping.

## 10. Authorization Rules

The route permission (`iam.role.manage`, `iam.grant.manage`, `iam.user.create`) is still checked first by the gateway; the ceiling is a second, data-dependent check inside the domain function. Subscription (402) and route permission (403 `PERMISSION_DENIED`) precede it.

## 11. Validation

Unchanged. Unknown permission codes are still refused `not_found` before the ceiling runs, so the ceiling never reports an unknown code.

## 12. Error Handling

The user sees a refusal naming the permissions they lack (Indonesian text via `PF-20`). The audit trail records nothing for a refused change — nothing changed. The refusal is logged by the route wrapper as a 403.

## 13. Edge Cases

- **Subscription.** The ceiling compares against held permissions before the subscription filter. A delegate whose role contains `payroll.payslip.read.own` while payroll is unsubscribed can still invite employees into the `EMPLOYEE` role that carries it. Conferring a permission of an unsubscribed module confers nothing until the module is enabled, and the actor's own permission returns at the same moment.
- **Expired grant.** An expired GRANT is not held.
- **Self-DENY.** An actor holding a DENY on a permission does not hold it, so cannot lift their own DENY.
- **Self-grant of a held permission.** Allowed and audited; it confers nothing new. Refusing it outright (card step 3) was considered and not done: it adds a rule without closing an escalation.
- **Editing one's own role.** Covered by FR1 — no special case.

## 14. Abuse Cases

From `docs/SECURITY/02` §5(a), all through the real route handler:

1. A delegate with `iam.role.manage` but not `payroll.run.execute` adds it to their own role → 403 `PERMISSION_CEILING`.
2. … adds it to another role → 403.
3. A delegate with `iam.grant.manage` grants it to themselves → 403; to another user → 403.
4. A delegate lifts a DENY on a permission they lack → 403.
5. A delegate DENYs a permission to the owner → 403.
6. A delegate empties the `TENANT_OWNER` role → 403.
7. A delegate invites a user into `TENANT_OWNER`, or into a role holding permissions they lack → 403.

## 15. Logging and Audit

Successful changes are audited as before. Refusals write nothing.

## 16. Security Controls

Closes F12. The check lives in `packages/core`, below every route, so a future route reusing these functions inherits it.

## 17. Testing Strategy

`apps/web/test/permission-ceiling.test.ts`: real PostgreSQL, real signed tokens, the real route modules. Each abuse case seen to fail against the code before the change.

## 18. Acceptance Criteria

The card's DoD: a custom role holding `iam.role.manage` but not `payroll.run.execute` cannot add it to any role, including its own; cannot grant it directly to itself or anyone; can add permissions it holds; `TENANT_OWNER` can add anything.

## 19. Definition of Done

Tests above pass and were seen to fail; `docs/SECURITY/02` §5 and risk F12 updated; ADR-035 records the rule as new policy for `docs/PLAN/05`.

## 20. Implementation Sequence

Tests → `applyPrecedence` extraction → ceiling → wiring into administration and bulk invite → route mapping → docs.

## 21. Rollback Strategy

Revert the commit. No data changes.

## 22. Technical Risks

A tenant that has already delegated IAM to a custom role loses the ability to confer permissions that role does not hold. That is the intended change; the owner can still do it.
