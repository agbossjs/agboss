/** #1048: how a visit's stream travels in a call's config. */
import { describe, expect, it } from "vitest";
import { AgentStream, agentStreamOf, withAgentStream } from "../../src/run/stream/agent-stream.js";
import { RunStream } from "../../src/run/stream/run-stream.js";

const visit = (): AgentStream =>
  new AgentStream(new RunStream(() => undefined), { agent: "a", visit: 1, branch: "e" }, false);

describe("withAgentStream", () => {
  it("is the config itself when nothing listens", () => {
    const config = { configurable: { thread_id: "t" } };

    expect(withAgentStream(config, undefined)).toBe(config);
    expect(withAgentStream(undefined, undefined)).toBeUndefined();
  });

  it("adds the stream under `agentStream` and keeps the config's own keys", () => {
    const stream = visit();

    const config = withAgentStream({ tags: ["x"], configurable: { thread_id: "t" } }, stream);

    expect(config?.tags).toEqual(["x"]);
    expect(config?.configurable).toEqual({ thread_id: "t", agentStream: stream });
  });

  it("makes a config of its own when there was none", () => {
    const stream = visit();

    expect(withAgentStream(undefined, stream)).toEqual({ configurable: { agentStream: stream } });
    expect(withAgentStream({}, stream)).toEqual({ configurable: { agentStream: stream } });
  });
});

describe("agentStreamOf", () => {
  it("reads the visit's stream back", () => {
    const stream = visit();

    expect(agentStreamOf(withAgentStream(undefined, stream))).toBe(stream);
  });

  it("is nothing for no config, no `configurable` or a value that is no visit stream", () => {
    expect(agentStreamOf(undefined)).toBeUndefined();
    expect(agentStreamOf({})).toBeUndefined();
    expect(agentStreamOf({ configurable: {} })).toBeUndefined();
    expect(
      agentStreamOf({ configurable: { agentStream: { emit: () => undefined } } }),
    ).toBeUndefined();
  });
});
