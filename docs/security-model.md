# Security model

Read this before you deploy Maxx anywhere reachable from the internet.

## What Maxx is, in security terms

A single-owner web application with full read access to one Meta ad account, the business-outcome
sources you connect (CSV imports, signed webhooks, optionally an Acuity account) and one GA4
property, storing their data in a Postgres database that it accesses with a service-role key. It can optionally write to the ad account. The attacker you should think about
is anyone who can reach the deployed URL, anyone who obtains a token, and any code or data that
flows in from the integrated services.

## Authorization boundary

1. **Sign-in**: Supabase Auth magic links. **Disable public sign-ups in your Supabase project.**
   The app never creates users, but the login page's `shouldCreateUser: false` runs in the browser
   and is not a control; only the project setting stops someone registering.
2. **Owner gate**: `src/proxy.ts` runs on every request. Pages redirect to `/login` without a
   session and refuse any session whose email is not `OWNER_EMAIL` or whose email is not confirmed
   (`email_confirmed_at`). API routes return 401/403. An unset `OWNER_EMAIL` denies everyone, in
   development as well (a dev server can be reachable from other machines). Route handlers and pages repeat the check (`ownerOnly(user)`, `requireOwner()`) so a
   route cannot be exposed by a proxy misconfiguration alone. The confirmation check does not help
   if your project auto-confirms emails, which is why disabling sign-ups is required. Set
   `OWNER_USER_ID` (`npm run setup` records it when it creates the owner) to pin the owner to one
   Supabase user id as well: in production the gate then also requires `user.id` to match, and a
   malformed value denies everyone. A second account that holds the owner address is then refused.
3. **Session cookies**: the session cookies the server writes are `HttpOnly`, `SameSite=Lax`,
   `Secure` in production and expire after 7 days of inactivity (`src/lib/supabase/cookie-options.ts`),
   so page scripts cannot read the session. Only the PKCE verifier cookies used during a magic-link
   sign-in stay script-readable. They are not short-lived: the auth library writes them with a 400-day
   max-age. The callback deletes them when it exchanges the code; a link that is never clicked leaves
   its verifier behind until the next sign-in or sign-out. A verifier alone cannot create a session. Sign-out is `POST /auth/signout`, same-origin only; it
   revokes the session server-side and clears every auth cookie. Production mode assumes HTTPS:
   cookies are `Secure` and the CSP upgrades insecure requests whenever `NODE_ENV=production`, so
   `next start` over plain `http://` (other than `localhost` in Chromium) will not keep you signed
   in. Use `npm run dev` for local work.
4. **Machine endpoints**: `/api/cron/*` and `/api/sync/midday` require
   `Authorization: Bearer <CRON_SECRET>` (constant-time compare, 503 when unconfigured).
   Both webhooks first apply a per-address, in-process limit (no database, no HMAC; 300/min for
   Acuity, 600/min for outcome sources; IPv6 by /64) so an unauthenticated flood costs no query.
   `/api/webhooks/acuity` verifies Acuity's HMAC-SHA256 over the raw body with your API key,
   bounds the body to 64 KB, and optionally requires `?secret=`. Acuity's webhook settings accept only
   a URL, so that secret travels in the query string and can appear in proxy or platform access logs;
   rotate it if those logs are exposed. Acuity's signature has no timestamp, so a captured signed
   delivery can be replayed at any time; a replay only re-reads the appointment's current state from
   the Acuity API and never sends a second Conversions API event.
   `/api/outcomes/webhook/<source id>` (exact pattern in `src/proxy.ts`) verifies
   `x-maxx-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>` with the source's own
   secret (32 random bytes, stored only in the service-role table `outcome_source_secrets`, returned
   once on creation or rotation with `Cache-Control: private, no-store`; the sources screen shows it in
   a dialog whose state is discarded on close, and never logs or stores it), refuses timestamps more than 5 minutes off, refuses a replayed
   digest (`outcome_webhook_deliveries`, pruned after an hour), bounds the body to 32 KB, validates
   it with a strict schema, rate-limits per source, and refuses (422) an outcome in another currency
   than the ad account's or above `OUTCOME_MONEY_CEILING`. An unknown or disabled source and a wrong
   signature all return the same 404 after the same work, so a probe cannot tell which ids exist.
   A delivery's optional `attribution.paid_touch_token` links the outcome to an ad click only after
   its HMAC verifies with `PAID_TOUCH_TOKEN_SECRET` and the link RPC confirms the account, expiry,
   click-before-outcome order and website origin; a token that fails is ignored (the sender sees only
   `paid_touch: "rejected"`, the reason is recorded for the owner), and the token is never stored,
   only its hash on the link.
5. **The one public endpoint**: `/api/attribution/paid-touch` is called by anonymous visitors of
   your website. It enforces an exact https origin allowlist, a database-backed rate limit, a 16 KB
   body cap, a strict schema and a sole-active-account check, and it never emits a conversion. It
   returns 503 until all four `PAID_TOUCH_*` values are configured. Its rate limit keys on the
   client address taken from `X-Forwarded-For` (`PAID_TOUCH_TRUSTED_PROXY_HOPS`, default 1), so it
   assumes a reverse proxy such as Vercel that appends the real client address last. Only when
   `X-Forwarded-For` is absent does it fall back to `X-Real-IP`, and then to one shared bucket. IPv6
   clients are bucketed by their /64, since one client controls the whole prefix. Exposed directly to
   the internet, both headers are attacker-controlled; a global cap (default 2,000 captures and 4,000
   acknowledgements per hour across all clients, `PAID_TOUCH_GLOBAL_CAPTURES_PER_HOUR` /
   `PAID_TOUCH_GLOBAL_ACKS_PER_HOUR`) still bounds what a forger can write. Put a proxy in front
   anyway. A capture naming a Meta ad id that is not a synced ad of the active account (an ad launched
   since the last sync, or a forged id) is kept, but first spends a separate, smaller site-wide bucket
   (default 200 per hour, `PAID_TOUCH_UNKNOWN_AD_CAPTURES_PER_HOUR`) before any write, so forged ids
   cannot fill the main capture budget and a new ad's first landings are not lost. The origin allowlist is a browser guard, never authentication: any client can forge
   `Origin`, which is why captured touches are treated as claims (below).

   **Storage growth.** Every accepted capture appends a capture attempt, its outcome events, a touch
   observation and a token digest (a few hundred bytes each; these tables are append-only). At the
   default global cap a forger can add at most about 48,000 captures a day. Rows that never became
   evidence (rejected attempts, and touches and expired tokens that no outcome link, link evaluation,
   eligibility input or delivery references) are deleted by the daily sync after
   `PAID_TOUCH_RETENTION_DAYS` (default 180, at least 30) through the service-role-only
   `prune_unlinked_paid_touch_rows()` function, the only path the append-only guard lets delete.
   Anything that became evidence is kept. Lower the global caps if your traffic is far below them.
6. **Browser mutations are same-origin only.** `src/proxy.ts` refuses any non-GET `/api/*` request
   that carries a cross-site or same-site `Sec-Fetch-Site` or a foreign `Origin`, and in production
   one that carries neither header. The state-changing manual sync (`GET /api/sync/midday`) applies
   the same check in its handler.
7. **Pages check the owner themselves.** Every server-rendered dashboard page calls
   `requireOwner()`; the layout alone is not a boundary because Next.js does not re-run layouts on
   client-side navigation. Client-rendered pages fetch their data only through the gated `/api/*`
   routes. The gate fails closed whenever `OWNER_EMAIL` is unset, in every environment, so there
   is no configuration that runs it open.

## Database access model

The application talks to Postgres with the **service role**, which bypasses Row Level Security.
RLS is enabled on every table, the browser-facing `anon` and `authenticated` roles hold no
privilege on any table, sequence or function, and no row-level policy names them, so a leaked anon
key reads nothing (`tests/db/schema-db.test.ts` asserts all three on the shipped schema).
Modules that hold a server secret start with `import 'server-only'`, so the build fails if browser
code imports one, and `tests/client-server-boundary.test.ts` walks every client import graph. The consequence is
that **the owner gate is the only authorization layer**: if you add a second Supabase user, or run
server code outside the gate, that code has full access. This is acceptable for one owner on their
own deployment and unsuitable for shared or multi-tenant use.

## Live writes

`WRITE_MODE_ENABLED=true` turns on the executor in `src/lib/writes`. Even then every write is a
change request with a dry-run preview, a before-state and a risk label that the owner approves in
the app, and `scripts/assert-no-meta-writes.sh` is part of `npm run release:check`. Leave it off
unless you need it, and give the Meta token `ads_management` only when you do.

The owner-initiated change surface ([ADR-059](architecture/adr-059-owner-initiated-changes.md)) adds
three cookie-session mutations, each with the owner check and the same-origin check in its own
handler (and in `src/proxy.ts`):

| Route | What it does | What it never does |
|---|---|---|
| `POST /api/changes` | Creates a PENDING owner change request from a current `owner_review` or `execution_eligible` decision, after the account, ownership, currency, live-state, budget ceiling and per-step (`MAX_BUDGET_CHANGE_PERCENT`) checks | Approve or apply anything; accept a `diagnostic_only` decision |
| `PATCH /api/changes/[id]` | `approve`, `reject`, `execute`, `approve_and_apply` or `recover`. Idempotent on a double click; refuses to approve an expired request. `maxDuration` is 300 s | Apply anything while `WRITE_MODE_ENABLED` is off; `recover` a run younger than `CHANGE_RECOVERY_STALE_MINUTES` |
| `POST /api/changes/[id]/rollback` | Creates a PENDING inverse of an executed pause, activate or budget change | Apply the rollback |

Campaign plans ([ADR-062](architecture/adr-062-campaign-plans.md)) add a creation surface. Every
route is owner-only, same-origin, per-owner rate-limited and size-capped:

| Route | What it does | What it never does |
|---|---|---|
| `POST /api/campaigns/plans` | Drafts a plan from a brief (one planning and one copy model call when AI is on) and stores it as a draft version | Touch Meta, submit or approve |
| `POST /api/campaigns/plans/[planId]/versions` | Stores an owner edit as a new, re-validated version | Change a submitted version (versions are immutable) |
| `POST /api/campaigns/plans/[planId]/submit` | Re-validates the draft and creates a PENDING `create_campaign_paused` change request | Approve or create anything |
| `PATCH /api/changes/[id]` on a plan request | Approves, and with `WRITE_MODE_ENABLED=true` creates every object **PAUSED** (resume on retry); in demo mode simulates | Set any object ACTIVE; run with write mode off |
| `POST /api/changes/[id]/rollback` on a plan request | Proposes archiving exactly the objects the creation recorded | Archive before you approve it |

The database refuses a plan request that is not owner-initiated, that carries an ActionDecision,
whose params differ from what the RPC derives from the version, or whose version was not submitted;
version content and request lineage are frozen. The payload builder refuses any Meta body whose
status is not PAUSED. Creation needs the token's `ads_management` permission, like every live write.

What a creation may touch is bound to that one request. Every object name carries a marker derived
from the plan version and change request ids (`mx` + 12 hex of their sha256 + the plan key); the
database recomputes it on every `campaign_plan_objects` row, and a Meta id can be held by one row per
account only (`uq_campaign_plan_objects_meta_id`). A resume that finds an object by its marker takes
it only when it reads back PAUSED with exactly that marker, and never changes its status; anything
else stops the run (`FOUND_OBJECT_INTEGRITY`). A rollback archives only objects recorded under its
original request's markers. Validation also requires the account's configured currency
(`NEXT_PUBLIC_ACCOUNT_CURRENCY`) to equal the ad account's, the conversion pixel to be the account's
own pixel and a video thumbnail to be one of the synced creative thumbnails, and it re-runs before
creation. The approval preview lists every value sent to Meta (copy, call to action, link, media,
thumbnail, URL parameters, pixel and event). A failed creation cannot resume while its rollback is
pending or approved.
The Ask Maxx chat can, for the signed-in owner only, draft a plan, write scored copy and create a
PENDING proposal from a decision shown in the same turn; it has no path to the review RPC or an
executor. The MCP server only reads plans (`get_campaign_plans`, `preview_campaign_plan`).

The database enforces the initiator: an `owner_review` decision can back only a request with
`initiated_by = 'owner'` (created by the service-role-only `create_owner_change_request`, which
records the owner's user id), and only such a request lets that decision be approved. An agent
request keeps the `execution_eligible` and exact-mutation rules. For an owner budget change whose
before-state holds the live budget, the database also repeats the decision's direction and the
per-change step limit (the limit the RPC was given, 50% when none; any step from a zero budget needs
the recorded override).

**The service role is the trust boundary for the owner's identity.** The SECURITY DEFINER RPCs
(`create_owner_change_request`, `create_campaign_plan_version`, `create_campaign_plan_change_request`)
record the owner user id they are given; the database holds no owner identity to compare it with
(the owner is `OWNER_EMAIL`/`OWNER_USER_ID` in the server environment). The check therefore sits at
one TS entry: every call goes through `callOwnerRpc` (`src/lib/writes/owner-rpc.ts`), which refuses an
id that is not the pinned `OWNER_USER_ID` (trimmed, case-insensitive, as the owner gate compares it)
before the database is reached, and a test fails if any module calls these RPCs directly. Whoever
holds the service-role key can still call them directly and create an owner-labelled request;
approving and applying it still goes through the owner session, write mode and the executor.

Execution is serialized per account by an `action_log` row in status `executing`. Each run re-reads
its request after taking that lock and finalizes the request by compare-and-set from the status it
began with, and a trigger keeps `change_requests.status` on governed edges (`executed`, `rejected`
and `expired` are terminal; `failed -> executed` only for a campaign-plan resume or retry). A run that
crashes leaves the lock behind: a later write is refused with the stuck change named, and the owner
uses **Recover stuck change** on /changes once the run is older than `CHANGE_RECOVERY_STALE_MINUTES`
(default 15). Recovery records the outcome as unknown (an ADR-059 change stores Meta's live state, a
plan its created objects and a failed version) before it releases the lock; it never re-applies
anything. On a self-hosted `next start` with no request time limit, raise the threshold above your
longest expected run. Meta's answers to a write are stored and returned only trimmed and redacted
(`safeWriteResponse`). In demo mode the approval runs a simulated executor on the sample database;
demo mode is refused in production and on Vercel.

## Secrets

- Only `.env.local` (git-ignored, mode 600) and your host's environment hold secrets.
- `appsecret_proof` (`META_APPSECRET_PROOF_ENABLED=true`) means a stolen access token cannot be
  used without the app secret, **provided "Require App Secret" is enabled in the Meta app's
  Advanced settings**; the proof is only enforced server-side when that switch is on. The Meta token travels in the `Authorization` header, never in the
  query string, and the Graph client redacts tokens from logged URLs.
- The MCP server reads `.env.local` directly; treat any MCP client you connect as having the
  service-role key.
- Rotate on any suspicion: Meta token and app secret, Supabase service-role and anon keys,
  `CRON_SECRET`, `PAID_TOUCH_TOKEN_SECRET`, webhook source secrets (no grace period: the old secret
  stops at once), Acuity API key, GA4 service-account key, model keys, email credentials, Sentry
  tokens. Where and how, secret by secret: [operations.md](operations.md#rotating-secrets).

## Inbound data is untrusted

Competitor pages, RSS feeds, Meta creative text, outcome payloads (webhook, CSV, Acuity notes) and
GA4 dimensions are data, never instructions. Prompts that consume them say so explicitly, the learning memory is read-only to
the model, and nothing a model returns is executed. Specifically:

- Model output is rendered as markdown with images and raw HTML disabled, so injected text cannot
  make the browser fetch an attacker's URL; every link goes through `safeHref` (http/https only).
- Structured model output (competitor ad analysis) is schema-validated before it is stored.
- Meta's Ad Library returns `ad_snapshot_url` with the caller's access token embedded. The token is
  removed before the URL is stored and again whenever it is read (`src/lib/competitors/snapshot-url.ts`);
  the URL is never loaded by the browser or put in a prompt.
- The RSS fetcher resolves every host, including each redirect hop, and refuses private, loopback
  and link-local addresses.

## Response headers and cross-origin mutations

`src/proxy.ts` sends the Content-Security-Policy (built in `src/lib/security/csp.ts`; `next.config.ts`
sends none, so there is never a second, conflicting policy). Every page response gets a fresh 128-bit
nonce: `script-src 'self' 'nonce-…' 'strict-dynamic'`, with no `'unsafe-inline'` for scripts and
`'unsafe-eval'` only in development. Next.js reads the nonce from the request and stamps its own
scripts; the root layout passes it to the theme script. Nonces need per-request rendering, so every
page is dynamic (the root layout reads the request headers). The rest of the policy is `default-src
'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`,
`upgrade-insecure-requests` in production, and `img-src`/`media-src`/`connect-src` limited to the app,
Meta's CDNs, your Supabase URL and your Sentry ingest host. `style-src` keeps `'unsafe-inline'` (and
carries no nonce, which would disable it): server-rendered React `style` attributes and the toast
library's runtime `<style>` cannot carry a nonce, so a CSS-injection payload is not blocked by the CSP;
script injection is. API responses get `default-src 'none'; frame-ancestors 'none'`. Static assets
under `/_next/static` and `/_next/image` bypass the proxy and get no CSP. `next.config.ts` still sends
`X-Frame-Options: DENY`, `nosniff`, a strict referrer policy, a restrictive Permissions-Policy and
HSTS on every response, and omits `X-Powered-By`. `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SENTRY_DSN` must be set at build time or their origins are left out of `connect-src`.
Browser source maps are not published: they are generated only when `SENTRY_AUTH_TOKEN` is set,
uploaded to Sentry, and deleted from the build.

## Known limitations (tracked, not hidden)

- **Paid-touch tokens are claims.** The public capture endpoint refuses an ad id that is not a synced
  ad of the account, but otherwise signs whatever Meta ids the page sends; linking verifies the
  signature, the stored hash and time order. A visitor who books a real appointment can therefore steer the attribution of
  their own booking. Treat per-ad paid-touch attribution as association, which the product already
  does, and keep `ACUITY_CAPI_SEND` off until you are comfortable with the fbclid fallback.
- **Rate limiting is per client address plus a global cap.** Behind a proxy you control, set
  `PAID_TOUCH_TRUSTED_PROXY_HOPS`; without any forwarding header every visitor shares one bucket,
  which protects the database at the cost of capture during a flood.
- **Feed fetches are public-address only.** The RSS fetcher resolves the feed host, refuses any
  private, loopback or link-local address, and connects to the address it checked (the lookup is
  pinned for the connection, `src/lib/signals/feed-fetch.ts`), so DNS rebinding between check and
  connect does not apply. It reads at most 256 KB and 100 items of a feed. Feed URLs come only from
  the seeded `expert_sources` table.
- **The owner still sees some upstream error text, on purpose.** API routes and MCP tools return a
  generic message and a stable code instead of database or provider text, and
  `tests/api-error-population.test.ts` checks every `src/app/api/**/route.ts`, `src/mcp/tools/*.ts`
  and the write executor (whose result is a response body) for the common leak shapes. It is a
  heuristic over those files, not a proof: it does not follow other values built in `src/lib`. The
  daily cron returns only `STEP_FAILED` per failed step; the text goes to the server log and the
  owner-only sync log (`step_errors`). Three owner-only surfaces keep diagnostic text deliberately. The
  result of executing an approved live change includes Meta's response body (its rejection reason),
  never database text. Stored sync-log messages
  appear in the sync and health views. Some library status strings (ROAS reasons, evidence-gate and
  monitoring notes) carry the failure that produced them. Only the owner session, and the model it
  drives, can read them.
- **The MCP process holds the service-role key.** Any MCP client you connect is as trusted as the
  owner.
- **The service-role key is the whole boundary.** Whoever holds it can read every table (including
  the customer details your outcome sources send), mint an owner session through Supabase Auth admin APIs, and, with
  `WRITE_MODE_ENABLED=true`, approve and execute a live change. There is no second factor. Keep the
  key out of every laptop that does not need it, and keep write mode off.
- **`npm audit --omit=dev` still reports 5 moderate advisories, all build-time.** `@sentry/nextjs`
  10.x pulls `@sentry/bundler-plugins` (and `@sentry/webpack-plugin`), which require `glob` `^13.0.6`;
  every 13.x `glob` is inside GHSA-3g3m-2fjr-6pw4 and depends on a `minimatch` 10.x inside
  GHSA-g3hv-75wg-m249. The plugin runs only inside `next build` (`withSentryConfig` in
  `next.config.ts`), where it globs the build output for source maps with patterns from that
  config; it is not loaded by the deployed server or the browser, and it never passes an
  `AbortSignal`. The fixed releases (`glob` 14.0.2+, `minimatch` 11.0.1+, or `@sentry/nextjs`
  11.11.0, whose plugin requires `glob` `^14.0.3`) are outside the plugin's range or a major SDK
  upgrade, and were under 14 days old on 2026-11-07, so no override is applied.
- **ESLint 10 runs ahead of three plugins' declared ranges.** `eslint-config-next` 16.4.3 bundles
  `eslint-plugin-import`, `eslint-plugin-jsx-a11y` and `eslint-plugin-react`, whose peer ranges stop at
  ESLint 9, so npm prints `ERESOLVE overriding peer dependency`. The rules were verified to run under
  ESLint 10 (2026-11-10): a probe file with deliberate violations was reported by `react/*`, `import/*`,
  `jsx-a11y/*` and `@next/next/*` rules. ESLint is a development tool: it is not in the build output or
  the deployed server. Re-check when `eslint-config-next` declares ESLint 10.
- **Maintainers reviewing third-party pull requests** should do so in a checkout with no
  `.env.local`: `npm run gate` runs the production build, which loads that file, so a malicious
  change to a build-time module could read it. The build and tests need no secrets.

## Deployment checklist

- [ ] `OWNER_EMAIL` set; one owner user exists; `OWNER_USER_ID` pinned to that user's id.
- [ ] Supabase **public sign-ups disabled** and **email confirmation on**. Check:
  `npm run doctor -- --only=supabase` reads the project's Auth settings and must report both OK
  (`disable_signup` true, `mailer_autoconfirm` false).
- [ ] `CRON_SECRET` and `PAID_TOUCH_TOKEN_SECRET` are 32+ random bytes.
- [ ] `WRITE_MODE_ENABLED` unset or `false`; the Meta token has `ads_read` only.
- [ ] `META_APPSECRET_PROOF_ENABLED=true`.
- [ ] `ACUITY_CAPI_SEND=off` until the browser and server events share an `event_id`.
- [ ] `OUTCOME_CONVERSIONS_SEND` stays `off` (or `test`) until test events look right in Events Manager.
- [ ] Sentry DSN set so failures page someone; dependency alerts enabled on your fork.
- [ ] `npm run doctor` reports no failures.
- [ ] `CRON_SECRET` is at least 32 characters (shorter values are treated as unset and the cron endpoints answer 503).
- [ ] Every migration in `supabase/migrations` applied (the baseline revokes default privileges
  from `anon`/`authenticated` for future objects).
