# Try agboss on a subscription

> **Demo and local testing only. Never production, never commercial use.**
> agboss does not and cannot guarantee that running a vendor's CLI from an application complies with
> that vendor's terms. We warn; the account risk is yours. Read each vendor's terms below before you
> run anything.

You can try agboss on a ChatGPT, Claude or Gemini plan you already pay for, without issuing an API key:
a model provider that runs **your own, unmodified vendor CLI**, headless, under **your own login**.
It is not part of `@agboss/core`. It is a ready-made example, `01-hello-agboss` of
[agbossjs/agboss-examples](https://github.com/agbossjs/agboss-examples/tree/main/01-hello-agboss), that
plugs in through the public transport contract of [Model providers](Model-providers): a class with
`@ModelProvider({ … })` and `complete(request: ModelProviderRequest): Promise<ModelProviderResponse>`.
Copy `src/cli-providers/` into your project and list the provider in `@Application({ providers })`.

| Provider | CLI | Terms | Risk flag |
| --- | --- | --- | --- |
| `CodexCliModelProvider` | `codex exec` | OpenAI documents `codex exec` on a ChatGPT login for "users who need ChatGPT/Codex rate limits" | none |
| `claudeCliModelProvider({ … })` | `claude -p` | Anthropic prohibits this for third-party products | `acknowledgeVendorTermsRisk: true` |
| `geminiCliModelProvider({ … })` | `gemini -p` | Google's Gemini CLI terms prohibit this for third-party tools | `acknowledgeVendorTermsRisk: true` |

The flag is typed as the literal `true`: leaving it out, or passing `false`, does not compile (plain
JavaScript gets a thrown error when the provider is made). Nothing is refused anywhere else: each
provider logs a warning when the application starts, quoting the vendor's terms with their URLs.

```ts no-check: example 01's code in agbossjs/agboss-examples, not an agboss export
import { Application, SqliteCostLedgerRepository } from "@agboss/core";
import { claudeCliModelProvider } from "./cli-providers/claude-cli.provider.js";

// Anthropic's terms prohibit this for third-party products: read the startup warning, then decide
const ClaudeCliModelProvider = claudeCliModelProvider({ acknowledgeVendorTermsRisk: true });

@Application({
  name: "my-claude-cli-application",
  providers: [ClaudeCliModelProvider, SqliteCostLedgerRepository],
  // …
})
export class MyApplication {}
// an agent says `model: "claude-cli/default"` (the CLI's default model) or `"claude-cli/<model id>"`
```

## Run example 01 on your plan

Install the vendor's CLI and log in with the CLI's own command. Then, in `01-hello-agboss`, run the
script of your vendor: `demo:codex-cli`, `demo:claude-cli` or `demo:gemini-cli` (each runs
`npx tsx src/demo.cli.ts <vendor>`). No API key is needed, and none is passed to the CLI.

**Codex.** `codex login` (a ChatGPT plan), then `demo:codex-cli`. In the demo the example's agents say
`openai/gpt-4o-mini`; the provider serves that name too, and the CLI's default model answers. The
warning it logs:

> codex-cli-model-provider runs your own codex CLI on your own plan. Demo / local testing only, not
> for production or commercial use. agboss does not and cannot guarantee that this use complies with
> the vendor's terms; the account risk is yours.

Terms: <https://learn.chatgpt.com/docs/non-interactive-mode> and <https://openai.com/policies/row-terms-of-use/>.

**Claude.** Anthropic's own words:

> "Anthropic does not permit third-party developers to offer Claude.ai login into their own
> applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of
> their users." — <https://code.claude.com/docs/en/legal-and-compliance>

> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai
> login or rate limits for their products, including agents built on the Claude Agent SDK." —
> <https://code.claude.com/docs/en/agent-sdk/overview>

The same page also says it does not prevent "an end user from signing in to the unmodified Claude Code
binary with their own Claude subscription", and that Anthropic "reserves the right to take measures to
enforce these restrictions and may do so without prior notice". The consumer terms
(<https://www.anthropic.com/legal/consumer-terms>) forbid accessing the services "through automated or
non-human means, whether through a bot, script, or otherwise" except through an API key or where
Anthropic explicitly permits it. You decide whether this use is within them; if you go on,
`claude auth login`, then `demo:claude-cli`.

*The sanctioned alternative.* The Max, Ultra and Team plans include monthly **API credits** that you
use with an **API key** from the Claude Console: Max $100, Ultra $200, Team $20 per Standard seat and
$100 per Premium seat (capped at $500). A Pro plan has none. Details:
<https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans>.
With a key you are inside Anthropic's terms: use it through an OpenAI-compatible gateway such as
OpenRouter ([Model providers](Model-providers)), or write a transport provider over Anthropic's SDK.

**Gemini.** Google's own words:

> "Directly accessing the services powering Gemini CLI (for example, the Gemini Code Assist service)
> using third-party software, tools, or services (for example, using OpenClaw with Gemini CLI OAuth)
> is a violation of applicable terms and policies. Such actions may be grounds for suspension or
> termination of your account." —
> <https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md>

If you go on, run `gemini` once and sign in, then `demo:gemini-cli`.

*The sanctioned alternative: a free Google AI Studio key.* It is an API key, so it needs no CLI; it
speaks the OpenAI dialect, so the built-in `OpenAiCompatibleProvider` serves it (set the
`geminiApiKey` secret in the application's environment):

```ts file=src/model-providers/gemini-ai-studio.model-provider.ts
import {
  ModelCost, ModelProvider, OpenAiCompatibleProvider, PromptCaching, Reasoning, RetryPolicy,
  TRANSIENT_FAILURES, type NoRequestFields,
} from "@agboss/core/models";
import { minutes, seconds } from "@agboss/core/units";

@ModelProvider({
  name: "gemini-ai-studio-model-provider",
  description: "Google AI Studio through its OpenAI-compatible endpoint",
  serves: [/^gemini\//u],
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
  apiKey: "geminiApiKey",                               // a Secret field of the environment
  timeout: minutes(2),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3, initialDelay: seconds(1), maxDelay: seconds(20), jitter: true,
    retryOn: TRANSIENT_FAILURES,
  }),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
})
export class GeminiAiStudioModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}
```

The free tier has three caveats, from the Gemini API terms (<https://ai.google.dev/gemini-api/terms>,
"Unpaid Services"). Read them before you send anything:

1. **Your content is used to improve Google's products**: "Google uses the content you submit to the
   Services and any generated responses to provide, improve, and develop Google products and services
   and machine learning technologies".
2. **Human reviewers may read it**: "human reviewers may read, annotate, and process your API input
   and output." — "Do not submit sensitive, confidential, or personal information to the Unpaid
   Services." (No personal data, in other words.)
3. **Paid only in Europe**: "You may use only Paid Services when making API Clients available to users
   in the European Economic Area, Switzerland, or the United Kingdom."

## What the example does, and what it costs

- **One call = one CLI run**, in a fresh, empty temp directory that is removed after the process has
  exited. The CLI's own tools (shell, files, browser, MCP, hooks, skills) are switched off with the
  CLI's flags; if the CLI starts one anyway, the run is killed and the call fails. Every tool call goes
  back through agboss: pauses, approvals, the PII boundary, guardrails and limits.
- **The environment is an allowlist** (`PATH`, `HOME`, locale, proxy and CA variables, the CLI's own
  config-directory name). No API key and no agboss secret reaches the CLI.
- **One process at a time**, across the three providers. An aborted or timed-out call kills the whole
  process tree before the next call starts.
- **Tool calls** come back through a per-turn JSON schema: either text, or the tools to call, with
  each tool's parameters in strict form (a tool whose schema cannot be made strict takes its arguments
  as a JSON string). Codex and Claude check the answer against the schema through their own flags;
  Gemini has none, so its answer is parsed from the text, with one re-run on a parse failure.
- **Never the vendors' credential files.** Only the vendor's own CLI touches its login: the example
  does not read, copy or reuse a token, spoof a client or register an OAuth client.
- **Cost and speed.** A plan is flat-priced: budgets count $0 and tokens are still recorded. A step
  sends the whole history again, roughly 10–25k input tokens on Codex, and takes about 5–8 s in a live
  run. No streaming; temperature, max tokens and prompt caching are ignored. The CLIs have no
  reasoning-effort flag but Codex's. Gemini's CLI keeps its chat history in its own folder under your
  home directory and has no ephemeral flag: clear it with the CLI's own tools when you are done.
- **The Claude and Gemini providers are tested against fake CLIs** whose replies are written from the
  vendors' documentation. A live run on your account is yours to make.

Related: [Model providers](Model-providers), [Examples](Example), agbossjs/agboss#951.
