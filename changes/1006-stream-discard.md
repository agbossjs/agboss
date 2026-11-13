---
section: Added
issue: 1006
---

**Streamed text carries its step and can be retracted** (#1006): every `textDelta` of `onStream`
has `step: { agent, visit, branch, attempt }`, and the new `{ kind: "discarded", step, reason }`
event retracts what was streamed for a step — a draft a judge rejected (`judge-rejected`), the text
before a tool call (`tool-turn`), a refused move (`invalid-answer`), a call that broke after partial
chunks (`stream-broken`), a failed visit (`failed`). The deltas of the steps not discarded, joined,
are the reply. `StreamStep` and `DiscardReason` are exported. A consumer that wrote every `delta`
(`process.stdout.write(event.delta)`) should apply `discarded`; `agboss run` prints
`[Retracted: …]` to stderr. A2A: a retry or another step starts the artifact anew
(`append: false`).
