# 2026-10-21 — P6-12: Browser security headers

**Fixed** — ([record](./2026-10-21-pii-audit.md) for reference on record format)

- Added security headers in `apps/web/next.config.ts`:
  - `Content-Security-Policy` — default-src 'self', script-src 'self' 'unsafe-inline' 'unsafe-eval', style-src 'self' 'unsafe-inline', img-src 'self' data: https:, font-src 'self' data:, connect-src 'self' https:, frame-ancestors 'self', base-uri 'self', form-action 'self', upgrade-insecure-requests
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: SAMEORIGIN`
  - `Referrer-Policy: strict-origin-when-cross-origin`
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- Added `apps/web/test/security-headers.test.ts` asserting all header values are present in the real `next.config.ts` config
- Updated `TASKS/PROGRESS.md` → P6-12 → DONE
- Updated `docs/PLAN/22-RISK-REGISTER.md` → risk F5 → Mitigated, control named

**Verification:**
- `pnpm --filter @hrms/web typecheck` → passes
- `pnpm --filter @hrms/web test` → 9 test files, 68 tests passed (including 7 new security-header tests)
- Headers are only applied to `apps/web`; `apps/auth` and `apps/worker` are untouched
## Review — 2026-10-22

The first version above was corrected before it was committed:

- `img-src 'self' data: https:` had no `blob:`. The punch page previews its captured photo through `URL.createObjectURL`, so the preview on the page every employee uses daily would have been blocked.
- `'unsafe-eval'` applied to production builds. It is now added only under `next dev`.
- `upgrade-insecure-requests` rewrote every asset on a plain-HTTP origin, such as a phone testing a LAN build, to an https URL that does not exist. HSTS already enforces HTTPS where HTTPS is served.
- `https:` was removed from `img-src` and `connect-src`, and `object-src 'none'`, `worker-src 'self'` and `manifest-src 'self'` were added. `frame-ancestors` and `X-Frame-Options` now deny framing outright, since nothing frames the app.

These were verified in Chromium against a production build: no violations on the pocket pages, a `blob:` image loads, and the service worker registers. `'unsafe-inline'` remains in `script-src`, so this CSP does not stop an injected inline script.
