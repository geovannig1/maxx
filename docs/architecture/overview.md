# Architecture overview

```
Meta Marketing API ──────────► ad platform (src/lib/platforms/meta) ─┐
Outcome sources ─────────────► outcomes (src/lib/outcomes) ──────────┼─► sync ─► Supabase Postgres
  CSV import, signed webhook,                                        │                 │
  Acuity example                                                     │                 │
GA4 Data API ────────────────► src/lib/ga4 ──────────────────────────┘                 ▼
                    ┌── authority gates (src/lib/authority, src/lib/recommendations)
                    │
Next.js app ◄───────┼── reporting readers (src/lib/reporting, src/lib/report, src/lib/cockpit)
  /dashboard …      │
  /api/*            └── Maxx chat + MCP tools (src/lib/maxx, src/mcp), read-only; AI via src/lib/ai
```

**Three kinds of evidence, kept separate.** Outcomes are business truth (what the business recorded,
its status and value). GA4 events are web telemetry. Meta insights are platform-reported estimates.
Readers label the source on every number and never substitute one for another; reconciliation shows
the gaps. See [how-maxx-decides.md](../how-maxx-decides.md).

**Edges behind interfaces.** Business results come through outcome-source adapters
([outcomes.md](../outcomes.md)), the ad platform through the platform interface
([platforms.md](../platforms.md)), and models through the AI gateway ([ai.md](../ai.md)). The core
between them (money, counts, authority) does not depend on which system is on the other side.

**Deterministic money.** Sums, counts, deduplication, attribution identities and the authority
gates are plain TypeScript and SQL with tests. Language models write narratives and answer
questions over already-computed evidence, and every report works with AI off.

**Governed decisions.** The daily engine computes recommendations behind evidence gates; each has
a generation id, an evaluation and an owner decision record. Live changes are change requests with
a before-state, executed only when `WRITE_MODE_ENABLED` is on and the owner approves; the owner can
propose them from a decision (ADR-059) and create new campaigns, paused, from an approved plan
(ADR-062).

**Single owner, single account.** `OWNER_EMAIL` and the sole-active-account resolver are design
constraints, not bugs; see [security-model.md](../security-model.md).

Architecture decision records in this folder: the ecosystem boundary (ADR-053), the booking event
contract (ADR-054, superseded in part by ADR-058), the governed business page context (ADR-055),
paid-interaction measurement (ADR-056), the public release boundary (ADR-057), generic outcomes
(ADR-058), owner-initiated changes (ADR-059), the AI copy engine (ADR-061) and campaign plans created
paused after owner approval (ADR-062). They are dated records: where a later document or
the code differs, the later one wins.
