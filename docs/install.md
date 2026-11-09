# Install

This guide takes a fresh clone to a working deployment on your own Supabase project and Vercel
account. Each step ends with a check you can run. Budget about an hour the first time, most of it in
the Supabase and Meta consoles.

Want to look first? `npm run demo` runs the whole product on sample data with no accounts (see the
[README](../README.md#quickstart)).

[configuration.md](configuration.md) lists every variable, generated from the schema in
`src/config/env.ts`. This page names the ones each step needs.

## 1. Prerequisites

| Need | Why |
|---|---|
| Node.js 24 and npm | the app, scripts and tests (`engines` in `package.json`) |
| A Supabase project | Postgres warehouse, Auth (owner sign-in), Row Level Security |
| A Meta app and a System User token with `ads_read` for one ad account | reading delivery data; the dashboard and the outcome pages need it |
| One owner email address | the only account allowed to sign in |
| The Supabase CLI (nothing to install) | applying the schema and the local stack: `scripts/sb.sh` runs a pinned version with `npx --yes supabase@2.109.1`, fetched on first use |
| Optional: a business-outcome source | CSV files, a system that can send a signed webhook, or Acuity Scheduling |
| Optional: an AI provider | chat, creative and competitor analysis; every report works without one |
| Optional: a GA4 property and a service-account key | web telemetry |
| Optional: Docker | a local Supabase stack and the full test gate |

## 2. Clone and run setup

```bash
git clone https://github.com/geovannig1/maxx.git
cd maxx
npm ci
npm run setup
```

`npm run setup` writes `.env.local` (mode 600) and is safe to re-run: it keeps every value and
comment you already have and asks only for what is missing (secrets with hidden input). It:

- generates the internal secrets `CRON_SECRET` and `PAID_TOUCH_TOKEN_SECRET`;
- asks for the Supabase URL and keys, the owner email, the Meta token and ad account, the business
  name, timezone and currency, and the AI provider (the Claude key only for `anthropic`). Supabase and
  the owner email are required. The Meta token and ad account are needed before the dashboard or the
  outcome pages open (outcome sources belong to the ad account the first Meta sync stores), so Enter
  there only postpones them; the rest is optional;
- validates each value live: Supabase is reachable and its Auth settings are safe, the Meta token has
  `ads_read` and can read the ad account (whose timezone and currency must equal yours), and the AI
  configuration is valid;
- offers to apply the database schema, creates the owner user and records `OWNER_USER_ID`.

It never prints a secret. In CI or without a terminal it takes values from the environment and
prints nothing unless something fails (`--yes` forces this). Its options:

| Option | Effect |
|---|---|
| `--apply-schema` | Apply `supabase/migrations` with `supabase db push --db-url` through the pinned CLI (needs `SUPABASE_DB_URL`) |
| `--local` | Start a local Supabase stack (needs Docker running) and write its URL and keys into `.env.local` |
| `--offline` | No network: skip validation and owner creation |
| `--live` | Also test the AI key with one minimal call |
| `--yes` | Non-interactive |

Exit codes: 0 done, 1 something needs attention (listed), 2 usage error.

**Check:** this reports the configuration without touching the network:

```bash
npm run doctor -- --offline
```

## 3. Supabase

1. Create a project at supabase.com. From **Project Settings → API** copy the project URL
   (`NEXT_PUBLIC_SUPABASE_URL`), the anon or publishable key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) and the
   service-role key (`SUPABASE_SERVICE_ROLE_KEY`). The service-role key bypasses Row Level Security
   and is the whole authorization boundary ([security-model.md](security-model.md)): it goes only
   into `.env.local` and your host's environment.
2. **Apply the schema.** Either let setup do it (the connection string is never saved; its password
   reaches the Supabase CLI in `PGPASSWORD`, not on the command line):

   ```bash
   SUPABASE_DB_URL="<connection string from Project Settings → Database>" npm run setup -- --apply-schema
   ```

   or use the pinned Supabase CLI directly:

   ```bash
   npx --yes supabase@2.109.1 link --project-ref <your-project-ref>
   npx --yes supabase@2.109.1 db push
   ```

3. **Lock sign-in down.** In **Authentication → Sign In / Providers**, turn **off** "Allow new users to
   sign up" and keep **"Confirm email" on**. The app never creates users, but only this project
   setting stops a stranger registering, and the owner check relies on confirmed emails.
   `supabase/config.toml` sets the same for a local stack only; it is never applied to a hosted
   project, so set these in the dashboard.
4. **Allow the sign-in redirect.** Sign-in is by magic link. The link returns to
   `<your URL>/auth/callback?next=<page>`, and Supabase sends it there only when the URL matches the
   Site URL or a Redirect URL; otherwise it falls back to the Site URL and you land on `/login`
   without a session. An exact entry never matches because of the `?next=` query, so use the `/**`
   wildcard. In **Authentication → URL Configuration**, set the Site URL to your deployment's URL
   (for example `https://maxx.example.com`) and add `https://maxx.example.com/**` to the Redirect URLs.
   For local work against a hosted project, also add `http://localhost:3000/**` (and
   `http://127.0.0.1:3000/**` if you open that address).

**Check:** the doctor reads the project's Auth settings (it must find sign-ups disabled and email
confirmation on), checks that the project is reachable and that the schema is applied:

```bash
npm run doctor -- --only=supabase
```

**Local alternative:** run everything on your machine with Docker instead of a hosted project:

```bash
npm run setup -- --local
```

It starts a local Supabase stack with every migration applied, writes its URL
(`http://127.0.0.1:54321`) and keys into `.env.local` itself (it prints where, never a key), and asks
for the rest. The local stack also serves Supabase Studio at http://127.0.0.1:54323 and **Mailpit**, an
inbox for every email the stack sends, at http://127.0.0.1:54324: the magic link to sign in arrives
there, not in a real mailbox. `supabase/config.toml` allows sign-in redirects back to both
`http://localhost:3000` and `http://127.0.0.1:3000`.

If setup cannot read the keys, copy them by hand: run

```bash
bash scripts/sb.sh status -o env
```

and put `API_URL` in `NEXT_PUBLIC_SUPABASE_URL`, `ANON_KEY` in `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
`SERVICE_ROLE_KEY` in `SUPABASE_SERVICE_ROLE_KEY` (that output prints the keys; keep it out of shared
logs). `scripts/sb.sh` is a thin wrapper around `npx --yes supabase@2.109.1` that runs outside the
project root, so the CLI never reads `.env.local`.

To stop the local stack and delete its data (the Docker containers and volumes):

```bash
bash scripts/sb.sh stop --no-backup
```

Without `--no-backup` the data is kept for the next `npm run setup -- --local`.

## 4. Owner

Maxx has exactly one user: the owner. Set `OWNER_EMAIL` to that address. `npm run setup` creates the
user (confirmed, magic-link sign-in) through the Supabase Auth admin API and writes its id to
`OWNER_USER_ID`.

To do it by hand: **Authentication → Users → Add user**, create the user with "Auto Confirm User",
then copy its id into `OWNER_USER_ID`. With `OWNER_USER_ID` set, production also requires the
signed-in user to have that id, so a second account holding the owner address is refused. An unset
`OWNER_EMAIL` denies everyone, in development too.

**Check:** the owner exists, is confirmed and matches `OWNER_USER_ID`:

```bash
npm run doctor -- --only=owner
```

## 5. Meta

1. At developers.facebook.com create an app of type **Business** and note its **App Secret**
   (`META_APP_SECRET`).
2. In Business Settings → **System Users**, create a system user, assign the ad account with the
   smallest role that works (read access), and generate a token with **`ads_read`**
   (`META_ACCESS_TOKEN`). Add **`ads_management` only if you will enable live writes**
   (`WRITE_MODE_ENABLED=true`); the doctor warns when the token holds it while writes are off.
3. Set `META_AD_ACCOUNT_ID` to `act_` followed by the account number.
4. Set `META_APPSECRET_PROOF_ENABLED=true` **and** turn on **"Require App Secret"** in the app's
   Advanced settings. Every Graph call then carries `appsecret_proof`, so a stolen token is useless
   without the app secret; Meta enforces the proof only when that switch is on.
5. Set `NEXT_PUBLIC_ACCOUNT_TIMEZONE` and `NEXT_PUBLIC_ACCOUNT_CURRENCY` to the ad account's own
   timezone and currency. Reports refuse a mismatch rather than mix two calendars or currencies.
   `NEXT_PUBLIC_ACCOUNT_LOCALE` (default `en-US`, e.g. `de-DE`) sets how numbers, money and dates are
   formatted; it never changes the currency or timezone.
6. For the Conversions API (optional), set `META_PIXEL_ID` and prefer a dataset-scoped token from
   Events Manager (`META_CAPI_ACCESS_TOKEN`) over reusing the ads token.

**Check:** the token's permissions, the account's name, and whether its timezone and currency match:

```bash
npm run doctor -- --only=meta,business
```

## 6. AI provider (optional)

Every report and page works with AI off. With `AI_PROVIDER` unset, Maxx uses Claude through the
Anthropic API when `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) is set, and is off otherwise.

| `AI_PROVIDER` | Needs |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` |
| `bedrock` | `AWS_REGION` (or `AWS_DEFAULT_REGION`); credentials from the AWS credential chain |
| `vertex` | `ANTHROPIC_VERTEX_PROJECT_ID`, Google credentials (`GOOGLE_APPLICATION_CREDENTIALS`), optional `CLOUD_ML_REGION` |
| `foundry` | `ANTHROPIC_FOUNDRY_API_KEY` and `ANTHROPIC_FOUNDRY_RESOURCE` (or `ANTHROPIC_FOUNDRY_BASE_URL`) |
| `openai-compatible` | `OPENAI_COMPATIBLE_BASE_URL` and `AI_MODEL`; `OPENAI_COMPATIBLE_API_KEY` if the server needs one |
| `none` | nothing: AI off |

Defaults, cost and exactly what is sent to the provider are in [ai.md](ai.md). Owner chat also needs
`MAXX_CHAT_ENABLED=true`.

**Check:** the first command validates the configuration; the second adds one minimal model call (a
few tokens):

```bash
npm run doctor -- --only=ai
npm run doctor -- --only=ai --live
```

## 7. Outcome sources

Maxx compares ads with your real business results. Until a source is enabled, reports say "no
outcome source" instead of showing zero. Pick one or more; [outcomes.md](outcomes.md) is the full
reference.

- **CSV:** export results from your system and import them at Settings → Outcome sources → CSV
  import (`/settings/outcomes/import`). No extra variables, but like every outcome source it belongs
  to the ad account, so the page opens once Meta is configured (step 5) and the first sync below has
  stored the account.
- **Signed webhook:** create a source (it returns a signing secret once), point your system or a
  small relay at `/api/outcomes/webhook/<source_id>`, and sign each delivery. Step by step, with
  examples in Node.js, Python and curl: [outcomes.md](outcomes.md#signed-webhook). To also send
  website outcomes to Meta's Conversions API, set `OUTCOME_CONVERSIONS_SEND` (`test` with
  `META_TEST_EVENT_CODE` first, then `true`).
- **Acuity Scheduling (example adapter):** set `ACUITY_USER_ID` and `ACUITY_API_KEY`, then in Acuity →
  Integrations → Webhooks add `https://<your-domain>/api/webhooks/acuity` for appointment
  scheduled, rescheduled, canceled and changed (optionally with `?secret=` and the value of
  `ACUITY_WEBHOOK_SECRET`). Load history with:

  ```bash
  npx tsx --tsconfig tsconfig.scripts.json --env-file=.env.local scripts/backfill-acuity.ts
  ```

  Exact ad-click linking for Acuity uses paid-touch capture: install
  `docs/tracking/acuity-attribution-capture.js` on your website, add a hidden intake field in Acuity,
  and set `PAID_TOUCH_ALLOWED_ORIGINS`, `PAID_TOUCH_ALLOWED_LANDING_HOSTS` and
  `ACUITY_PAID_TOUCH_FIELD_ID` (setup already generated `PAID_TOUCH_TOKEN_SECRET`). The capture
  endpoint stays inert until all four are set. Review the script before installing it on your site.

Enable or disable each source at **Settings → Outcome sources** (`/settings/outcomes`).

**Check:** the sources and which are enabled:

```bash
npm run doctor -- --only=outcomes
```

## 8. Run locally

```bash
npm run doctor
npm run dev
```

Sign in at http://localhost:3000 with the owner email (with the local stack, open the link from
Mailpit at http://127.0.0.1:54324). `npm run dev` listens on every network interface, so other devices
on your network can reach it at the "Network" address it prints; add `-- --hostname 127.0.0.1` to keep
it on this machine. Until the configuration is complete, the app opens the setup checklist (`/setup`)
instead of the dashboard; it runs the same checks as `npm run doctor` and has a "Test connection"
button per integration. Load the first 30 days of Meta data with:

```bash
npm run sync:manual
```

`npm run doctor` exits 0 (no failure), 1 (a check failed) or 2 (usage). `--json` prints one JSON
document, `--offline` skips the network, `--live` adds one minimal AI call, and `--only=` limits it to
some of `runtime`, `supabase`, `owner`, `jobs`, `meta`, `business`, `outcomes`, `ai`, `ga4`, `email`,
`monitoring`.

**Check:** the dashboard shows recent spend, and Settings → Data sources shows the last sync time.

## 9. Deploy to Vercel

1. Use the README's **Deploy to Vercel** button (it asks for `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OWNER_EMAIL`, `CRON_SECRET`,
   `META_ACCESS_TOKEN` and `META_AD_ACCOUNT_ID`), or import the repository with the Next.js preset
   and Node 24.
2. Add the rest of your `.env.local` values as project environment variables (Production). If you
   also set them for Preview, turn on Vercel Deployment Protection so unreviewed branches never run
   against your data. Never commit them.
3. `NEXT_PUBLIC_*` values are built into the browser bundle: after changing one, redeploy.
4. `vercel.json` schedules the daily sync (`/api/cron/daily-sync`, 10:00 UTC) and the midday refresh
   (`/api/sync/midday`, 17:00 UTC). Vercel sends `Authorization: Bearer <CRON_SECRET>` when
   `CRON_SECRET` is set in the project.
5. Add `https://<your-domain>/**` to Supabase's Redirect URLs and make the deployment's URL the Site
   URL (step 3).
6. If you reach the app on a custom domain that is not the project's production domain, set
   `APP_URL` to it; otherwise the Vercel deployment hosts are used for the same-origin check.

**Check:** open `/setup` on the deployment; it lists nothing required as missing. Then run the daily sync
once by hand and expect `200` (replace `maxx.example.com` with your domain). `CRON_SECRET` lives in
`.env.local`, not in your shell, so load the file first:

```bash
set -a; . ./.env.local; set +a
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $CRON_SECRET" https://maxx.example.com/api/cron/daily-sync
```

## 10. Self-hosting elsewhere

Maxx is a standard Next.js application: build it and start it on Node 24 behind a reverse proxy that
terminates HTTPS.

```bash
npm ci
npm run build
npm run start
```

Production mode sets `Secure` cookies and upgrades insecure requests, so plain `http://` will not
keep you signed in. Without `OWNER_EMAIL` nobody can sign in. Three things Vercel does for you become
yours:

- **Scheduling:** call `/api/cron/daily-sync` daily and `/api/sync/midday` once a day with
  `Authorization: Bearer <CRON_SECRET>` from any scheduler (cron, a CI schedule, a cloud scheduler).
- **Client addresses:** the public paid-touch endpoint rate-limits on `X-Forwarded-For`. Set
  `PAID_TOUCH_TRUSTED_PROXY_HOPS` to the number of proxies in front of the app that append to it.
- **Public origin:** set `APP_URL` to the URL your browser uses (for example
  `https://maxx.example.com`). Behind `next start` the server sees every request as `localhost`,
  whatever host the browser used, so without `APP_URL` sign-in redirects point at `localhost` and
  every change is refused as cross-origin (403). Maxx never trusts a client-sent `Host` or
  `X-Forwarded-Host` for this. Keep the proxy forwarding the browser's `Origin` header unchanged.

## 11. Optional integrations

- **GA4:** create a service account, grant it Viewer on the property, put the JSON key on one line in
  `GA4_SERVICE_ACCOUNT_JSON` and set `GA4_PROPERTY_ID`. `GA4_BOOKING_EVENT` names the event that marks
  an outcome on your website. The website report's Intent and Lead event cards count the events named
  in `GA4_INTENT_EVENTS` and `GA4_LEAD_EVENTS` (comma-separated; defaults `begin_checkout` and
  `generate_lead`, GA4's recommended events); set them to the events your site actually sends. GA4 is
  web telemetry; it is never counted as a business outcome.
- **Email:** set `DAILY_DIGEST_EMAIL_PROVIDER` to `gmail_smtp` (with `GMAIL_SMTP_USER` and a Gmail
  App Password in `GMAIL_SMTP_APP_PASSWORD`) or `resend` (with `RESEND_API_KEY`), plus
  `DAILY_DIGEST_FROM_EMAIL`. The weekly executive email also needs
  `MAXX_WEEKLY_EXECUTIVE_EMAIL_ENABLED=true`.
- **Sentry:** `SENTRY_DSN` (server) and `NEXT_PUBLIC_SENTRY_DSN` (browser, at build time). Source-map
  upload needs `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` at build time.
- **MCP server:** `npm run mcp:dev` starts a stdio Model Context Protocol server with read-only
  warehouse tools. Register it in your MCP client with the repository as the working directory. It
  reads `.env.local`, so any MCP client you connect holds the service-role key.

## 12. Before you rely on it

Work through the deployment checklist in [security-model.md](security-model.md#deployment-checklist),
then run the doctor; it must report no failures:

```bash
npm run doctor
```

## Troubleshooting

**The magic link opens `/login` again, not signed in.** The link's redirect did not match the Site URL
or a Redirect URL, so Supabase used the Site URL. Add `<your URL>/**` (with the wildcard) to the
Redirect URLs (step 3). Locally, open the app at http://localhost:3000 or http://127.0.0.1:3000; both
are allowed by `supabase/config.toml`.

**No sign-in email arrives.** With the local stack, emails never leave your machine: open Mailpit at
http://127.0.0.1:54324. With a hosted project, check the spam folder and Supabase → **Authentication →
Logs**.

**"Too many requests" / the login button stays disabled.** The login page allows two links an hour
per browser, matching the hosted project's built-in email service (2 emails an hour for the whole
project). Wait for the time it shows, or reset the page's own counter by clearing this site's stored
data in the browser (it is kept in local storage). Supabase limits sending on its side too: the local
stack allows 10 an hour (`[auth.rate_limit] email_sent` in `supabase/config.toml`, local only; restart
the stack after changing it); a hosted project allows 2 an hour until you configure custom SMTP in
**Authentication → Emails → SMTP settings**, after which you can raise the limit under **Rate Limits**.

**A port is already in use.** `npm run dev` uses 3000 (`npm run dev -- --port 3005` moves it; add the
new origin, for example `http://localhost:3005/**`, to the Redirect URLs). `npm run demo` uses 3000 to
3003 and names a busy port (`npm run demo -- --port 4000`). The local Supabase stack uses 54321 to
54324 and 54327; another local Supabase project on the same ports must be stopped first.

**The Supabase CLI fails to start the stack.** Start Docker and try again. The CLI is fetched by
`npx` on first use, so the first run needs network access. `REFUSING: process … is already using the
local Supabase workspace` means another `scripts/sb.sh` command is still running.

**Behind a reverse proxy, sign-in redirects to `localhost` or every change is refused with 403.**
Set `APP_URL` to the address your browser uses (for example `https://maxx.example.com`) and make sure
the proxy passes the browser's `Origin` header unchanged ([step 10](#10-self-hosting-elsewhere)).

