# ADR-062: Campaign plans, created paused after the owner approves

**Status:** accepted. **Date:** 2026-11-08. **Owner decision:** "Ask Maxx drafts complete campaigns
(structure, audiences, budget, copy) and creates them PAUSED after you approve", and Ask Maxx runs
three owner actions (copy, a plan draft, a proposal).

## Context

Several surfaces waited on "a server-verified CampaignPlan repository": the MCP creation stubs, the
legacy launch-setup ledger and creative briefs. ADR-059 gave the owner a governed change loop for
existing objects (pause, activate, budget, duplicate), and ADR-061 a deterministic copy scorer and AI
copy generation. Nothing could create a campaign, and nothing in the chat could act on the owner's
behalf.

## Decision

1. **A CampaignPlan is an immutable, versioned entity** (`campaign_plans`, `campaign_plan_versions`,
   RLS on, service role only). A version holds the spec (`src/lib/campaigns/plan-spec.ts`): objective
   (`OUTCOME_SALES`, `OUTCOME_LEADS`, `OUTCOME_TRAFFIC`, `OUTCOME_ENGAGEMENT`), auction buying, CBO or
   ABO, daily budgets in account-currency **minor units** converted only through the platform's
   `budgetUnits`, lowest-cost bidding (a cost cap only with the owner's own amount), the schedule, the
   pixel and outcome event, up to 5 ad sets (Advantage+, broad or the account's synced custom
   audiences; countries; ages; Advantage+ or chosen placements) and up to 10 ads per ad set (an
   existing creative as it is, or a new creative from an image hash or video already in the account
   with Copy-studio copy, a CTA, a destination and `url_tags`). No media is uploaded. The spec carries
   no status: every object is created PAUSED by the payload builder, which cannot emit ACTIVE
   (`assertPaused`). Content is frozen by a trigger; an edit is a new version and supersedes the
   previous draft; status moves only along governed edges (draft → pending_approval → approved →
   creating → created_paused | failed → archived).
2. **Validation is deterministic and runs at every step** (draft, edit, submit, and again just before
   creation): currency match and support, budget mode consistency, Meta's per-ad-set minimum
   (5× the smallest daily budget for conversion goals, 1× otherwise), the account ceiling
   (`DAILY_BUDGET_CEILING`) against today's live active total (an unprovable total blocks), the
   configured currency (`NEXT_PUBLIC_ACCOUNT_CURRENCY`) equal to the ad account's (the same guard as
   every ADR-059 money write), the account's own pixel for a conversion target, a video thumbnail from
   the synced creative thumbnails, the
   per-change step limit (`MAX_BUDGET_CHANGE_PERCENT` of today's active total needs an explicit,
   recorded override), objective/optimisation compatibility, a pixel for conversion goals, schedule,
   ages, audiences and creatives that exist in **this** account's synced data, destinations on the
   configured landing hosts (`PAID_TOUCH_ALLOWED_LANDING_HOSTS` plus the business profile's own site),
   the ADR-056 `url_tags` contract (missing keys warn), Meta's name and copy limits, and the copy
   scorer (any scorer blocker blocks the plan). A **launch-readiness checklist** sits beside it:
   conversion signal, destination, tracking parameters, budget sanity, audience size known (Meta's
   "20" placeholder is unknown, never a count), creative count and variety, copy.
3. **Drafting.** `draftCampaignPlan(brief)`: with AI on and asked for, one structured call
   (`campaign_planning`) proposes only the structure: a campaign name and up to three ad sets with
   audience choices from listed ids and creative references (opaque `A1…`, never hashes). Maxx then
   normalises it: budget, objective, optimisation goal, bids, URLs and status never come from the
   model; ad sets are consolidated for small budgets (one below ten daily minimums, two below twenty,
   three at most); unknown ids are dropped; a custom ad set with no valid audience becomes
   Advantage+. Copy comes from `generateCopy` (scored; blocked variants dropped). Any model failure
   falls back to the **template planner**, which is also the whole planner with AI off: one CBO
   campaign, an Advantage+ prospecting ad set (a warm ad set excluded from prospecting only when the
   budget carries it), three to six ads pairing saved Copy-studio copy with distinct visuals, or
   reusing existing creatives (with a message) when no copy is saved.
4. **Approval.** "Submit for approval" re-validates and creates an owner-initiated change request of
   the new type `create_campaign_paused` through the service-role RPC
   `create_campaign_plan_change_request`, which derives the params itself (`plan_version_id`,
   `spec_hash`). The request has `campaign_plan_version_id` instead of an ActionDecision; the
   change-request trigger and the review RPC have a plan branch (owner only, frozen lineage and
   payload, approve/reject the version and the request in one transaction, an expired request cannot
   be approved). The preview lists every object and budget, and under each ad every value its
   creative sends to Meta (copy, call to action, destination, image or video and thumbnail, URL
   parameters), plus the pixel and event of a conversion ad set; `/changes` shows each ad's details
   collapsible. It appears on `/changes` with the same Approve & apply flow.
5. **Creation** (`src/lib/campaigns/plan-executor.ts`, `plan-creation.ts`, Meta transport
   `src/lib/platforms/meta/campaign-writes.ts`): write mode (`WRITE_MODE_ENABLED=true`), status and
   expiry, the spec hash, a fresh re-validation, then the per-account `action_log` lock. After the lock
   the request, the version and the object rows are read again; an attempt that waited behind a
   finished run stops without a Meta call, and the request is finalized by compare-and-set from the
   status the run began with. Objects are created in order (campaign → ad sets → creatives → ads),
   each row in `campaign_plan_objects` written before its Meta call and given its id right after. A
   retry (Resume) skips recorded objects and finds an object created before its id was recorded by the
   **marker** in its name (`[mx<seed12>-<key>]`, the seed being 12 hex of sha256 of the plan version
   and change request ids, so a marker belongs to one creation request, never to a spec; the database
   recomputes it on every row). A found object is taken only when it reads back PAUSED with exactly
   that marker; anything else, a failed lookup or an ambiguous one stops the run
   (`FOUND_OBJECT_INTEGRITY`, `MARKER_LOOKUP_FAILED`), and Maxx never changes the status of an object
   it found rather than created (`origin`). A Meta id is held by one object row per account. Creatives
   are the one exception (an unrecorded creative is recreated; a creative is inert). Every object is
   read back: status PAUSED, exact marker, budget; an object this request created that reads as active
   is paused again and the creation is reported unverified. A partial failure records what exists (all
   paused) with guidance: Resume creates only the missing objects, Roll back archives the created
   ones. Resume is refused while a rollback of the creation is pending or approved. A run that dies
   holding the lock is recovered by the owner (ADR-059 §10): its version goes to failed and Resume
   continues safely.
6. **Rollback** is a new pending request, `archive_campaign_plan_objects` (`rollback_of` → the
   creation), listing exactly the ids recorded under that creation's own markers; approving it
   archives them (children first).
7. **Demo.** With `MAXX_DEMO=1` creation and rollback run a simulator: the same gates and claim, fake
   `demo-…` ids, objects marked simulated, labelled "Demo: simulated".
8. **MCP stays read-only.** `create_paused_campaign_draft` and `create_paused_adset_draft` are replaced
   by `get_campaign_plans` and `preview_campaign_plan` (a template preview, validated, never stored,
   never a model call). `create_paused_test_draft` stays NOT_IMPLEMENTED (no experiment registry).
   The legacy launch-setup ledger and creative-brief mutations answer `USE_CAMPAIGN_PLANS`.
9. **Ask Maxx actions.** For the signed-in owner the governed chat offers three sink tools:
   `write_copy_variants`, `draft_campaign_plan`, `propose_decision_change`. Each ends the turn with a
   fixed, number-free lead and a card (copy variants with scores, a plan summary with a review link,
   a pending-approval card, or a refusal). Copy in a card passed the scorer and the unverified-claim
   detector; blocked variants are withheld. A plan draft needs the owner's budget and countries (the
   chat asks rather than guesses). A proposal is possible only from a persisted final decision shown
   in that turn, never with a step override. No chat path reaches the review RPC or an executor;
   write tools stay refused; answers to questions stay summary-first and claim-only.

## Consequences

- An owner can go from a brief (or a chat request) to paused objects in Meta in three deliberate
  steps: draft, submit, approve. With write mode off the approval is recorded and nothing is created.
- Object names carry a short marker so a retry cannot duplicate; owners see it in Ads Manager.
- Plan budgets count against the account ceiling as if active, although they start paused.
- Readiness uses only synced data and configuration; it does not call Meta (pixel volume and
  delivery estimates are pointed to, not fetched). Existing campaigns are not bound to plans: the
  legacy launch-readiness and experiment surfaces keep their `campaign_plan_not_implemented`
  blocker codes, which now mean "not bound to a plan".

## Alternatives considered

| Alternative | Why it was rejected |
|---|---|
| A separate approvals table for plans | Two approval surfaces for the owner; ADR-059's loop, audit and lock already fit. |
| Let the model choose budgets, objectives or bids | Money and authority stay deterministic (how-maxx-decides §6). |
| Upload generated media in this version | Media generation has no verified-claims path yet; plans reuse what the account holds. |
| Create objects ACTIVE behind a second approval | Activation is the owner's act in Ads Manager; paused creation keeps the blast radius at zero spend. |
| Let MCP create plan drafts | The MCP process holds the service key; drafting stays behind the owner session. |
