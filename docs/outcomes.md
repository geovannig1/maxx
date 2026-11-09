# Business outcomes

Maxx judges ads against what your business actually recorded: a sale, a lead, a booking, a sign-up.
These records are **outcomes**, and the systems that supply them are **outcome sources**. This page
is the reference for both: the model, how each source behaves, the CSV format, the signed webhook
(with signing code in three languages), and how to write a new adapter.

The design record is [ADR-058](architecture/adr-058-generic-outcomes.md); the code is in
`src/lib/outcomes/`.

## The outcome model

One outcome is one row in the `outcomes` table, identified by its source and your system's own id.

| Field | Meaning |
|---|---|
| `external_id` | Your system's id for the result (order, lead or booking number). Unique per source; sending the same id again updates the same outcome. |
| `outcome_type` | `lead`, `booking`, `sale`, `signup`, `quote`, `subscription` or `custom`. |
| `outcome_label` | Optional product, service or appointment type. |
| `status` | `pending`, `confirmed`, `cancelled` or `refunded`. Only `pending` and `confirmed` are active. |
| `occurred_at` | The instant the result happened. Attribution and conversions use it. |
| business date | `occurred_at` as a calendar date in the account timezone (`NEXT_PUBLIC_ACCOUNT_TIMEZONE`, which must equal the ad account's own timezone). Every daily count uses it. |
| `fulfilment_at` | Optional: when the result is delivered or takes place (an appointment, a delivery). |
| `currency` | ISO 4217 code of the values. |
| `gross_value` | Listed, quoted or invoiced value. |
| `collected_value` | Value actually collected. |
| `origin` | `website`, `staff_or_manual` or `unknown`: whether the result came from your website. |

### Unknown is not zero

Money is stored as an exact decimal. **An empty value means "not observed" and is stored as NULL;
`0` means an observed zero.** The two are never merged:

- **Collected value:** the exact total exists only when every active outcome has a recorded collected
  value. Otherwise it is unavailable, and the recorded part is shown as an observed lower bound with
  its coverage (for example, recorded on 41 of 50 outcomes), never as the total.
- **Gross value:** the total covers outcomes with a positive gross value. Outcomes whose gross value
  is zero or unknown are still counted as outcomes, in their own group; they add nothing to the value
  and are never mistaken for missing outcomes.
- With no outcome source enabled, reports say "no outcome source"; they never show 0 outcomes.

The aggregation is `aggregateOutcomeFacts` in `src/lib/outcomes/facts.ts`.

### Currency

Any ISO 4217 currency works. Send values in the ad account's currency (`NEXT_PUBLIC_ACCOUNT_CURRENCY`,
which must equal the currency Meta reports for the account; `npm run doctor` checks both). Maxx never
converts currencies. A money total that would mix two currencies is refused, not summed, and the
economics ledgers refuse another currency at the database. The CSV import refuses a row in another
currency outright. Owner screens format money in `NEXT_PUBLIC_ACCOUNT_LOCALE` (default `en-US`),
which changes only the formatting. How totals are computed, and their error bound:
[operations.md](operations.md#money-currency-and-arithmetic).

### Which sources count

- Only **enabled** sources count. A disabled source's rows stay stored and are counted nowhere.
  Switch sources on and off at Settings → Outcome sources (`/settings/outcomes`).
- A source Maxx can reconcile against its system (the Acuity example) must prove that the reporting
  window is covered by a recent, complete reconciliation; otherwise the read fails with that source's
  reason, because a missing reconciliation would make an incomplete total look complete.
- A push-only source (the signed webhook) and the CSV import have no completeness proof. Their
  outcomes count **as received**, and reports label them that way.
- The daily sync reconciles only enabled sources whose adapter can reconcile. An install whose sources
  are all push-only reconciles nothing, and its syncs are not marked partial for it.
- Reports state the sources' completeness in `money_basis.source_completeness`: `reconciled`,
  `as_received` (every source is push-only) or `mixed` (reconciled and push-only sources together; the
  report also records the "As received" / "As imported" label of the push-only part).
  `money_basis.revenue_complete` (column `business_revenue_complete`) is a different measure:
  collected-value coverage, true when every active outcome in the window has a recorded collected
  value. It can be true on a push-only report and never means the sources are complete.
- The Meta pixel event that marks an outcome in Meta's Results, actions and tracking health is
  `NEXT_PUBLIC_META_OUTCOME_EVENT` (default `AppointmentConfirmed`, for example `Purchase` or `Lead`).

## Sources

| Source | How data arrives | Origin known | Carries an ad-click token | Sent to Meta as a conversion |
|---|---|---|---|---|
| CSV import | You upload a file on `/settings/outcomes/import` | no (stated, never observed) | no | never |
| Signed webhook | Your system POSTs one outcome per delivery | yes (stated on each delivery) | yes (`attribution.paid_touch_token`; click ids and UTMs too) | only `website` outcomes, when `OUTCOME_CONVERSIONS_SEND` is on |
| Acuity Scheduling (example) | Acuity webhook plus a nightly reconciliation | yes | yes (paid-touch field) | only through its own sender, when `ACUITY_CAPI_SEND` is on |

The capability flags behind this table are declared per adapter in
`src/lib/outcomes/adapters/*/adapter.ts`. Two of them protect the numbers:

- `carriesToken: false` (the CSV import): while such a source is enabled, every paid cohort is marked
  incomplete with `source_cannot_carry_token`, so a source that can never link an outcome to an ad
  can never unlock money authority by being left out of the denominator. A signed webhook can carry
  a token, so it does not block by itself; a webhook outcome sent without one is counted as **not
  linked** to an ad, never left out ([Linking to the ad click](#linking-to-the-ad-click)).
- `originKnown: false` (the CSV import): the stated origin is recorded but never treated as observed,
  so CSV outcomes are never sent to an ad platform.

## CSV import

Open **Settings → Outcome sources → CSV import** (`/settings/outcomes/import`). Choose an existing CSV
source or name a new one, upload the file, review the preview (every row classified as new, changed,
unchanged or invalid), then import. Nothing is written until you import, and the import is
all-or-nothing: a file with any invalid row is refused as a whole. The screen renders the same column
contract as below from `src/lib/outcomes/adapters/csv/contract.ts`, and offers it as a template.

### Columns

The first row is the header. Header names match case-insensitively; surrounding spaces are ignored.
The four required columns must be present and filled on every row. Optional columns may be left out
entirely or left empty. **A column not listed here is refused**, so a misspelt column is never
silently dropped.

| Column | Required | Format |
|---|---|---|
| `external_id` | yes | Your id for the result. Unique within the file; importing the same id again updates the outcome. Up to 256 characters, no leading or trailing spaces. |
| `outcome_type` | yes | `lead`, `booking`, `sale`, `signup`, `quote`, `subscription` or `custom`. |
| `status` | yes | `pending`, `confirmed`, `cancelled` or `refunded`. |
| `occurred_at` | yes | `2026-03-08T14:30:00Z`, `2026-03-08T14:30:00-05:00`, or a date alone (`2026-03-08`), read as the start of that day in the account timezone. A time without `Z` or an offset is refused. |
| `currency` | no | ISO 4217 code; must be the ad account currency. Empty means the account currency. |
| `gross_value` | no | Exact decimal with a point (`120.50`): no currency symbol, sign or thousands separator. Empty means not known; `0` means zero. |
| `collected_value` | no | Same format. Empty means not known; `0` means nothing was collected. |
| `fulfilment_at` | no | Same formats as `occurred_at`. |
| `origin` | no | `website`, `staff_or_manual` or `unknown` (the default). Recorded as stated; never sent to an ad platform. |
| `outcome_label` | no | Product, service or appointment type. Up to 256 characters. |
| `fbclid`, `gclid`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` | no | Kept for diagnostics; up to 512 characters each. |
| `landing_page`, `referrer` | no | Kept for diagnostics; up to 2,048 characters each. |

Customer details (name, email, phone) are not accepted: a CSV outcome is never sent to an ad
platform, so Maxx has no use for them.

### Rules and limits

- RFC 4180: fields separated by commas, records by CRLF, LF or CR; a field in double quotes may
  contain commas, line breaks and `""` for one quote. Text after a closing quote is refused. A UTF-8
  byte-order mark is removed; blank lines are skipped.
- At most 4 MiB and 10,000 data rows per file (split larger histories into several files).
- Re-importing an identical row changes nothing and records no new observation, so importing the
  same file twice gives identical counts.
- The preview and import are owner-only and rate-limited (60 previews and 30 imports per owner per
  hour). The import must name the SHA-256 of the file you previewed.
- Error messages name the row and column, never the cell's value.

### Sample file

```csv
external_id,outcome_type,status,occurred_at,currency,gross_value,collected_value,fulfilment_at,origin,outcome_label
ORDER-1001,sale,confirmed,2026-03-08T14:30:00Z,,120.50,120.50,,website,Gift card
LEAD-2002,lead,pending,2026-03-09,,,,,unknown,Quote request
```

The second row shows the difference between unknown and zero: its values are empty, so they are
stored as "not observed", not as 0.

## Signed webhook

Any system that can make an HTTPS request can push outcomes: a shop's order webhook, a CRM
automation, a form handler, or a small relay you write. Each delivery carries **one outcome, in its
full current state**. Send it again whenever the outcome changes (confirmed, cancelled, refunded,
new value).

### 1. Create a source and its secret

Sign in as the owner and open **Settings → Outcome sources** (`/settings/outcomes`). Under **Add a
signed webhook**, enter a name and choose **Create webhook source**. Leave **Turn on now** unticked to
create it switched off; switch it on in the list when your sender is ready.

A dialog then shows the source's **signing secret**, its endpoint
(`POST https://<your deployment>/api/outcomes/webhook/<source_id>`) and the signature header format.
**The secret is shown this once**: copy it (the **Copy secret** button) into your sending system's
secret store before you close the dialog. Closing it discards the secret; nothing returns it again.
It is 32 random bytes as 64 hexadecimal characters, and the HMAC key is that string's UTF-8 bytes
(use the string as is; do not hex-decode it). The list shows each webhook source's endpoint.

The screen uses the owner-only route `POST /api/outcomes/webhook-sources` (`{ "label": "Online shop",
"enabled": false }`); a script signed in as the owner can call it the same way, same-origin. Its
`201` response holds `source_id`, `secret`, `path` and `signature_header`, and is never cached.

### 2. Rotate the secret

In the list, choose **Rotate secret** on the webhook source and confirm. The dialog shows the new
secret once, as above. The route behind it is `POST /api/outcomes/webhook-sources/<source_id>/rotate`
(response `{ source_id, secret }`).

**There is no grace period.** The old secret stops verifying the moment the rotation commits, so a
delivery signed with it gets `404`. Rotate when your sender can be updated straight away, or pause
the sender first, rotate, update it, and resume. Deliveries refused during the switch are not stored;
send them again, signed with the new secret. Rotate at once if the secret may have leaked.

### 3. Sign each delivery

```
POST /api/outcomes/webhook/<source_id>
content-type: application/json
x-maxx-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>
```

- `t` is the current Unix time in seconds. Deliveries more than **5 minutes** from the server's clock,
  in either direction, are refused. Keep the sender's clock synchronized.
- `v1` is the lowercase hexadecimal HMAC-SHA256 of the string `t`, a full stop, and the **exact bytes
  of the body you send**. Sign the serialized body, then send those same bytes; re-serializing after
  signing breaks the signature.
- The timestamp is inside the MAC, so it cannot be changed without the secret.
- **Replay:** a delivery whose signature Maxx has already accepted is refused with `409 REPLAY`. To
  send the same outcome again, sign it again (a new `t` gives a new signature).

### 4. The payload

```json
{
  "external_id": "ORDER-1001",
  "outcome_type": "sale",
  "outcome_label": "Gift card",
  "status": "confirmed",
  "currency": "USD",
  "gross_value": "120.50",
  "collected_value": "120.50",
  "occurred_at": "2026-03-08T14:30:00Z",
  "origin": "website",
  "attribution": {
    "fbclid": "IwAR-example",
    "fbp": "fb.1.1709900000000.1234567890",
    "utm_source": "facebook",
    "utm_campaign": "spring-sale",
    "landing_page": "https://www.example.com/shop",
    "paid_touch_token": "pt1.00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  },
  "customer": { "email": "customer@example.com" },
  "event_id": "order-1001-purchase",
  "updated_at": "2026-03-08T14:31:05Z"
}
```

| Field | Required | Rule |
|---|---|---|
| `external_id` | yes | 1-256 characters, no leading or trailing spaces. |
| `outcome_type` | yes | `lead`, `booking`, `sale`, `signup`, `quote`, `subscription`, `custom`. |
| `status` | yes | `pending`, `confirmed`, `cancelled`, `refunded`. |
| `currency` | yes | Upper-case ISO 4217 code. |
| `occurred_at` | yes | ISO 8601 date-time with `Z` or an offset. |
| `origin` | yes | `website`, `staff_or_manual`, `unknown`. |
| `gross_value`, `collected_value` | no | Exact decimal **string** (`"120.50"`): at most 15 integer digits without leading zeros and 6 fraction digits, no sign. Absent or `null` means not observed; `"0"` is an observed zero. A JSON number is refused. |
| `outcome_label` | no | Up to 256 characters. |
| `fulfilment_at` | no | ISO 8601 date-time with an offset. |
| `fulfilment_status` | no | `scheduled`, `fulfilled`, `no_show`. |
| `attribution` | no | Object with any of `fbclid`, `fbc`, `fbp`, `gclid`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term` (up to 512 characters; `fbc` 600, `fbp` 256), `landing_page`, `referrer` (up to 2,048) and `paid_touch_token` (exactly the token Maxx issued, 84 characters; see [Linking to the ad click](#linking-to-the-ad-click)). |
| `customer` | no | Object with any of `email`, `phone`, `first_name`, `last_name`. Stored in the `outcomes` table (service role only); hashed with SHA-256 before anything is sent to Meta. |
| `event_id` | no | The conversion event id your own browser pixel uses for this result, so Meta deduplicates the pixel event and Maxx's server event. ASCII letters, digits and `. _ : -`, at most 100 characters, and never starting with `maxx-` or `acuity-`. Without it Maxx uses `maxx-<outcome uuid>`. Once set, or once a conversion was sent, it cannot change (`409 EVENT_ID_CHANGED`); omitting it later keeps the stored one. |
| `updated_at` | no | Your system's version time for this outcome. A delivery with an **older** `updated_at` than the stored one is accepted but not applied (`applied: false`). Without it, deliveries apply in arrival order (last write wins). |

Any other key, at the top level or inside `attribution` or `customer`, is refused (`400
INVALID_PAYLOAD`), so a misspelt field is never silently dropped. The body may be at most 32 KB.

### 5. Responses

| Status | `code` | Meaning | What to do |
|---|---|---|---|
| 200 | - | `{ ok: true, applied: true, outcome_id, external_id, conversion, paid_touch }` | Done. `conversion` is `not-applicable`, `off`, `sent`, `already_sent`, `skipped-<reason>`, `error` or `accepted_unrecorded`. `paid_touch` is `linked`, `absent`, `rejected`, `not_configured` or `error` ([Linking to the ad click](#linking-to-the-ad-click)). |
| 200 | - | `{ ok: true, applied: false, reason: "older_than_stored", … }` | Older than the stored state (`updated_at`); nothing changed (`paid_touch: "not-applicable"`). |
| 400 | `BODY_UNREADABLE` | The body could not be read. | Fix the sender. |
| 400 | `INVALID_PAYLOAD` | The body is not valid JSON or breaks a rule above; `fields` names the offending fields (never their values). | Fix the payload; do not retry unchanged. |
| 401 | `SIGNATURE_MALFORMED` | The `x-maxx-signature` header is missing or malformed. | Fix the signing code. |
| 401 | `SIGNATURE_STALE` | `t` is more than 5 minutes from the server clock. | Sync the clock; re-sign and resend. |
| 404 | `NOT_FOUND` | Unknown source, disabled source, or a signature that does not verify. These are deliberately indistinguishable. | Check the source id, that the source is enabled, and the secret. |
| 409 | `REPLAY` | This exact signed delivery was already accepted. | Nothing; or re-sign if you meant to resend. |
| 409 | `EVENT_ID_CHANGED` | A different `event_id` for an outcome that already has one. | Keep the first id. |
| 413 | `BODY_TOO_LARGE` | Body over 32 KB. | Send less (one outcome per delivery). |
| 429 | `RATE_LIMITED` | More than 600 signed deliveries per minute for this source. `Retry-After` says when to retry. | Back off and retry. |
| 503 | `SOURCE_LOOKUP_FAILED`, `REPLAY_CHECK_FAILED`, `OUTCOME_WRITE_FAILED`, `RATE_LIMIT_UNAVAILABLE` | A server dependency failed (the database, or a timezone mismatch between the ad account and configuration). Nothing was stored. | Retry with backoff, signing again. |

The checks run in this order: body size, header shape and timestamp (these reveal nothing about
whether a source exists), source lookup and signature, rate limit, payload, replay, write. A refused
delivery is never partially stored.

### Linking to the ad click

A delivery can carry the **paid-touch token** that Maxx issued to your website for the visitor's ad
click. With it, the outcome is linked to that exact click (campaign, ad set and ad), as the Acuity
example does ([ADR-056](architecture/adr-056-paid-interaction-measurement.md)).

1. **Get the token on your website.** Configure paid-touch capture (`PAID_TOUCH_TOKEN_SECRET`,
   `PAID_TOUCH_ALLOWED_ORIGINS`, `PAID_TOUCH_ALLOWED_LANDING_HOSTS`; see
   [configuration.md](configuration.md)). When a visitor lands from a Meta ad, your landing page
   POSTs the click (its `fbclid`, the Meta campaign, ad set and ad ids, the UTMs and the landing URL)
   to `/api/attribution/paid-touch`. The response's `data.token` is the token and `data.expires_at`
   its expiry. `docs/tracking/acuity-attribution-capture.js` is a complete reference for this call
   and for keeping the token in the browser.
2. **Keep it with the order or lead.** When the visitor converts, put the stored token in your
   checkout, form or CRM record (a hidden field or order metadata), just as you would a click id.
3. **Send it.** Your relay sends it as `attribution.paid_touch_token` on every delivery for that
   outcome. A later delivery without it (a refund sent by another system, say) keeps the link.

What happens to it:

- The token is checked against the minted format in the payload: anything else is
  `400 INVALID_PAYLOAD` with `fields: ["attribution.paid_touch_token"]`, like any other bad field.
- A well-formed token is then verified and linked. A token whose signature does not verify, that
  belongs to another ad account, that had expired when the outcome occurred, whose click came
  **after** `occurred_at`, or that is sent with `origin` other than `website`, is **ignored**: the
  outcome is stored and the response says `paid_touch: "rejected"`. The exact reason is recorded for
  the owner (`paid_outcome_link_evaluations.reason_code`), never returned.
- An outcome is linked once. Sending the same token again changes nothing; a different token for an
  already linked outcome is rejected.
- Without `PAID_TOUCH_TOKEN_SECRET`, nothing is linked (`paid_touch: "not_configured"`).
- The token is never stored with the outcome; the link keeps only its SHA-256 hash.

Coverage stays honest: every applied delivery is recorded as evaluated. An outcome without a token is
counted as not linked (`absent`). One with a Meta click id and paid-social UTMs but no token, or with
a rejected token, had a paid click Maxx could not link, so the linker is reported incomplete for that
window rather than complete.

### Signing examples

Each example signs and sends one outcome. `WEBHOOK_URL` is
`https://maxx.example.com/api/outcomes/webhook/<source_id>` on your deployment and `WEBHOOK_SECRET`
is the source's secret, both from your own secret store. `tests/docs-webhook-signing.test.ts` runs
the signing code of all three against Maxx's verifier, so these examples stay correct.

**Node.js 18 or later** (`node send-outcome.mjs`):

```js
import { createHmac } from 'node:crypto'

/** The x-maxx-signature header for one delivery. Sign the exact string you send as the body. */
function maxxSignature(signingSecret, rawBody, unixSeconds = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', signingSecret).update(`${unixSeconds}.${rawBody}`, 'utf8').digest('hex')
  return `t=${unixSeconds},v1=${v1}`
}

const body = JSON.stringify({
  external_id: 'ORDER-1001',
  outcome_type: 'sale',
  status: 'confirmed',
  currency: 'USD',
  gross_value: '120.50',
  occurred_at: new Date().toISOString(),
  origin: 'website',
  // The token your website stored for the ad click, if any (see Linking to the ad click).
  attribution: { paid_touch_token: process.env.ORDER_PAID_TOUCH_TOKEN || null },
})
const response = await fetch(process.env.WEBHOOK_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-maxx-signature': maxxSignature(process.env.WEBHOOK_SECRET, body) },
  body,
})
console.log(response.status, await response.json())
```

**Python 3.10 or later**, standard library only:

```python
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request


def maxx_signature(signing_secret: str, raw_body: bytes, unix_seconds: int | None = None) -> str:
    """The x-maxx-signature header for one delivery. Sign the exact bytes you send as the body."""
    t = int(time.time()) if unix_seconds is None else unix_seconds
    v1 = hmac.new(signing_secret.encode("utf-8"), f"{t}.".encode("utf-8") + raw_body, hashlib.sha256).hexdigest()
    return f"t={t},v1={v1}"


body = json.dumps({
    "external_id": "ORDER-1001",
    "outcome_type": "sale",
    "status": "confirmed",
    "currency": "USD",
    "gross_value": "120.50",
    "occurred_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "origin": "website",
    # The token your website stored for the ad click, if any (see Linking to the ad click).
    "attribution": {"paid_touch_token": os.environ.get("ORDER_PAID_TOUCH_TOKEN") or None},
}).encode("utf-8")
request = urllib.request.Request(os.environ["WEBHOOK_URL"], data=body, method="POST", headers={
    "content-type": "application/json",
    "x-maxx-signature": maxx_signature(os.environ["WEBHOOK_SECRET"], body),
})
try:
    with urllib.request.urlopen(request) as response:
        print(response.status, response.read().decode())
except urllib.error.HTTPError as error:  # 4xx and 5xx arrive here
    print(error.code, error.read().decode())
```

**curl and openssl** (a shell, for testing; `openssl -hmac` puts the secret on the command line,
where other local users can see it, so prefer the code above in production):

```bash
read -rs WEBHOOK_SECRET   # paste the signing secret the source returned when you created it
BODY='{"external_id":"ORDER-1001","outcome_type":"sale","status":"confirmed","currency":"USD","gross_value":"120.50","occurred_at":"2026-03-08T14:30:00Z","origin":"website","attribution":{"paid_touch_token":"pt1.00000000-0000-4000-8000-000000000000.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}'
T=$(date +%s)
V1=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $NF}')
curl -sS -X POST "https://maxx.example.com/api/outcomes/webhook/<source_id>" \
  -H 'content-type: application/json' -H "x-maxx-signature: t=$T,v1=$V1" --data-binary "$BODY"
```

`printf '%s.%s'` adds no trailing newline, and `--data-binary` sends the body byte for byte; `-d`
would strip line breaks and change what was signed.

### Conversions from webhook outcomes

With `OUTCOME_CONVERSIONS_SEND=true` (or `test` together with `META_TEST_EVENT_CODE`), Maxx sends a
webhook outcome to Meta's Conversions API once, at its **first confirmation** (a new confirmed
outcome, or `pending` → `confirmed`). It is sent only when:

- `origin` is `website`;
- the type maps to an event: `lead` → `Lead`, `sale` → `Purchase`, `booking` → `Schedule`,
  `signup` → `CompleteRegistration` (other types are not sent);
- the event is not one your business already sends for this source (the source's
  `platformNativeEvents`), so one result is never counted twice;
- `occurred_at` is within Meta's 7-day window;
- `attribution.landing_page` is an http(s) URL (Meta's `event_source_url`), and there is at least one
  of customer email, phone or name, `fbp` or `fbc`.

A cancellation, refund or later change never sends anything and never retracts an earlier event. In
`true` (live) mode, a failed first send is retried by the daily sync for up to 46 hours, inside
Meta's 48-hour deduplication window, and closed out as missed after that. A conversion failure never
fails the delivery: the outcome is stored first.

## The Acuity Scheduling example

Acuity is kept as a worked example of a reconciled source. It is off unless `ACUITY_USER_ID` and
`ACUITY_API_KEY` are set.

- **Ingestion:** Acuity calls `/api/webhooks/acuity` (appointment scheduled, rescheduled, canceled,
  changed). The route verifies Acuity's `x-acuity-signature` (HMAC-SHA256 of the raw body with your
  API key), bounds the body to 64 KB, optionally requires `?secret=<ACUITY_WEBHOOK_SECRET>`, then
  re-reads the appointment from the Acuity API rather than trusting the body. The daily sync
  reconciles recent appointments, and `scripts/backfill-acuity.ts` loads history
  (`ACUITY_BACKFILL_START`).
- **Model:** every appointment becomes an outcome of type `booking` under one `acuity` source (created
  and enabled on the first appointment). The appointment id is the `external_id`; a reschedule
  updates the same outcome; a cancel-and-rebook is two outcomes.
- **Completeness:** Acuity's reads are reconciled, so reports covering a window the reconciliation
  has not proved complete fail with the reason rather than undercount.
- **Conversions:** Acuity's own Meta integration already sends `Purchase` and `Schedule`, so the
  adapter declares them native and Maxx never mirrors them. With `ACUITY_CAPI_SEND`, Maxx sends only
  `AppointmentConfirmed` with the event id `acuity-<appointment id>`.
- **Paid-touch linking:** with the four paid-touch values set, a signed token captured on your
  website travels in a hidden Acuity intake field (`ACUITY_PAID_TOUCH_FIELD_ID`) and links the
  appointment to the exact ad click ([ADR-056](architecture/adr-056-paid-interaction-measurement.md)).
  Signed webhook deliveries link the same way through `attribution.paid_touch_token`; CSV outcomes
  keep their click ids and UTMs for diagnostics only.

Setup steps are in [install.md](install.md#7-outcome-sources).

## Writing a new adapter

Most systems do not need an adapter: a small relay that turns your system's events into signed
webhook deliveries is less code and gets every guarantee above. Write an adapter when Maxx should
**pull** from your system (reconciliation, backfill) or must verify that system's own signature.

1. **Contract.** Implement `OutcomeSourceAdapter` (`src/lib/outcomes/adapter.ts`) in
   `src/lib/outcomes/adapters/<kind>/adapter.ts`. Normalize every record into a `NormalizedOutcome`:
   money as exact decimal strings, `null` for not observed, instants with an offset.
2. **Capabilities.** Declare them honestly; the core relies on them:
   `carriesToken` (can a record carry an ad-click token?), `originKnown` (does the system say whether
   the result came from the website?), `collectedValue`, `platformNativeEvents` (events the system
   already sends to Meta), and `pull`/`push`/`backfill`. A wrong `carriesToken: true` or
   `originKnown: true` would let incomplete or unverified data pass gates.
3. **Registry.** Add the adapter to `src/lib/outcomes/registry.ts`, and add its kind to the
   `outcome_sources_kind_check` constraint in a new migration under `supabase/migrations/`.
4. **Ingestion.** Write through `upsertNormalizedOutcome` (`src/lib/outcomes/store.ts`), never to the
   tables directly: the core owns upsert, observations, ordering, conversions eligibility and touch
   linking. A push route verifies before parsing (`verifyPush` receives the source's secret, resolved
   by the route from the database) and returns the same response for an unknown source and a bad
   signature.
5. **Completeness.** If Maxx reconciles against your system, implement `ledgerHealth` so reads fail
   closed when the window is not proven complete. Without it, the source counts as received.
6. **Tests.** Write them first: a bad signature, a stale or replayed delivery, a malformed record, an
   unknown value (NULL) next to a zero, and a control that a good record is accepted. Keep the
   existing golden tests green.

Propose a new adapter in an issue first; see [CONTRIBUTING.md](../CONTRIBUTING.md).
