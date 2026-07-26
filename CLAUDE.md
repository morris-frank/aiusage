# Working agreement

For humans and agents alike. `CLAUDE.md` is a byte-identical copy — change both.

`aiusage` reports token usage and cost from remote LLM platform billing APIs in a
ccusage-compatible shape. It is a reporting tool over other people's money: the cost of a
wrong number here is someone budgeting, charging back, or choosing a model on a fiction.
The rules below exist to make that impossible to do quietly.

## Golden rules

1. **Absent is not zero.** A platform without credentials is `skipped`; one that fails is
   `error`; one with no usage API is `unsupported`. Every one of those appears in
   `meta.providers` with a notice. Never let a missing platform silently shrink a total.
2. **Label every cost with its provenance.** `reported` (the platform billed this row) >
   `allocated` (billed coarser, distributed by derived cost) > `calculated` (tokens × unit
   price) > `unavailable`. New cost paths pick one of these or add a documented fifth; they
   never inherit a stronger label than they earned.
3. **Never invent a number.** No default prices, no assumed exchange rates, no parsing an
   undocumented string into a model id. Where the platform is silent, return `null` and add
   a diagnostic. `null` means "not reported"; `0` means "reported as zero".
4. **Report the capabilities of the run, not of the docs.** `DECLARED_CAPABILITIES` is the
   ceiling; what `collect` returns must reflect the credentials actually in hand (an
   OpenRouter inference key reports `splitByApiKey: false`).
5. **Money is integer micro-USD** (`money.ts`) everywhere inside the package; float USD only
   at the JSON/table boundary. Allocation must sum back to the billed total exactly —
   `allocateProportionally` is the only way to split an amount.
6. **The ccusage JSON shape is a contract.** Shared keys keep their names and meanings;
   additions are additive. [tests/report.test.ts](tests/report.test.ts) pins the key sets
   against real `ccusage --json` output — if you change a shared key, that test should stop
   you.
7. **All HTTP goes through `HttpClient`.** One retry policy, one timeout, one redaction
   pass. Secrets never reach an error message or a log line. `fetchImpl` is injected so no
   test ever touches the network.
8. **Verify API shapes against the provider's docs before coding them.** Every endpoint,
   parameter and field in `src/providers/` was read off the platform's own reference. Cite
   the source in a comment when it is not obvious, and date claims about what an API lacks.
9. **One diagnostic per real problem, with a stable `code`.** Codes are greppable and
   effectively public API (`not-configured`, `group-by-reduced`, `cost-unattributed`,
   `usage-api-unavailable`, `price-missing`, `timezone-approximation`, …). Reuse before
   inventing.
10. **Comments explain why, not what.** Especially: why a platform is queried the way it is,
    and which decisions are assumptions rather than documented behaviour.

## Layout

```
src/
  types.ts          domain vocabulary: UsageRecord, CostRecord, capabilities, diagnostics
  config.ts         env → credentials + runtime knobs; no config framework
  dates.ts          windows, timezone-aware period keys, UTC-bucket reality
  money.ts          micro-USD arithmetic and exact proportional allocation
  http.ts           the only fetch path: retries, timeouts, redaction, query encoding
  concurrency.ts    bounded fan-out
  collect.ts        runs the providers, one result per platform including skipped ones
  cost.ts           measurement → money, with provenance (reported/allocated/calculated)
  aggregate.ts      grouping by period and by dimension
  report.ts         the JSON contract (ccusage-shaped + additive meta)
  render.ts         terminal tables, capability matrix, notices
  cli.ts            argument parsing and command dispatch (pure; returns an exit code)
  bin.ts            the executable: process wiring only
  pricing/          price books: platform catalogues, LiteLLM table, disk cache
  providers/        one module per platform + shared pagination
tests/              vitest; fixtures inline, HTTP stubbed, integration.test.ts spans all four
```

## Conventions

- TypeScript, ESM, **zero runtime dependencies** (Node built-ins only) — `npx aiusage`
  should start fast and pull nothing.
- Platform payload types are declared locally in each provider with every field optional:
  these are untrusted responses, and `noUncheckedIndexedAccess` /
  `exactOptionalPropertyTypes` are on.
- Provider modules export `create<Platform>Provider(credentials)` and
  `<PLATFORM>_CAPABILITIES`; they never read `process.env` themselves.
- Test names state the behaviour and the reason ("reports usage as unsupported and never as
  zero"), not the function name.
- Snake_case only where a platform's wire format demands it.

## Workflow

```bash
mise run setup     # cold start: toolchain, frozen deps, git hooks, verify
mise run check     # lint + format-check + typecheck + tests (what CI runs)
mise run test      # tests only; also the pre-push hook
mise run build     # tsc → dist/
mise run audit     # osv-scanner against pnpm-lock.yaml
mise run secrets   # gitleaks over the working tree
```

Dependencies via `pnpm add`; never hand-edit `pnpm-lock.yaml`. Tool versions live in
`mise.toml` and nowhere else.

## Definition of done

- `mise run check` is green.
- New logic has a direct test; a new provider has a fixture-driven test covering its
  success path, its degraded path (reduced grouping / missing names / failed cost) and its
  auth failure.
- Any new cost or token path carries a provenance label and is reflected in
  `ProviderCapabilities`.
- README's capability matrix and `.env.example` match what the code actually does.
- Assumptions that could not be verified are marked `UNRESOLVED` in the code and listed
  under "Known limits" in the README.
