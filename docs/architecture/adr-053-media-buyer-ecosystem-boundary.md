# ADR-053 — Media-buyer ecosystem boundary: build / integrate / evaluate-later / skip

**Status:** ACCEPTED (design decision; no vendor purchased, nothing integrated)
**Date:** 2026-07-27
**Supersedes:** nothing. **Amends:** the model-router proposal (an internal design note not carried into the public repository; see §6).

## Context

Maxx is becoming a media-buyer decision system. That invites two opposite failure modes:

1. **Buying a tool instead of fixing the evidence.** A vendor that produces a confident-looking
   attribution number does not make the underlying evidence stronger; it adds a second unverified
   plane and a new place for a claim to originate that nobody can audit.
2. **Building everything.** Re-implementing what Meta already exposes natively wastes effort and
   creates a second, drifting source of truth.

The evidence-integrity work in this codebase (durable observation lineage, a real CAPI delivery
contract, validated Meta parsers, truthful video metrics, targeting-based audience resolution,
source-specific actionability, forward-only coverage) establishes the line: **Maxx owns the
reasoning and the audit trail; the platform owns the platform facts; nothing else is a decision
authority.**

## Decision

### CORE — integrate and depend on

| System | Role | Why it is core |
|---|---|---|
| Meta native Marketing API | delivery facts, entity config, targeting, native recommendations | the only authoritative source for what the platform actually did |
| Meta dataset diagnostics (`/stats`, supported aggregations only) | coverage + processing evidence | first-party signal health, verified contract |
| Meta Events Manager | owner-observed EMQ | no verified API equivalent exists; owner-observed is honest, derived is not |
| First-party Acuity ledger | business truth | the only record of an actual booking and actual money |
| Deterministic Maxx logic | reconciliation, gates, decisions | auditable, testable, reproducible |

### BUILD INTERNALLY — never outsource

Evidence normalisation, cross-plane reconciliation, the experiment registry, decision gates,
reporting, and audit history. These are exactly the parts where an opaque vendor answer would be
indistinguishable from a fabricated one. They must stay deterministic, versioned, and testable.

### EVALUATE LATER — explicitly not now

| Candidate | Possible future role | Hard boundary | Status |
|---|---|---|---|
| **Research Foreplay** | optional creative-research / import source (an inspiration and reference library) | may NEVER be a decision authority; may not originate performance numbers; anything imported is tagged as external reference with its own provenance | **not purchased, not integrated** |
| **WeTracked** | supplementary attribution *lens* | may NEVER replace Acuity business truth or Meta-native delivery evidence; at most a third plane that must reconcile against the first two, with its own actionability ceiling | **not purchased, not integrated** |

Neither is required for any conclusion Maxx currently draws. Buying either before the deterministic
evidence layer is proven would add a plane whose disagreements we could not adjudicate.

### SKIP

- **Manus** — not part of the production decision path. No role in evidence, reasoning, or action.
- **External coding assistants** — remain **bounded development reviewers** (read-only review,
  no writes, no commits, no merges) or an offline strategy critic. It must not silently
  become a live media-buying authority: it never reads production credentials, never proposes an
  action into the recommendation pipeline, and never writes to the database. Its output is advisory
  findings for a human.

### Provider / model routing

Design-only until the deterministic evidence fixes are complete **and evaluated**.
Routing a model into a pipeline whose evidence layer is still being corrected would make it
impossible to tell a model regression from an evidence bug.

## §6 — Amendments to the model-router proposal (binding, before any implementation)

1. **Remove transactional deduplication from model-routed tasks.** Booking dedup, event dedup, and
   attribution-window dedup are transactional correctness, not classification. They stay
   deterministic forever. (The v1 task map listed "Signal judge / dedup / classification" on the
   cheap tier — the **dedup** element is struck; signal judging and classification may remain.)
2. **Deterministic task boundaries.** A task is model-routable only if its output is advisory text or
   a ranking. Anything that produces a count, a monetary value, a dedup decision, a gate verdict, or
   a write payload is deterministic and unroutable.
3. **Control / shadow roles.** Control serves the user. Shadow runs on the same input, its output is
   recorded and never displayed, and it can never affect a decision.
4. **Fallback and circuit breaker.** Per-provider breaker with an explicit open/half-open/closed
   state; on open, fall through the declared fallback chain and then to deterministic degrade. A
   breaker trip is an auditable event.
5. **Timeouts and retry classes.** Every call carries an explicit timeout. Retries are permitted only
   for transport/5xx/timeout classes; never for a refusal, a validation failure, or a content error —
   retrying those manufactures variance.
6. **Daily shadow-budget limit.** A hard per-day token/cost ceiling for shadow traffic; on breach,
   shadow stops for the day and the fact is logged. Shadow must never be able to consume the budget
   the control path needs.
7. **Privacy and retention.** No raw PII and no raw prompt bodies in call logs — hashes, token
   counts, and redacted classes only. Explicit retention window; logs expire.
8. **Policy and evaluation versions in every call log.** A result that cannot be tied to the exact
   policy version and evaluation version that produced it is not evidence.
9. **Promotion gates.** A challenger needs a declared minimum sample, a **non-inferiority** result on
   the primary metric (not merely "looks better"), and **zero critical deterministic errors** —
   any wrong number, broken gate, or invented citation is disqualifying regardless of preference
   scores.
10. **Modality / provider adapters are NOT interchangeable.** A vision task cannot fall back to a
    text-only model, and a provider swap is a policy change requiring its own evaluation.

## Consequences

- Nothing is purchased or integrated by this ADR.
- Maxx's conclusions continue to rest only on sources whose contracts are verified and testable.
- Two named vendors have a documented, bounded future path rather than an implicit "maybe someday".
- The router remains design-only, with the amendments above required before any implementation.
- Write mode stays OFF; the owner remains the decision authority for every live change.
