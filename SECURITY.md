# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability
reporting on this repository ("Report a vulnerability" under the Security tab). Include the
affected route or module, reproduction steps, and the impact you believe is possible. You will get
an acknowledgement within 5 business days and a fix or mitigation plan within 30 days for confirmed
issues. Credit is given in the release notes unless you prefer otherwise.

## Supported versions

Only the latest release on `main` receives security fixes.

## What is in scope

- Authentication, sessions and the owner gate (`src/proxy.ts`, `src/lib/auth/*`,
  `src/lib/supabase/*`, `/auth/callback`, `/auth/signout`)
- Cron and webhook authentication (`/api/cron/*`, `/api/sync/midday`, `/api/webhooks/acuity`,
  `/api/outcomes/webhook/*`, including the signature, timestamp and replay checks)
- Outcome source management and CSV import (`/api/outcomes/*`)
- The public paid-touch capture endpoint (`/api/attribution/paid-touch`)
- Supabase policies, grants and the service-role boundary (`supabase/migrations/*`)
- Secret handling, logging and error messages, including the server-only boundary
- Rendering of model output and third-party data in the browser (markdown, links, headers)
- Anything that could cause a live write to a Meta ad account without an explicit approval

## Deployment expectations

Maxx is a single-owner tool. The deployment checklist in `docs/security-model.md` (owner email set,
`WRITE_MODE_ENABLED` off, `appsecret_proof` on, strong `CRON_SECRET`, Supabase sign-ups disabled
and email confirmation on)
is part of running it safely; reports about deployments that skip it are still welcome, but the
fix may be a documentation change.
