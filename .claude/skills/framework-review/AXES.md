# Review axes

Each bullet is a question to answer with evidence. Not every bullet applies to every framework;
mark `n/a` with a reason rather than skipping silently.

## 1. Type safety of the dependency graph (central axis)

- Missing provider / wrong wiring → `tsc` error, assembly error, or runtime error? Which one, for
  each kind of mistake.
- Tokens: typed (`Token<T>`, class) vs strings/symbols; is `T` preserved through `inject()`/getters.
- Scope mismatch (singleton depending on per-run/per-thread) caught by types? at assembly? never?
- Cycles: static, at start, never.
- `any`/`unknown` leaks: factories, multi-providers, generic plugins, decorators metadata.
- Quality of type errors: can an agent tell _what to edit_ from the message? Branded error types?
- Cost of type-level machinery: instantiation depth, `tsc` time on the example.

## 2. API fitness for an agent author

- One canonical way per task, or several equivalent ones? Count them.
- Locality: how many files/places to touch to add a node / tool / router / agent.
- Context budget: is the signature enough to know the contract, or must the agent read the impl?
- Hidden magic invisible in text: `reflect-metadata`, auto-scan, ambient registration, side-effect
  imports.
- Prior art and **false friends** (looks like Nest/Angular, behaves differently).
- Predictable names: can the API be guessed without the docs?

## 3. Extensibility model

- Explicit extension points: interceptors/middleware around node/tool/model, lifecycle hooks,
  custom node kinds. Possible without forking the core?
- Module boundaries / encapsulation vs everything global.
- Override & decorate a provider (tests, tenant, other LLM) without touching consumers.
- Multi-providers / collections: typed, union of concrete types preserved?
- Plugin contracts separated from internals.

## 4. Agent-specific abstractions

- Graph state typing: schema, channels, reducers; is "node B reads what node A writes" checked?
  State type after composing subgraphs.
- Single source of truth for tool schema / structured output / TS type, or duplication.
- Scopes: per-run, per-thread, per-tenant.
- DI vs checkpointing/resume: injected deps are not in state — what happens on resume, interrupt,
  human-in-the-loop?
- Subgraph composition: how deps reach a subgraph (inherit / isolate / explicit).
- Async & cancellation: async factories, disposal, `AbortSignal`, parallel branches sharing deps.

## 5. Testability

- Swap providers in tests without rebuilding the graph: fake LLM, recorded answers, replay.
- Type-level tests (`expect-type`, `tsd`, `@ts-expect-error`) guarding the typing guarantees.
- Fail-fast: does misconfiguration fail at start or at the first call of a node minutes later?

## 6. Introspection & observability

- Dump the container graph and the agent graph (for humans and reviewer agents).
- "Why did X resolve to Y" — explainable?
- Tracing per node/tool tied to providers.

## 7. Public surface & evolution

- Size of the public API; public vs internal separation (`exports`, barrel files, deep imports).
- Are breaking changes caught by types at consumers?
- Migration path (codemods are cheap for agents only with precise types).

## 8. Static types vs agent dynamics

- Dynamic tool sets (MCP, per-request tools): typed boundary (validate → `unknown` → `T`) or types
  just stop?
- Sanctioned escape hatch: exists, greppable? Otherwise agents invent `as any`.
- Runtime validation at boundaries (LLM output, tool results, external data) uses the same schema
  object the TS type comes from?

## 9. State evolution & long-running runs

- State schema versioning; checkpoints from an older schema; migrations; version in checkpoint.
- Graph versioning: deploy a new agent while old runs are in flight.
- Event stream typed as a discriminated union, not `{type: string, data: any}`.

## 10. Security & isolation via DI

- Capability-based injection: a node gets only the tools/clients/secrets it was given. Can you
  answer "what can this node do" from the graph?
- Secrets kept out of state, logs, traces; branded type?
- Tenant isolation guaranteed by scope.
- Trust boundaries: untrusted data (tool output, web) marked at type level (taint) — prompt
  injection hygiene.

## 11. Prompts & models as dependencies

- Prompt as a provider; template variables typed; missing variable is a `tsc` error?
- Prompt ↔ model coupling visible, or the model is swapped silently?
- LLM provider abstraction: capability differences (tool calling, structured output, vision,
  context window) in types, or hidden behind a common interface that fails at runtime?

## 12. LLM cross-cutting concerns

- Retries, fallback model, caching, rate limits, token/cost budgets — uniform via interceptors or
  per node?
- Error semantics: typed errors / Result vs `throw`; "model returned garbage" vs "tool failed" vs
  "budget exhausted" distinguishable? Partial failure of parallel branches.
- Determinism: record a run and replay it with the same answers.

## 13. Coupling to the underlying runtime

- How much LangGraph/LangChain leaks through the public API? Which of its types are visible?
- Would a minor LangGraph bump break the public API?
- Is swapping the runtime possible at all, or an illusion (say which — both are legitimate, but
  the docs must not promise the first if it is the second).

## 14. Keeping agent-written code consistent

- Architectural fitness functions: ESLint rules / dependency-cruiser forbidding DI bypass (direct
  `new` of clients, imports from internals).
- Agent docs as an artifact (CLAUDE.md, AGENTS.md, skills, llms.txt): checked for staleness? Do
  they match the code?
- Examples compile in CI (stale example is worse than none).
- Diff reviewability: do conventions yield small predictable diffs?
- Repo hygiene that leaks into agent context (stray scripts, logs, specs at root).

## 15. Operational

- Container/resolve overhead per run; cold start.
- Portability: Node/Bun/Deno/edge, ESM/CJS, tree-shaking (esp. with `reflect-metadata`).
- Typed configuration and profiles (dev/staging/prod, per-tenant overrides).
- Dependency weight & supply chain: transitive packages of the core; heavy deps in core that
  belong in optional entries.

## 16. Evals integration

- Run the graph on a dataset with swapped providers, no separate harness.
- Traces linked to eval results.
- A/B of two provider configs (model, prompt).

## 17. CLI (ng-style tooling)

### Non-interactive & machine-readable

- Every TTY prompt has a flag; without TTY it fails fast with "missing flag X", never hangs.
- `--json` on every command: created/changed files, warnings, next steps; stable versioned schema.
- Meaningful exit codes (usage / project validation / conflict / internal).
- No TTY noise outside TTY; `NO_COLOR` respected.
- `--dry-run` with a full diff, not just a file list.

### Generators

- Generated code is green immediately: `generate` → `tsc` → `lint` without edits.
- Auto-wiring: the generator registers the entity in module/index/config itself.
- AST edits (ts-morph etc.), not regex/string insertion; survive unusual formatting.
- Idempotent: second run is a no-op or an explicit conflict; no duplicate registration.
- Minimal diff: does not reformat untouched code.
- Templates == docs examples == canonical patterns.
- Composition: "node + tool + provider dependency" in one command or a chain where every step
  compiles.

### Discoverability

- `list` / `describe <generator> --json`: options discoverable from the CLI itself.
- Typed option schema → help, validation and JSON description from one source.
- Consistent grammar (verb + noun, same flag names everywhere).
- Compact but complete `--help`.

### Diagnostics & introspection

- `check`/`doctor`: what `tsc` misses (scopes, cycles, unused providers, module boundaries);
  output `file:line` + reason + suggested fix.
- `graph`: DI graph and agent graph as JSON/Mermaid.
- `explain <token>`.
- Fast enough to run as an agent post-edit hook.

### Migrations

- `ng update`-like versioned codemods with `--dry-run` and a report of what was not migrated.
- State-schema migrations generated via CLI (axis 9).
- CLI/framework version mismatch detected; local install via `npx` preferred.

### Run & dev

- Local run with fake providers, replay a recorded run, evals on a dataset — one command each,
  `--json`.
- New-project scaffold includes AGENTS.md / CLAUDE.md, lint rules (axis 14), `check` wired.

### Performance & safety

- Fast startup (called dozens of times per task).
- No network by default: no blocking update checks; telemetry off or easy to disable.
- Never touches files outside the project; destructive ops only behind an explicit flag.
- One typed config (`defineConfig`), no hidden state in `$HOME`.

### Extensibility

- Third-party generators (schematics-like) with the same contract.
- Optional: CLI as an MCP server (generators and `check` as tools). Debatable — assess, don't
  require.
