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
npx aiusage --local               # platforms *and* local agents, via ccusage
npx aiusage report --out spend.svg  # the report figure
```

## Capability matrix

Each platform answers a different subset of the question. `aiusage` reports what it could
actually get rather than flattening the differences — run `aiusage providers` to see this
for your own credentials.

| | OpenRouter | Together AI | OpenAI Platform | Claude Platform | Local (ccusage) |
|---|---|---|---|---|---|
| Token usage | yes | **no API** | yes | yes | yes (local logs) |
| Cost | reported per row | **no API** | per project-day | per model-day | `imported` |
| Split by model | yes | — | yes | yes | yes |
| Split by API key | with a management key | — | yes | yes | no |
| Split by user account | derived from key ownership | — | yes | yes | no |
| Split by workspace/project | yes | — | yes | yes | no |
| Split by agent | — | — | — | — | yes |
| Cache tokens reported | no | — | read + write | read + 5m/1h write | read + write |
| Request counts | yes | — | yes | no | no |
| Lookback | 30 days | — | unlimited | unlimited | as far as the logs go |
| Live unit prices | `/api/v1/models` | `/v1/models` | LiteLLM table | LiteLLM table | ccusage's own |

**Several OpenRouter workspaces.** An OpenRouter management key is scoped to one
workspace, so the credential is a *list*: set `OPENROUTER_MANAGEMENT_KEY_<LABEL>` once per
workspace (or a comma-separated list in one variable). The label names that workspace in
reports when the key sees exactly one — tagged `workspaceNameSource: "credential-label"`,
because OpenRouter has no workspace-name API. Every key is verified with
`GET /api/v1/key` first, so a management key pasted into `OPENROUTER_API_KEY` is still used
as one, and a key visible to two management keys is collected once.

**Local agents (`--local`).** [ccusage](https://github.com/ryoppippi/ccusage) reads the
coding agents' own logs on this machine and prices them itself. `aiusage --local` runs it
and fuses its rows in as a fifth source, split by **agent** (`aiusage agents`). Two things
this changes, both stated on every run: its cost is labelled `imported`, not `reported`
(see below), and an agent billed through an API key is also inside that platform's total —
so the fused number can count the same traffic twice. `local-overlap-possible` says so
whenever both are present. Subscription-billed agents (Claude Max, Codex plans) do not
overlap.

ccusage collection deliberately uses `daily`, not `session`: `session` also exposes which
project a session ran in, but its bucketing is coarser (a session's tokens land entirely
on its last-activity day) — measured on one machine, that shifted a 27-day window's total
by about 16% for no real gain, since ccusage only reports project paths for some agents in
the first place. `daily`'s exact day-bucketed totals win.

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
| `OPENROUTER_MANAGEMENT_KEY` | OpenRouter | Needed to split by key and account. `OPENROUTER_PROVISIONING_KEY` is accepted too. |
| `OPENROUTER_MANAGEMENT_KEY_<LABEL>` | OpenRouter | Repeatable — one per workspace. |
| `OPENAI_ADMIN_KEY` | OpenAI | Must be an **admin** key; project keys get 401. |
| `OPENAI_ORG_ID` | OpenAI | Only for multi-org admin keys. |
| `ANTHROPIC_ADMIN_KEY` | Claude | Admin API key (`sk-ant-admin…`) or org OAuth token. |
| `TOGETHER_API_KEY` | Together | Identity and pricing only. |
| `AIUSAGE_CCUSAGE_CMD` | Local | How to run ccusage for `--local`; discovered otherwise. |

OpenAI and Anthropic remain one credential each: their admin keys are org-scoped, and
multi-org reporting is not implemented.

## Where the money comes from

Every cost in the output is labelled with how it was established. This is the point of the
tool: a per-key figure that was derived must not look like one the platform billed.

| `costSource` | Meaning |
|---|---|
| `reported` | The platform billed this exact row (OpenRouter activity rows). |
| `allocated` | The platform billed a coarser bucket — a project-day, a model-day — and that real amount was distributed across the rows inside it, in proportion to their derived cost. Platform totals stay equal to the invoice. |
| `imported` | Restated from another tool's own calculation (ccusage, pricing local agent logs from the LiteLLM table). No platform billed it; for a subscription-billed agent it is the API-equivalent of those tokens, not money spent. |
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
aiusage agents                  grouped by agent — ccusage agent names, with --local
aiusage providers               capability matrix for your credentials
aiusage pricing [--model <id>]  unit prices with their source
aiusage report                  the report figure — 90-day window, --local implied
```

`-j/--json` · `-s/--since <date>` · `-u/--until <date>` · `--days <n>` · `-z/--timezone <tz>`
· `-p/--provider <list>` · `--split <model,apiKey,account,workspace,provider,agent>` ·
`-b/--breakdown` · `--local` · `-O/--offline` · `--no-cost` · `--compact` ·
`--color/--no-color`. `report` also takes `--out <file>`, `--format svg|html`, `--print` and
`--granularity daily|weekly|monthly`.

`report` fuses local agent usage by default — it's usually a person looking at their own
machine's whole picture — and defaults to writing an HTML file to `~/Downloads` (named after
the report's date range) rather than stdout. `--no-local` drops the local fusion; `--print`
opts back out to stdout; an explicit `--out` always wins; `--json` is unaffected either way.

Dates accept `YYYY-MM-DD` or `YYYYMMDD`. The default window is the trailing 30 days —
OpenRouter's hard lookback limit, so the default is a window every platform can answer —
except for `report`, which defaults to 90 days so a daily figure has enough of a trend to draw.

Exit codes: `0` success, `1` a platform failed (its rows are missing and a notice says so),
`2` bad invocation.

**Timezones.** Platforms bucket usage in UTC. With `--timezone` set to anything else,
OpenAI and Anthropic are queried in *hourly* buckets so a local day is grouped correctly;
OpenRouter only reports whole UTC days and emits a `timezone-approximation` warning.

## The report figure

`aiusage report` draws the same numbers as stacked panels on one shared time axis:

1. **cost per period**, stacked by series;
2. **cumulative cost** per series, each line labelled at its end point;
3. **tokens per period**, stacked by the same series — where the volume went is rarely the
   same shape as where the money went;
4. **top models**, ranked by cost (or tokens) as a dot chart — position along a shared scale,
   not area or a colour ramp — coloured by the *provider* that served each model rather than
   a per-model hue; the tail beyond the top few folds into a disclosed "Other N models" row,
   and a model billed under more than one provider gets the neutral mark instead of either
   provider's colour;
5. **token mix**, the share of each period that was uncached input, output, cache write and
   cache read, so a change in caching shows up on its own axis.

With `--no-cost` the two cost panels are dropped rather than faked, and the token panels
take both the composition and the accumulation. Each series carries a vendor mark as well
as a colour, so no series depends on hue alone; the marks are original glyphs, not vendor
logos, and a name that does not identify a vendor gets a neutral one.

Output is a self-contained SVG (no fonts, no scripts, no network), or a printable white page
with `--format html` — which adds a summary strip, the period table with a cost bar and a
token-mix bar per row, what every source actually answered, and every notice.

```bash
aiusage report --days 30 --out spend.svg          # series = provider
aiusage report --local --split agent --out by-agent.svg
aiusage report --granularity monthly --days 365 --format html --out year.html
aiusage report --json                              # the numbers behind the figure
```

The caption is part of the deliverable: it carries the window, the cost provenance of what
is plotted, the price sources, any source that did not fully report, and billed cost that
is not token consumption. A figure that gets forwarded without its table should still be
impossible to over-read.

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
- `--local` can double-count: local agent rows and a platform's rows may describe the same
  traffic, and nothing in the logs says which key a session used. Warned per run, never
  silently deduplicated.
- Local agent rows are not re-priced: an agent log names a model but not the vendor that
  served it, so `aiusage` reports ccusage's figure as `imported` rather than guessing a
  vendor to look the price up under.
- **Unresolved:** Together's `/v1/models` price unit is undocumented and its catalogue
  needs a key, so it is read as USD per million tokens with implausible values dropped.
  Verify against an invoice before relying on Together prices.

## Licence

MIT
