# Vendor marks

The report draws each platform and harness by its own logo. The paths are inlined in
[`src/chart/tokens.ts`](../../src/chart/tokens.ts) (`VENDOR_PATHS`) so the page needs no
network, and are drawn in the report's series colour rather than the vendor's.

All of them come from LobeHub's icon set, MIT-licensed ([LICENSE](LICENSE), © 2023 LobeHub):
package `@lobehub/icons-static-svg` 1.95.1, the monochrome `icons/<file>.svg`, paths copied
verbatim. Upstream: <https://github.com/lobehub/lobe-icons>. No vendor's own published mark
was needed — LobeHub carries all eight.

| Mark          | Drawn for                                   | File              |
| ------------- | ------------------------------------------- | ----------------- |
| `openai`      | OpenAI API, GPT/o-series models, Codex      | `openai.svg`      |
| `claude`      | Claude models                               | `claude.svg`      |
| `claudecode`  | Claude Code (ccusage agent `claude`)        | `claudecode.svg`  |
| `anthropic`   | the Anthropic API platform                  | `anthropic.svg`   |
| `openrouter`  | OpenRouter                                  | `openrouter.svg`  |
| `antigravity` | Antigravity                                 | `antigravity.svg` |
| `gemini`      | Gemini the product (Gemini models and CLI)  | `gemini.svg`      |
| `googlecloud` | anything named as run on GCP / Vertex       | `googlecloud.svg` |
| `pi`          | Pi Agent (pi.dev; LobeHub's "Pi" is that)   | `pi.svg`          |

Local agent usage without a named agent keeps a drawn terminal prompt, and a name that
identifies no vendor keeps the neutral ring. Logos remain their owners' trademarks; they
identify who served a row and imply no endorsement.
