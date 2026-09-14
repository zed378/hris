# Phase <N> — Summary

| | |
|---|---|
| **Phase** | Phase <N> — <name> |
| **Started** | YYYY-MM-DD |
| **Completed** | YYYY-MM-DD, or "open" |
| **Tasks done** | n / m |
| **Gate after this phase** | A / B / C / D / none — state: met, not met, untested |
| **Release tag** | |
| **Reconstructed** | No / Yes — sources: |

---

## What Shipped

Capabilities that now exist, in terms an HR administrator or a pilot customer would recognise.

## Definition of Done Verification

Every item of the phase DoD in `docs/PLAN/12` §6, with evidence — a test name, a measurement with its conditions, a recorded walkthrough. Not an assertion.

| DoD item | Evidence | Met |
|---|---|---|
| | | Yes / Partly / No |

## Gate

The gate that follows this phase (`docs/PLAN/12` §6), whether it was tested, and the result. If the next phase starts without the gate met, that is a deviation and needs an ADR.

## Performance Results

Against `docs/PLAN/18` targets. A number without its conditions is not a measurement.

| Measurement | Target | Result | Conditions |
|---|---|---|---|
| | | | |

## Security Verification

Scenarios from `docs/SECURITY/02` exercised, how, and what was found. Status changes to `SECURITY/02` made in this phase.

## Deviations from the Plan

Each with its ADR and `DV-nn`.

## Deferred Out of This Phase

What was planned and did not ship, why, and where it now lives.

## What Was Harder Than Expected

## What Was Easier Than Expected

## Bugs That Failed Silently

Defects found in this phase that produced no error — the class `docs/PLAN/16` exists to catch. How each was found.

## Risks

New or changed entries for `docs/PLAN/22-RISK-REGISTER.md`.

## Readiness for the Next Phase

Gate status, open P0 tasks, and anything the next phase must know first.
