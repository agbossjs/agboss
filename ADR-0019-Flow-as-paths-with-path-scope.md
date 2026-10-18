# ADR-0019 — The flow as paths, with a path scope and generated types

- **Status:** Accepted (supersedes the transition DSL of [ADR-0014](ADR-0014-Graph-as-transitions) and the parallel forms of [ADR-0017](ADR-0017-Fork-Join-and-Parallel-Execution))
- **Issue:** #272 (with #270, #271; parent #260; design #258)

## Context

The transition DSL — `from(A).next(B)`, `from(Router).routes()`, `chain(…)`, `node(Class, "name")`,
`catchError`, `batchParallel` — did not read at a glance: a workflow was a bag of edges, the data an
agent read was the whole state (task, contributions, `{{item}}`), and nothing said which values a
node could rely on. Relations "by class" were checked only at startup; the compiler saw empty
classes. Rollback was a saga engine that could not know how to undo a tool call.

## Decision

- **A flow line is a path** that reads as a sentence: `start(S).returns(InputDto).toRouter(R)
  .chooseOne(route(A).returns(XDto).toFinish(F), …)`. Transitions name the target's kind
  (`toAgent`, `toRouter`, `toAction`, `toFinish`); `.returns(…)` writes on the edge what the step
  gave (one value per `.returns`, #299); `.returns(oneOf(…)).switch(caseOf(…))` branches by the class of a `oneOf` result; `.onError(E, <side path>)`
  stands right after the step that throws. A node reached from two places has its own path
  (`agent(X)…`); one class is one node. Position never carries meaning ([Workflow](Workflow)).
- **Components declare types only**: `input` by field (`{ draft: OfferDraftDto }`) and `output`
  (`XDto`, `oneOf(…)`, `listOf(…)`). The path's **scope** fills each field by type
  ([Path scope](Path-scope)); one analyser to a fixed point proves the data rules
  (`[input.missing-on-path]`, …) at assembly.
- **Generated types**: `agboss check` loads the workflows (tsx, transpile-only), runs the same
  analyser and writes `.agboss/types.d.ts` — tables keyed by each component's `name` that type
  `.returns(…)`, `InputOf<X>` (path-sensitive, the exact union up to 32 shapes) and
  `app.execute(Start, input)`. Without the file the compiler names the fix instead of `any`.
- **Names end with their kind** (`main-router`, `draft-agent`, `chat-workflow-start`), explicit and
  unique in the application — they key records, checkpoints, traces and the generated types. DTO
  classes end with `Dto`.
- **Agents read an input message** (`### field (from producer)` + JSON) after static instructions,
  and answer a structured `output` through answer tools (`answer-<dto>`), retried twice when invalid.
- **Rollback is explicit**: `.onError(Err, toAction(UndoAction)…)` — no automatic compensation
  ([Rollback](Rollback)). `maxVisits` on routers and agents; a visit past it fails before the model
  call with `VisitsLimitExceededError`, which `.onError` can take.
- **One `StateGraph` per workflow**, node ids are the components' names; the scope is its own
  channel, error records are plain data, so `.onError` holds after a resume.

## Consequences

- Easier: a workflow is read top to bottom; what a node reads is visible and proven; most mistakes
  are compile errors, the rest assembly errors with the path that breaks them; prompts stay static
  and cache across runs.
- Harder: a project needs `agboss check` before `tsc` (generated projects run it on install, the
  gate before typecheck); every class the types mention must be exported; names are longer.
- Not yet: parallel launches and joins (#273), child workflows (#263), code routers (#280) — they
  build on the paths. The old DSL, `@WorkflowAction`, sagas and `agboss/concurrency` are removed.
