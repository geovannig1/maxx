# AI in Maxx

AI is optional. Every number, report, gate and page in Maxx is computed without a model, and works
with AI switched off. When a provider is configured, a model writes narratives, answers questions
in owner chat and describes creatives; it never computes a metric, decides an attribution or
authorizes a change ([how-maxx-decides.md](how-maxx-decides.md#6-the-role-of-ai)).

All model calls go through one gateway, `src/lib/ai/`. Nothing outside it imports a model SDK
(`tests/ai-off.test.ts` checks this).

## Providers

| `AI_PROVIDER` | Adapter | Default model | Credentials |
|---|---|---|---|
| `anthropic` | Anthropic SDK (Claude API) | `claude-opus-5-5` | `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` |
| `bedrock` | Anthropic Bedrock SDK | `anthropic.claude-opus-5-5` | AWS credential chain (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN`, a role or a profile) and `AWS_REGION` or `AWS_DEFAULT_REGION` |
| `vertex` | Anthropic Vertex SDK | `claude-opus-5-5` | Google credentials (`GOOGLE_APPLICATION_CREDENTIALS`), `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION` (default `global`) |
| `foundry` | Anthropic Foundry SDK | `claude-opus-5-5` | `ANTHROPIC_FOUNDRY_API_KEY` and `ANTHROPIC_FOUNDRY_RESOURCE` or `ANTHROPIC_FOUNDRY_BASE_URL` (API key only) |
| `openai-compatible` | OpenAI-compatible chat completions over HTTP | none: set `AI_MODEL` | `OPENAI_COMPATIBLE_BASE_URL` (e.g. `http://localhost:11434/v1`), optional `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_MAX_TOKENS_FIELD` |
| `none` | - | - | AI off |
| unset | `anthropic` when a Claude key is present, otherwise off | | |

The four Claude providers use Anthropic's own SDK family and the same Messages API, so effort,
adaptive thinking, prompt caching and refusal handling behave the same on each. The
OpenAI-compatible adapter is for self-hosted or other models and offers what that protocol offers.
`AI_MODEL` overrides the model for any provider. Vertex credentials and Foundry Entra ID sign-in have
not been runtime-checked; Foundry is supported with an API key.

## Defaults and what they cost

| Setting | Default | Effect on cost |
|---|---|---|
| Model | `claude-opus-5-5` (Claude providers) | Opus is the most capable and the most expensive Claude tier. Set `AI_MODEL` to a smaller model to spend less. |
| `AI_EFFORT` | `medium` | Applies to owner chat and report narratives. Higher effort spends more output tokens on reasoning. `none` sends no effort parameter (for models that do not take one). Batch features (creative vision, competitor analysis, the signals judge, the setup probe) always use `low`. |
| `AI_FALLBACKS` | `default` on `anthropic`, `off` elsewhere | `default`: when Claude declines a request, the Claude API reruns it on a model Anthropic chooses, **at that model's price**. `off` disables it. A list of 1-3 model ids uses those instead (server-side on the Claude API, client-side on Bedrock, Vertex and Foundry). Not available for `openai-compatible`. |
| Prompt caching | on for chat and report narratives | Repeated system prompts are read from the provider's cache at a lower price. |
| Output ceiling | 32,000 tokens per call | Per feature: chat 16,000, narratives 8,000, vision and competitor analysis 4,000, signals judge 2,000, setup probe 16. |

Where the calls happen:

- **Owner chat** (`/maxx`): one call per round of a tool loop, only while you chat. Needs
  `MAXX_CHAT_ENABLED=true` and a configured provider.
- **Creative vision**, in the daily sync: up to 20 creatives per run, each analysed once per model.
  Changing the vision model re-analyses creatives rather than mixing two models in one comparison,
  which costs one call per creative again.
- **Competitor analysis**, in the daily sync: up to 20 new Ad Library ads per run, text only.
- **Signals judge**, Mondays in the daily sync: one call per new item from the configured expert feeds,
  retried up to 3 times on a transient failure.
- **Setup probe**: `npm run doctor -- --live` and `npm run setup -- --live` make one call of a few
  tokens.
- **Copy studio** (`/creative/copy`): one call per "Generate variants" or "Regenerate this angle",
  only when you press it; at most 10 per 10 minutes. Scoring copy never calls a model
  ([ADR-061](architecture/adr-061-ai-copy-engine.md)).
- **Campaign planning** (`/campaigns/new`, or asking Maxx to draft a campaign): one planning call
  (feature `campaign_planning`, effort `low`, 4,000 output tokens) plus one copy-generation call per
  draft with "Draft with AI" on; at most 10 drafts per 10 minutes. With AI off, or when the model
  fails, the deterministic template planner drafts the plan with no call
  ([ADR-062](architecture/adr-062-campaign-plans.md)).

## AI off

Set `AI_PROVIDER=none`, or leave it unset with no Claude key. Then:

- every gateway entry point throws `AiDisabledError` before an adapter exists, so no client is built
  and no request is attempted (`tests/ai-off.test.ts` asserts this at the network level);
- every page and report renders without a model call;
- the chat page and the Copy studio say AI is off (the studio still scores pasted and existing copy), campaign plans are drafted by the template planner, video generation through Creatify is blocked, and the daily sync
  records the vision, competitor-analysis and signals steps as skipped instead of failing; queued
  creatives and ads wait until AI is switched on.

An invalid AI configuration never stops the app either: AI switches off and the server log names the
variable to fix, never its value. `npm run doctor -- --only=ai` shows the same message.

## What is sent to the provider

Credentials stay in the environment; the gateway records only whether one is present.

| Feature | Sent |
|---|---|
| Owner chat | Your messages, Maxx's operating instructions, and the results of the read-only tools the model calls: account, campaign, ad set, ad and creative metrics, outcome counts and values, diagnostics and recommendations from your warehouse. The tools return no customer names, emails or phone numbers. When you ask for an action, the arguments the model passes (a copy brief, a plan brief, a decision id and amount) are validated by the server, which then runs the Copy studio or the planner as above; the model never sees the result of an approval, because the chat cannot approve. |
| Creative vision | One creative image and its title and body text (truncated), from your own ads. |
| Competitor analysis | The competitor ad's page name, body text and Ad Library id, fenced as untrusted data. |
| Signals judge | The title, link and summary of a feed item, fenced as untrusted data. |
| Report narratives | The computed report figures the narrative describes. |
| Setup probe | A fixed few-word prompt. |
| Campaign planning | Your brief (goal, product, offer, audience description, countries; fenced as data), the account's synced custom audience ids, names, types and approximate sizes, and up to 20 creatives as opaque references (A1, A2…) with their names and whether each is an image, a video or an existing ad. No budget, spend, results, hashes or customer data. Copy for the plan is generated with the Copy studio call below. |
| Copy studio | Your brief (fenced as data), the business profile's verified facts and requires-verification list, up to 5 ranked hooks and headlines from your own ads with their link CTR and impressions, and the cited hook-pattern menu. |

Third-party text (competitor ads, feed items, creative copy) is wrapped as untrusted data in every
prompt, and model output is schema-validated where it is stored and rendered without images or raw
HTML ([security-model.md](security-model.md#inbound-data-is-untrusted)). Your provider's own terms
govern retention of what it receives; choose a provider and plan whose data-use terms fit your
business.

## Verification status

Structured-output schemas and effort/fallback combinations are tested against stub providers. A
paid check against the live API is pending; report problems through an
issue.
