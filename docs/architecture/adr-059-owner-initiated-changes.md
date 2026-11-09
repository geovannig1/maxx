# ADR-059: Owner-initiated changes

**Status:** accepted. **Date:** 2026-11-08.

## Context

The executor (`src/lib/writes/executor.ts`) can change the ad account safely: write mode, an
account-scoped atomic claim, the account-currency gate, Meta's budget offsets, the account budget
ceiling, a re-read of the approved state immediately before the mutation, verification and an audit
row in `action_log`. Nothing that ships could reach it. A change request needed an ActionDecision
that was `execution_eligible` and carried an exact `proposed_mutation`; the engine writes
`proposed_mutation = null` on every decision, and money actions reach at most `owner_review` without
a decision-grade causal estimate. `PATCH /api/approvals/[id]` always answered 409.

The tier rules are right for an *agent*: the engine must not instruct a money move on weak
evidence. They are wrong as a bar for the *owner*, who is entitled to make that call on the
evidence the engine shows them. The distinction is who initiated the change, not how good the
evidence is.

## Decision

1. **A second initiator, recorded in the row.** `change_requests.initiated_by` is `agent` (the
   default, the existing path) or `owner`. An owner request also records `requested_by_user_id`.
   Both are frozen after insert. Owner requests are created only by the owner-gated, same-origin
   `POST /api/changes`, through a separate RPC, `create_owner_change_request`.
2. **What the owner may propose.** A current ActionDecision (policy version at the floor, evaluated
   within 7 days, the newest decision for its target) at `execution_eligible` or `owner_review`,
   whose kind maps to one of the executor's four mutations on the matching level: `pause` → pause ad,
   `activate` → activate ad, `budget_scale`/`budget_cut` → set ad-set daily budget (the direction
   must match the kind), `structural` → duplicate ad set as paused. `diagnostic_only` stays
   refused: it means Maxx found no supported direction, and an owner proposal must not turn an
   observation into a write lineage. If the decision carries a `proposed_mutation`, the owner's
   parameters must equal it; when it is null (every engine decision today) the owner supplies the
   amount or name, and that request is the mutation authority.
3. **The same hard guards, no weaker.** Unknown or inactive account, target not owned by the
   account, currency mismatch, before-state unreadable, account-total ceiling
   (`DAILY_BUDGET_CEILING`), minimum and maximum daily budget: all refuse the proposal and are
   re-checked at execution. There is no learning-phase hard stop in the engine today (learning is an
   advisory preflight signal), so none is added.
4. **Per-step limit.** A budget step above `MAX_BUDGET_CHANGE_PERCENT` (default 50) is refused
   unless the owner confirms the override explicitly; the confirmation is stored
   (`step_override`), raises the risk to high and is printed in the preview.
5. **The database states the rule too.** The change-request trigger accepts `owner_review` lineage
   only on an `owner` row; the ActionDecision guard approves an `owner_review` decision only when an
   owner-initiated request references it. Agent requests keep every existing invariant, including
   the exact `proposed_mutation` match.
6. **Approve & apply.** `PATCH /api/changes/[id]` `{action: "approve_and_apply"}` approves (idempotent
   on a second click) and, only when `WRITE_MODE_ENABLED=true`, executes through
   `executeApprovedChange` unchanged except that an owner row is checked by
   `validateOwnerWriteAuthority` instead of the agent validator. With writes off it records the
   approval and says so; the approved row stays listed with an Execute control. Approving an expired
   request is refused by the review RPC.
7. **Rollback is a new proposal.** `POST /api/changes/[id]/rollback` on an executed pause, activate
   or budget change creates the inverse request (`rollback_of` → the original), restoring the
   original before-state, for the owner to approve like any other. A duplicated ad set has no
   automatic inverse (the executor cannot delete); its rollback plan stays manual. One live rollback
   per original.
8. **Demo.** With `MAXX_DEMO=1` the before-state comes from the sample database and approval runs a
   simulated executor: same authority checks and the same `action_log` claim, status `simulated`,
   the sample rows updated, result labelled "Demo: simulated". Demo mode is refused in production
   and on Vercel, so the simulator cannot run where Meta writes are possible.
9. **Later chat entry points.** `proposeChangeFromDecision(decisionId, ownerUserId, options)` and
   `listPendingChanges()` in `src/lib/writes/owner-changes.ts`. The chat must still route the owner
   through the same approval card; neither function approves or executes.
10. **Hardening after the security review (2026-11-08).**
    - *Owner identity.* Every owner RPC call goes through `callOwnerRpc` (`src/lib/writes/owner-rpc.ts`),
      which refuses an id other than the pinned `OWNER_USER_ID` (trimmed, case-insensitive) before the
      database. The database holds no owner identity, so the service role stays the trust boundary.
    - *Budget rules in the database.* For an owner `adjust_budget` whose before-state holds the live
      budget, the change-request trigger repeats the decision's direction and the step limit
      (`max_step_percent` given to `create_owner_change_request`, 50 when none, read through the
      transaction-local `maxx.max_budget_change_percent`); any step from a zero budget needs
      `step_override`, in the service and in the database.
    - *Status transitions.* `change_requests_status_transition_trg`: pending → approved | rejected |
      expired; approved → executed | failed | rejected | expired; failed → executed only for a
      campaign-plan resume or retry. The executor finalizes from `approved` only (compare-and-set).
    - *Stuck runs.* `PATCH /api/changes/[id]` has `maxDuration` 300. A run that still dies leaves its
      `executing` claim; a later write is refused naming the stuck change, and the owner's
      `{action: "recover"}` (only once the run is older than `CHANGE_RECOVERY_STALE_MINUTES`, default
      15) re-reads Meta, records the live state with outcome unknown on the request (now failed) and
      the claim (`unknown`), then releases the account. Nothing is re-applied.
    - *Meta responses.* Only `safeWriteResponse` (scalar ids and flags; an error's code, subcode and
      redacted message) is stored on `action_log`/`change_requests` or returned.

## Consequences

- With pragmatic media-buyer mode on, money decisions reach `owner_review` and the loop works end to
  end. With it off they are `diagnostic_only` and only non-money structural decisions can be
  proposed; the Changes page says why a decision is not proposable.
- `PATCH /api/approvals/[id]` is removed. It had no caller; legacy creative/test approvals stay
  read-only history on `/approvals`, which now points to `/changes`.
- Activity shows every owner request with its initiator, preview and status; `action_log` keeps the
  claim, before/after and actor.

## Alternatives considered

| Alternative | Why it was rejected |
|---|---|
| Lower the engine's tiers so money actions become `execution_eligible` | Weakens the evidence rule for every caller, including an agent with the service key. |
| Let the owner create a fresh "owner" ActionDecision | Decisions are the engine's immutable record of its own judgement; writing one would blur who decided what. |
| Allow `diagnostic_only` decisions on owner request | The direction is unsupported by design; the owner can still change Meta manually and record it. |
| Execute on approval regardless of write mode | Write mode is the deployment-level kill switch; it stays the last gate. |
