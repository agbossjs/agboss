// The old inline shards of `stryker.config.mjs`, as functions like the newer groups' (#1376): the A2A tasks, server, client and direct replies, and the stream.

/**
 * The A2A tasks (#807): the task store in memory and in SQLite (one execution per message, a
 * status by compare-and-set, sticky terminal states, pages, the sweep), the reserved execution id,
 * the cancel of one tree and its durable state, the task projection and its read repair
 */
export function a2aTasksShard() {
  return {
    configFile: "vitest.mutation-a2a.config.ts",
    mutate: [
      "src/infrastructure/a2a-task.repository.ts",
      "src/infrastructure/a2a-task-pages.ts",
      "src/infrastructure/in-memory-a2a-task.repository.ts",
      "src/infrastructure/sqlite/sqlite-a2a-task.repository.ts",
      "src/infrastructure/sqlite/sqlite-a2a-task-{rows,sweep,pages}.ts",
      "src/app/execution-control.ts",
      "src/app/tree-control.ts",
      "src/app/execution-trees.ts",
      "src/a2a/tasks/task-status.ts",
      "src/a2a/tasks/a2a-task-projection.ts",
      "src/a2a/tasks/a2a-task-repair.ts",
      // #808: the server's admission of a request, its caller and owned task, the end of a task
      // no execution can start under, and the wake-ups of a task's waiters
      "src/a2a/tasks/task-changes.ts",
      "src/a2a/server/a2a-admitted.ts",
      "src/a2a/server/a2a-server-parts.ts",
    ],
  };
}

/**
 * #824: the server's accept, follow-up, cancel, wait and stream, ListTasks, and the assembly rule
 * that keeps an application's A2A tasks where its instances share them
 */
export function a2aServerShard() {
  return {
    configFile: "vitest.mutation-a2a-server.config.ts",
    mutate: [
      "src/a2a/server/a2a-accept.ts",
      "src/a2a/server/a2a-follow-up.ts",
      "src/a2a/server/a2a-follow-up-outcome.ts",
      "src/a2a/server/a2a-cancel-task.ts",
      "src/a2a/server/a2a-task-wait.ts",
      "src/a2a/server/a2a-stream.ts",
      "src/a2a/server/a2a-list-tasks.ts",
      "src/a2a/a2a-task-store-rule.ts",
      // #810: the inbound mesh check — the audience first, then the signature, window and body
      "src/a2a/server/a2a-mesh-admission.ts",
      // #1256: the slots of the fetches of files by url, across messages
      "src/a2a/files/a2a-file-slots.ts",
      // #1320: the signed HTTP request of a peer — verified first, admitted once, allowed this endpoint
      "src/mesh/mesh-http.ts",
      "src/mesh/mesh-http-admission.ts",
      "src/a2a/server/a2a-peer-gate.ts",
      "src/mcp/mcp-http-gate.ts",
      // #1319: an MCP session belongs to the identity that opened it
      "src/mcp/mcp-http-listener.ts",
      "src/mcp/mcp-http-failure.ts",
      "src/mcp/mcp-http-io.ts",
      "src/mcp/mcp-public-url.ts",
      "src/mcp/mcp-session-identity.ts",
      // the session caps and the idle lifetime (#1402)
      "src/mcp/mcp-session-limits.ts",
      "src/mcp/mcp-http-identity.ts",
      // #1320: the mesh's numbers: hops from 1, a deduplication that outlives a signature
      "src/mesh/mesh-rules.ts",
    ],
  };
}

/**
 * The A2A client (#809): the accept round trip's messageId and reconciliation by peer, which
 * failures are definite, the error translation (codes only), the origins it talks to, each task
 * state's outcome, the mesh envelope's body hash and its audience
 */
export function a2aClientShard() {
  return {
    configFile: "vitest.mutation-a2a-client.config.ts",
    mutate: [
      "src/a2a/client/a2a-accept.ts",
      "src/a2a/client/a2a-message.ts",
      "src/a2a/client/a2a-reconcile.ts",
      "src/a2a/client/a2a-transport.ts",
      "src/a2a/client/a2a-wire-errors.ts",
      "src/a2a/client/a2a-origins.ts",
      "src/a2a/client/a2a-task-view.ts",
      "src/a2a/client/a2a-outcome.ts",
      "src/a2a/a2a-mesh-message.ts",
      // #810: the call's charges, once across passes; the echo of the mesh
      "src/a2a/client/a2a-charges.ts",
      "src/a2a/client/a2a-echo.ts",
      "src/mesh/mesh-verification.ts",
      // #1320: what a client signs and to whom — never across an origin
      "src/mesh/outbound-http.ts",
      "src/tools/mcp/signed-fetch.ts",
    ],
  };
}

/**
 * #860: the direct replies — one run per message, a resend or a duplicate served the kept reply,
 * a lost attempt settled once, the store in memory and SQLite, no recovery of a direct run, the
 * assembly rule of a stateless skill, the client's retention of a direct skill; #900: a decision
 * holds no file descriptor
 */
export function a2aDirectShard() {
  return {
    configFile: "vitest.mutation-a2a-direct.config.ts",
    mutate: [
      "src/a2a/**/a2a-{direct-*,forged-files,message-skill-rule,effect-reach,call-peer}.ts",
      "src/infrastructure/**/*a2a-direct-message*.ts",
    ],
  };
}

/**
 * #1048: what the run's stream tells, retracts, reveals and holds back (#1004-#1007), the fallback's
 * streamed answer, the JSON answer to a streamed request (#1049), and the A2A artifact view, the SSE
 * writer and the subscribers' queue (#1008), and the stall bound of a streamed answer (#1125)
 */
export function streamShard() {
  return {
    configFile: "vitest.mutation-stream.config.ts",
    mutate: [
      "src/run/stream/*.ts",
      "src/models/{fallback-stream,calls/json-as-stream}.ts",
      // #1231: a streamed call's usage taken once — the cost and the host every budget reads —, in
      // the client's fetch, which every LangChain copy of the client keeps; #1329: the host a call
      // records (`served-by`) and the events both read
      "src/models/{chat-openai,usage-once,event-stream-lines,served-by}.ts",
      "src/a2a/server/a2a-{sse-write,subscriber-queue,artifact-view}.ts",
      "src/models/calls/event-stream-guard.ts",
      // #1399: what a stream that failed mid-way had spent — the record, the error's carrier, the counter
      "src/finops/partial-usage.ts",
      "src/models/transport/stream-partial.ts",
      // #1311b: a transport stream's chunks as they come
      "src/models/transport/transport-chunks.ts",
      "src/graph/agent-loop/chunk-counter.ts",
      // #1399: the same for a call of any other component, and a fallback's share of it
      "src/finops/charged-call.ts",
      "src/finops/failed-decision.ts",
      // bughunt 2026-11-25 #2: a decision priced by its own provider's table when it reports no cost
      "src/finops/decision-price.ts",
    ],
  };
}
