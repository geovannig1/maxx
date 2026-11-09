# Meta knowledge references

The nine reference notes in this folder and `MAXX-SKILL.md` are vendored, unmodified, from
[mathiaschu/meta-ads-analyzer](https://github.com/mathiaschu/meta-ads-analyzer) (MIT License,
Copyright (c) 2026 Mathias Chu; see [LICENSE](LICENSE) in this folder). They summarize Meta's
public delivery-system documentation (ad auctions, learning phase, pacing, the breakdown effect,
auction overlap, bid strategies, relevance diagnostics, performance fluctuations).

Maxx distills them into the cited knowledge corpus in `src/lib/knowledge/entries/`, where every
claim carries its source and tier; `tests/knowledge-corpus.test.ts` asserts that every file here is
distilled by at least one entry so the two cannot drift apart.
