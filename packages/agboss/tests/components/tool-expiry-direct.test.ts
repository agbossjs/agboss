/**
 * #1366: the rules on a tool's timeout and the deadline of its approval pause, called directly: each violation's code,
 * exact message and node, for a `@Tool` and an `@McpTool`, and what is skipped (a class that is no tool, a tool without
 * a timeout or an expiry). The shard `assembly-rules` mutates `tool-expiry-rules.ts` whole.
 */
import { describe, expect, it } from "vitest";
import { toolExpiryViolations } from "../../src/components/tool-expiry-rules.js";
import { Text } from "../../src/dto/index.js";
import { Injectable, Tool, type ToolHandler } from "../../src/index.js";
import { McpServer, McpServerClient, McpTool } from "../../src/mcp/index.js";
import { hours, seconds, type Milliseconds } from "../../src/units/index.js";
import { MAX_TIMEOUT, timerProblemOf } from "../../src/units/timer-limits.js";
import { RefundApprovalChannel } from "../flow/fixtures/refunds.fixture.js";

class Query {
  @Text({ prompt: "q" })
  q!: string;
}

const over = (MAX_TIMEOUT + 1) as Milliseconds;
const io = { description: "d", input: Query, output: Query };

class Run implements ToolHandler<Query, Query> {
  run(): Promise<Query> {
    return Promise.resolve(new Query());
  }
}

@Tool({ ...io, name: "slow-tool", timeout: over })
class SlowTool extends Run {}

@Tool({ ...io, name: "quick-tool", timeout: MAX_TIMEOUT })
class QuickTool extends Run {}

@Tool({ ...io, name: "plain-tool" })
class PlainTool extends Run {}

@Tool({ ...io, name: "orphan-tool", expiresIn: hours(1) })
class OrphanTool extends Run {}

@Tool({ ...io, name: "short-tool", channel: RefundApprovalChannel, expiresIn: seconds(0.5) })
class ShortTool extends Run {}

@Tool({ ...io, name: "asking-tool", channel: RefundApprovalChannel, expiresIn: hours(4) })
class AskingTool extends Run {}

@Tool({ ...io, name: "silent-tool", channel: RefundApprovalChannel })
class SilentTool extends Run {}

@McpServer({ name: "files", transport: "stdio", command: process.execPath, args: [], tools: {} })
class FilesServer extends McpServerClient<Record<string, never>> {}

@McpTool({ ...io, name: "slow-mcp-tool", server: FilesServer, timeout: over })
class SlowMcpTool extends Run {}

@Injectable()
class Service {
  readonly fixture = true;
}

class Undecorated {
  readonly fixture = true;
}

@McpTool({
  ...io,
  name: "asking-mcp-tool",
  server: FilesServer,
  channel: RefundApprovalChannel,
  expiresIn: seconds(0.5),
})
class ShortMcpTool extends Run {}

@McpTool({ ...io, name: "orphan-mcp-tool", server: FilesServer, expiresIn: hours(1) })
class OrphanMcpTool extends Run {}

describe("#1366: toolExpiryViolations", () => {
  it("names a timeout above the maximum, of a tool and of an MCP tool, and none at the maximum", () => {
    const problem = String(timerProblemOf("timeout", over, MAX_TIMEOUT));

    expect(toolExpiryViolations({ local: [SlowTool, QuickTool], mcp: [SlowMcpTool] })).toEqual([
      {
        code: "limits.timeout-invalid",
        message: `SlowTool (slow-tool): ${problem}`,
        nodes: ["slow-tool"],
      },
      {
        code: "limits.timeout-invalid",
        message: `SlowMcpTool (slow-mcp-tool): ${problem}`,
        nodes: ["slow-mcp-tool"],
      },
    ]);
  });

  it("names an expiry without a channel, and one that is too short", () => {
    expect(toolExpiryViolations({ local: [OrphanTool, ShortTool], mcp: [] })).toEqual([
      {
        code: "tool.expires-in-without-channel",
        message:
          "OrphanTool (orphan-tool): expiresIn is the deadline of its approval pause, but it names no channel — add channel, or drop expiresIn",
        nodes: ["orphan-tool"],
      },
      {
        code: "channel.expires-in-invalid",
        message:
          "ShortTool (short-tool): expiresIn is 500 — a deadline is a positive finite duration of at least seconds(1) and at most 5 years, like hours(4)",
        nodes: ["short-tool"],
      },
    ]);
  });

  it("names an MCP tool's expiry too, and reads a class that is no component as no tool", () => {
    expect(
      toolExpiryViolations({
        local: [Undecorated],
        mcp: [ShortMcpTool, OrphanMcpTool, Undecorated],
      }).map((one) => one.code),
    ).toEqual(["channel.expires-in-invalid", "tool.expires-in-without-channel"]);
    expect(toolExpiryViolations({ local: [Service], mcp: [Service] })).toEqual([]);
  });

  it("finds nothing in tools without a timeout or an expiry, a good expiry, and a class that is no tool", () => {
    expect(
      toolExpiryViolations({ local: [PlainTool, AskingTool, SilentTool, Service], mcp: [Service] }),
    ).toEqual([]);
    expect(toolExpiryViolations({ local: [], mcp: [] })).toEqual([]);
  });
});
