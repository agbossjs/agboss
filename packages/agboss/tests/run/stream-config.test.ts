import { describe, expect, it } from "vitest";
import { extractRunContext } from "../../src/core/run-context.js";
import type { RunDeps } from "../../src/run/types.js";
import { streamConfig } from "../../src/run/stream-config.js";

const deps = { config: { name: "w" } } as RunDeps<string>;
const identity = { threadId: "t-1", tenantId: "default", runId: "run-1", input: { text: "hi" } };

describe("#181: the run's config is built once, with its RunContext", () => {
  it("carries the caller's configurable keys under the framework's own", () => {
    const config = streamConfig(deps, identity, {
      configurable: { region: "eu", thread_id: "not-mine", run: "not-mine" },
    });

    expect(config.configurable.region).toBe("eu");
    expect(config.configurable.thread_id).toBe("run-1");
    expect(extractRunContext(config, "fallback").run).toMatchObject({
      runId: "run-1",
      threadId: "t-1",
    });
  });

  it("a node outside an app run gets a context of the fallback run id", () => {
    const signal = new AbortController().signal;

    const { run } = extractRunContext({ signal }, "run-x");

    expect(run).toEqual({
      runId: "run-x",
      threadId: "run-x",
      tenantId: "default",
      signal,
      input: {},
    });
  });
});
