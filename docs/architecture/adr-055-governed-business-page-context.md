# ADR-055 — Governed business and landing-page context

**Status:** Accepted. Not authority to create or change a Meta campaign.

**Date:** 2026-07-30

## Context

Maxx currently knows delivery and account evidence, but it has no durable answer to the questions a
media buyer must settle before selecting campaign settings:

- what the business sells now;
- which offers may be advertised;
- the governed offer descriptions and which approved claims apply to each offer;
- the approved claims and constraints;
- the owner-approved economics and capacity, including which values remain unknown;
- the eligible service geography and seasonality, without inventing a targeting radius or dates;
- what an exact landing page says and does on mobile;
- which funnel stages, offers, claims, and calls to action that page actually supports.

The marketing-team repository contains useful research, but files in another working tree are not a
production authority. They may be stale, contradictory, edited after review, or unavailable at
runtime. Maxx must not silently scrape the site, select an arbitrary page, infer economics, or turn a
research note into campaign instructions.

## Decision

### 1. Observation and approval are different records

`business_context_versions` and `landing_page_snapshots` are immutable observations. An observation
does not become trusted because it exists.

`business_context_approvals` and `landing_page_approvals` are immutable owner decisions. Each decision
links to the exact observation and hash that was reviewed, the previous decision, the actor, reason,
and an owner-supplied `review_due_at`. The newest decision is derived from a monotonically increasing
account-scoped revision. Replacing or withdrawing an approval appends a decision; it never rewrites
history.

There is deliberately no mutable `status = approved` column on an observation and no mutable head row.
The append-only decision chain is the head and the audit trail.

The business document's `approved_claims` entries are offer-scoped and carry a per-claim `source_ref`.
That field name records the claims submitted for owner review; committing the observation does not approve
them. Only a current owner decision over the exact business observation and hash makes those
provenance-bearing claims available to planning.

### 2. Writes are governed and idempotent

Browser roles receive no direct table access. `service_role` may read the records but may write only
through `SECURITY DEFINER` RPCs with locked search paths.

Every commit RPC:

- takes the account UUID explicitly;
- takes a table-level account lock and verifies that the target remains the sole active account;
- serializes the account/dedupe identity with a 64-bit transaction advisory lock;
- treats an identical retry as success;
- rejects the same dedupe key with a changed immutable payload;
- rejects cross-account references; and
- stores a `sha256:<64 lowercase hex>` digest supplied by the typed server adapter.

Every approval RPC additionally:

- takes the expected previous approval ID and rejects stale concurrent reviews (CAS);
- compares the exact expected content hash;
- requires a non-empty actor and reason;
- requires an owner-chosen future review deadline; and
- for a landing page, binds the approval to the exact current business-context approval.

The writer contract is qualified only for `READ COMMITTED`, the setting under which the local
PostgREST/Postgres integration path was exercised. PostgREST requests inherit the database/role transaction
setting; the harness is not evidence of the live database's current setting. The account advisory lock
serializes writers, and statements executed after lock acquisition receive the ordinary new statement
snapshot. Production must confirm `READ COMMITTED`; a different isolation level is outside this contract
and must be re-qualified before use.

The one-statement reader evaluates all latest-observation, latest-decision, and lineage joins in one
internally consistent MVCC statement snapshot. A writer that commits after the reader's statement starts
may therefore be absent from that response. The reader does not mix heads from different instants, but it
does not claim that a response remains the newest; any pre-action gate must read again.

The contract is enforced jointly rather than by one layer:

- TypeScript strict schemas validate content and relationships, normalize typed web/telephone/email CTA
  destinations, recompute canonical JSON digests, reject detected secrets, credential-bearing URLs, and
  free-text contact data outside the typed public CTA fields,
  and limit every governed URL to 2,048 UTF-8 bytes, a business
  document to 24 KiB, and a landing-page document to 16 KiB. A stored hash that no longer matches its
  typed document is an integrity failure, never approved context.
- The production command API is owner-authenticated, resolves exactly one active account, derives the
  actor from the authenticated user, rejects caller-supplied account/actor fields, rate-limits requests,
  and caps each command body at 128 KiB before invoking the typed server adapter.
- Postgres enforces append-only storage, sole-active-account scope for every governed write, account-scoped revisions,
  idempotency/CAS, cross-account foreign keys, stored landing-page URL and document octet limits,
  runtime-observation-before-capture chronology, RPC/table privileges, and a `pg_catalog`-only function
  search path so no writable application schema participates in privileged name resolution.

The governed page document may contain public business contact destinations only in its typed `tel:` and
`mailto:` CTA fields. Arbitrary business/page prose, caller-supplied provenance, and review text reject
email addresses and phone numbers so a customer contact cannot be smuggled into the audit trail. All
governed documents also reject client or appointment-level PII, credentials, secrets, API keys,
passwords, access/auth tokens, and signed credential-bearing URLs. The supported TypeScript/API path
performs these schema, metadata, and byte checks before invoking an RPC; a direct service caller must not
bypass that adapter.
The RPC actor is an audit value supplied by the trusted API boundary, not a browser claim. There is no
anonymous, authenticated-browser, or direct-table write path.

### 3. No invented freshness policy

Maxx does not invent a 45-day page lifetime, a 180-day business lifetime, or any other default. An
approval is current only until its recorded `review_due_at`. If the owner has not supplied a deadline,
the approval RPC rejects the decision.

A newer recorded observation with a different digest blocks the older approval until the new facts are
reviewed. A same-content recapture does not invalidate the approval.

### 4. Page selection is exact

Landing-page state is keyed by a normalized canonical HTTP(S) URL. A caller must provide the exact page
it intends to evaluate. Maxx may not select the newest page in the account, infer `/book`, or substitute
the homepage. A missing requested URL resolves to `landing_page_url_required`.

A page approval is not a claim that the page is good. It means the recorded facts were reviewed. Page
purpose, supported stages, runtime/mobile observations, CTA inventory, and tracking inventory remain
inputs to the later CampaignPlan/readiness policy. A reviewed page can still block a launch.

Every offer has a governed description, and every approved claim names at least one known offer. A page
claim must apply to at least one offer that the same page declares. This prevents a true claim for one
service from silently becoming message authority for another service on a multi-offer booking page.
Radius-style service areas must include the radius; non-radius areas cannot carry one.

`source_kind` records capture method only; it is not an approval, identity assertion, freshness guarantee,
or cryptographic attestation. In particular, a `browser_probe` row says only that the producer labelled
the capture method as a browser probe. The observation remains unapproved until the separate owner decision,
and it does not prove that Maxx independently fetched the page. The pre-launch probe and the PAUSED-staging gate must
re-check live runtime, mobile rendering, destinations, and tracking before any launch can pass.

### 5. Stable fail-closed states

The resolver returns structured evidence, not campaign settings. It can report:

- missing observation;
- no current approval or explicit withdrawal;
- approval review deadline passed;
- invalid document;
- stored-document hash mismatch;
- newer unapproved observation with different content;
- landing-page URL required;
- landing-page/business-context approval conflict; or
- read failure.

Only `approved_current` on both records makes the context available to a future CampaignPlan. That state
does **not** authorize objective, audience, targeting, budget, creative, or Meta writes.

### 6. Integration boundary

This context feeds its structured status into the existing `resolveLaunchReadiness` path. It does not
introduce another recommendation brain. Until an immutable CampaignPlan with exact page binding exists,
launch readiness remains unverified and campaign/creative creation stays quarantined.

The read-only MCP tool accepts an exact landing-page URL and exposes only status, blocker codes, and
artifact/approval lineage. It never returns the approved documents. The later typed CampaignPlan service
must consume approved context server-side; launch-readiness prose is not a substitute for that boundary.
The separate owner-only API returns the latest workflow snapshot with provenance and decision metadata
under `private, no-store`, including pending observations needed to resume review.

The first real observations may be produced from the marketing-team research artifacts, but publication
and approval are separate owner actions. No production site scraping or cross-repository runtime read is
introduced by this ADR.

## Acceptance conditions

The implementation is accepted only when tests prove:

1. observations and approval decisions cannot be edited by application roles;
2. anon/authenticated have no table or RPC write access;
3. identical retries return the same record and payload collisions fail;
4. stale CAS reviews and cross-account references fail;
5. approval binds the exact digest and a future owner-provided review deadline;
6. page approval binds the current business-context decision;
7. exact URL selection prevents one page from satisfying another;
8. expired, withdrawn, invalid, hash-mismatched, newer-conflicting, missing, and read-error states fail
   closed with stable codes;
9. the production launch-readiness entry point reaches the resolver;
10. the owner command route derives account and actor server-side, bounds its input, and reaches the
    governed store;
11. approved context alone still cannot produce campaign settings or mark a launch ready;
12. the owner review read can resume a pending/withdrawn workflow without exposing a cross-account
    snapshot; and
13. Maxx receives governed status, blockers, and lineage but no documents through the free-form MCP tool;
14. secret/credential detection and URL/document/request byte boundaries reject invalid input; and
15. the one-statement reader returns a single-snapshot result under a concurrent writer, with freshness
    obtained by a later re-read rather than a linearizability claim; and
16. an account-activation change is serialized against a governed write, and the stale target is rejected
    without appending evidence; and
17. runtime evidence cannot postdate its declared capture, including at the direct RPC boundary.

## Consequences

- Maxx gains durable, owner-governed business/page inputs without a free-form memory graph.
- Marketing research becomes a provenance-bearing input rather than an implicit authority.
- Owner review is explicit and renewable.
- Campaign architecture remains blocked until the CampaignPlan, measurement, audience, creative, and
  staging work packages are complete.
- No live ad, tracking, environment, migration, or deployment state changes as a consequence of this
  ADR.

The governed business-page context schema is additive. Application rollback means redeploying the prior
application while retaining its tables/functions/permissions, and every append-only observation and decision. A
destructive database downgrade is neither required nor rehearsed. Production application must use the
transactional Supabase migration path so table creation, trigger installation, grants, and revokes cannot
become partially visible. The live page, mobile rendering, destinations, and tracking must still be
re-probed before staging or launch.

A local rehearsal proves the known migration order and resulting schema/permission assertions; it
neither examines live rows nor executes or proves the hosted deployment runner. Immediately before
applying to a hosted database, the operator must fetch and reconcile the remote migration ledger,
including applied versions/names, revalidate applicable immutable file checksums, and stop if it
differs.
