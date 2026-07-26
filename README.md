# aiusage

`ccusage` for the platforms, not the agent.

[`ccusage`](https://github.com/ryoppippi/ccusage) reads local agent logs and tells you what
your coding CLIs cost. `aiusage` asks the **platform billing APIs** the same question, so
the number covers everything your organisation ran through them — apps, pipelines,
notebooks, agents — split by **user account, API key, model and workspace**, priced from
what the platform actually billed.

```bash
npx aiusage                       # daily usage across every configured platform
npx aiusage --json                # ccusage-shaped JSON (see "JSON contract")
npx aiusage keys                  # which API key spent what
npx aiusage accounts --days 7     # which person spent what, last 7 days
npx aiusage monthly -b            # months, with per-model rows
```

## Capability matrix

Each platform answers a different subset of the question. `aiusage` reports what it could
actually get rather than flattening the differences — run `aiusage providers` to see this
for your own credentials.

| | OpenRouter | Together AI | OpenAI Platform | Claude Platform |
|---|---|---|---|---|
| Token usage | yes | **no API** | yes | yes |
| Billed cost | per row | **no API** | per project-day | per model-day |
| Split by model | yes | — | yes | yes |
| Split by API key | with a management key | — | yes | yes |
| Split by user account | derived from key ownership | — | yes | yes |
| Split by workspace/project | yes | — | yes | yes |
| Cache tokens reported | no | — | read + write | read + 5m/1h write |
| Request counts | yes | — | yes | no |
| Lookback | 30 days | — | unlimited | unlimited |
| Live unit prices | `/api/v1/models` | `/v1/models` | LiteLLM table | LiteLLM table |

**Together AI has no usage or cost API.** Its cost analytics are dashboard-only, and the
public API reference contains no usage, cost, billing or audit endpoint (checked
2026-07-26). `aiusage` verifies the key, reports the identity it belongs to, contributes
live per-model pricing — and reports Together's usage as `unsupported` with a warning. A
missing Together total means *unknown*, never *zero*. When Together ships an endpoint, only
[`src/providers/together.ts`](src/providers/together.ts) needs to change.

## Credentials

Read from the environment; see [.env.example](.env.example) for the full list. A platform
without credentials is **skipped and said so**, never reported as zero usage.

| Variable | Platform | Notes |
|---|---|---|
| `OPENROUTER_API_KEY` | OpenRouter | An inference key sees only its own activity. |
| `OPENROUTER_MANAGEMENT_KEY` | OpenRouter | Needed to split by key and account. |
| `OPENAI_ADMIN_KEY` | OpenAI | Must be an **admin** key; project keys get 401. |
| `OPENAI_ORG_ID` | OpenAI | Only for multi-org admin keys. |
| `ANTHROPIC_ADMIN_KEY` | Claude | Admin API key (`sk-ant-admin…`) or org OAuth token. |
| `TOGETHER_API_KEY` | Together | Identity and pricing only. |

## Where the money comes from

Every cost in the output is labelled with how it was established. This is the point of the
tool: a per-key figure that was derived must not look like one the platform billed.

| `costSource` | Meaning |
|---|---|
| `reported` | The platform billed this exact row (OpenRouter activity rows). |
| `allocated` | The platform billed a coarser bucket — a project-day, a model-day — and that real amount was distributed across the rows inside it, in proportion to their derived cost. Platform totals stay equal to the invoice. |
| `calculated` | No billed figure was available: tokens × published unit price. |
| `unavailable` | Neither a billed figure nor a price could be found. Reported as `0` in JSON with `costSource: "unavailable"` — not as free usage. |
| `mixed` | A row aggregates several of the above. |

Allocation exists because no platform attributes *money* to an API key or a person, while
all of them attribute *tokens* that far. Two consequences worth knowing:

- Charges that are not token consumption — web search, code execution, session fees — are
  **not** spread over token counts. They appear in `meta.unattributedCost`.
- OpenAI cost line items are opaque prose, so if your org also uses embeddings, images or
  audio, that billed cost is included in the OpenAI total and allocated across the
  completions usage `aiusage` collects. The `completions-only` notice says so on every run.

Unit prices come from the platform's own catalogue where one exists (OpenRouter, Together)
and otherwise from [LiteLLM's price table](https://github.com/BerriAI/litellm) — the same
source `ccusage` prices Claude Code with. `meta.priceSources` records which was used;
`aiusage pricing` shows the per-model prices and the key each was matched on.

## JSON contract

`aiusage --json` mirrors `ccusage --json` field for field on the shared parts, so anything
already parsing ccusage output keeps working:

```jsonc
{
  "daily": [                       // or "weekly" / "monthly"
    {
      "agent": "anthropic",        // the contributing platform, or "all"
      "cacheCreationTokens": 1500,
      "cacheReadTokens": 200,
      "inputTokens": 1500,
      "metadata": {
        "agents": ["anthropic"],
        "providers": ["anthropic"],
        "costSource": "allocated",
        "requests": null,
        "reasoningTokens": 0
      },
      "modelBreakdowns": [
        { "modelName": "claude-opus-4-6", "inputTokens": 1500, "outputTokens": 500,
          "cacheCreationTokens": 1500, "cacheReadTokens": 200, "cost": 2.5,
          "costSource": "allocated", "provider": "anthropic", "requests": null }
      ],
      "modelsUsed": ["claude-opus-4-6"],
      "outputTokens": 500,
      "period": "2026-07-25",
      "totalCost": 2.5,
      "totalTokens": 3700,

      // aiusage additions, present only for the splits you asked for:
      "apiKeyBreakdowns": [ /* { id, name, …tokens, cost, costSource, providers, models } */ ],
      "accountBreakdowns": [ /* … */ ]
    }
  ],
  "totals": { "cacheCreationTokens": 1500, "cacheReadTokens": 200, "inputTokens": 1500,
              "outputTokens": 500, "totalCost": 2.5, "totalTokens": 3700,
              "requests": null, "costSource": "allocated" },
  "meta": {
    "tool": "aiusage", "version": "0.1.0", "generatedAt": "…",
    "granularity": "daily", "range": { "since": "…", "until": "…" }, "timezone": "UTC",
    "costIncluded": true, "priceSources": ["litellm@2026-07-26"],
    "providers": [ /* per platform: status, capabilities, identity, recordCount, totalCost */ ],
    "unattributedCost": [ /* billed money that is not token consumption */ ],
    "notices": [ /* every diagnostic: code, level, provider, message */ ]
  }
}
```

Additive only: aiusage adds keys, it never drops or repurposes a ccusage one. The
compatibility contract is pinned by [tests/report.test.ts](tests/report.test.ts).

## Commands and flags

```
aiusage [daily]                 usage grouped by day (default)
aiusage weekly | monthly        ISO weeks (Monday-labelled) / calendar months
aiusage models                  grouped by model, across the window
aiusage keys | accounts | workspaces
aiusage providers               capability matrix for your credentials
aiusage pricing [--model <id>]  unit prices with their source
```

`-j/--json` · `-s/--since <date>` · `-u/--until <date>` · `--days <n>` · `-z/--timezone <tz>`
· `-p/--provider <list>` · `--split <model,apiKey,account,workspace,provider>` ·
`-b/--breakdown` · `-O/--offline` · `--no-cost` · `--compact` · `--color/--no-color`.

Dates accept `YYYY-MM-DD` or `YYYYMMDD`. The default window is the trailing 30 days —
OpenRouter's hard lookback limit, so the default is a window every platform can answer.

Exit codes: `0` success, `1` a platform failed (its rows are missing and a notice says so),
`2` bad invocation.

**Timezones.** Platforms bucket usage in UTC. With `--timezone` set to anything else,
OpenAI and Anthropic are queried in *hourly* buckets so a local day is grouped correctly;
OpenRouter only reports whole UTC days and emits a `timezone-approximation` warning.

## Library use

The pipeline is plain functions over plain data, and the HTTP client is injectable:

```ts
import { applyCosts, collectUsage, loadConfig, loadPriceBook } from 'aiusage';

const config = loadConfig();
const collection = await collectUsage({ config, range, timeZone: 'UTC' });
const { priceBook } = await loadPriceBook({ /* … */ });
const { records, unattributed } = applyCosts(collection.results, priceBook);
```

## Development

```bash
mise run setup     # cold start: toolchain, frozen deps, git hooks, verify
mise run check     # lint + format + typecheck + tests — the definition of done
```

See [AGENTS.md](AGENTS.md) for the working agreement.

## Known limits

- Together AI usage is not obtainable (see above).
- OpenAI: only *completions* usage is collected; other products' cost lands in
  `unattributedCost` or is allocated across completions (flagged per run).
- OpenRouter: no cache-token split, 30-day lookback, and account attribution is derived
  from key ownership (`tags.accountAttribution: "key-creator"`) because OpenRouter does not
  attribute an activity row to the member who made the request.
- **Unresolved:** Together's `/v1/models` price unit is undocumented and its catalogue
  needs a key, so it is read as USD per million tokens with implausible values dropped.
  Verify against an invoice before relying on Together prices.

## Licence

MIT
