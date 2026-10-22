# P6-13 — Permission ceiling

| | |
|---|---|
| **Date** | 2026-10-22 |
| **Task** | `TASKS/PHASE-6-COMMERCIALISATION-HARDENING.md` § P6-13 |
| **Phase** | Phase 6 |
| **Surface** | backend, contracts |
| **Author** | Agent (Claude Code) |
| **Commits** | `P6-13: refuse conferring permissions the actor does not hold` |
| **Spec** | `MEMORY/specs/P6-13-permission-ceiling.md` |
| **Status** | Completed |
| **Reconstructed** | No |

---

## What Changed

Nobody but a `TENANT_OWNER` holder can confer a permission they do not hold, or change the owner's access. Covered: role permission edits (additions only), GRANTs, lifting a DENY, single and bulk invitations. Refusal is 403 `PERMISSION_CEILING` with `details`. Rule recorded as ADR-035.

## Why

Risk F12. Delegating IAM to a custom role was handing over ownership. The worst case was not escalation but lockout: a delegate could empty the `TENANT_OWNER` role or DENY the owner's `iam.role.manage`.

## How

- `packages/core/src/iam/ceiling.ts` — `assertCanConfer`.
- `applyPrecedence` extracted from `resolveEffectiveAccess` so the ceiling and the resolver share one meaning of "held".
- `IamError` moved to `iam/errors.ts` (the ceiling and administration would otherwise import each other) and gained `ceiling` and `details`.
- `inviteUser` split into `findAssignableRole` + `createInvitedUser` so the bulk invite checks once, before the loop. Otherwise a refusal would land in `failed` once per employee and the call would still return 201.
- `apps/web/src/lib/iam-error.ts` — one mapping for all five IAM handlers.

## Verification

- `apps/web/test/permission-ceiling.test.ts`, 16 cases through the real route modules against PostgreSQL. Against the old code, 11 failed: all ten abuse cases succeeded (200/201), and the owner case failed with 403. The 403 came from the earlier case where the delegate emptied the owner role, so the lockout was demonstrated, not inferred. After the change: 16/16.
- `pnpm turbo run typecheck test build`: every suite passes except `openapi-coverage.test.ts`, which is the P6-18.1 guard. That guard fails on purpose until P6-18.2 documents 86 routes, and it was failing before this change.
- `pnpm lint` fails on two unused imports in the uncommitted PF-02 work (`app-shell.tsx`, `mobile-nav.tsx`). That work was already in the tree and is not part of this commit.
- Run locally; there is no CI run for this change.

## Decisions

The ceiling ignores the subscription filter (spec §13). Self-grants are not refused outright (ADR-035).

## What Did Not Work

`pnpm db:seed` fails on Node 26: `--experimental-transform-types` is no longer a valid flag. The database already held seed data, and the tests create their own tenants, so this did not block the work. Recorded as an open item.
