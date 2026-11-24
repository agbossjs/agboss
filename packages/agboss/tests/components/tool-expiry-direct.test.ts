/**
 * #1366: the rules on a tool's timeout and the deadline of its approval pause, called directly: each violation's code,
 * exact message and node, for a `@Tool`, and what is skipped (a class that is no tool, a tool without
 * a timeout or an expiry). The shard `assembly-rules` mutates `tool-expiry-rules.ts` whole.
 */
import { describe, expect, it } from "vitest";
import { toolExpiryViolations } from "../../src/components/tool-expiry-rules.js";
import { Text } from "../../src/dto/index.js";
import { Injectable, Tool } from "../../src/index.js";
import { hours, seconds, type Milliseconds } from "../../src/units/index.js";
import { MAX_TIMEOUT, timerProblemOf } from "../../src/units/timer-limits.js";
import { RefundApprovalChannel } from "../flow/fixtures/refunds.fixture.js";

class Query {
  @Text({ prompt: "q" })
  q!: string;
}

const over = (MAX_TIMEOUT + 1) as Milliseconds;
const io = { description: "d", input: Query, output: Query };

class Run {
  execute(): Promise<Query> {
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

@Injectable()
class Service {
  readonly fixture = true;
}

class Undecorated {
  readonly fixture = true;
}

describe("#1366: toolExpiryViolations", () => {
  it("names a timeout above the maximum, of a tool, and none at the maximum", () => {
    const problem = String(timerProblemOf("timeout", over, MAX_TIMEOUT));

    expect(toolExpiryViolations({ local: [SlowTool, QuickTool] })).toEqual([
      {
        code: "limits.timeout-invalid",
        message: `SlowTool (slow-tool): ${problem}`,
        nodes: ["slow-tool"],
      },
    ]);
  });

  it("names an expiry without a channel, and one that is too short", () => {
    expect(toolExpiryViolations({ local: [OrphanTool, ShortTool] })).toEqual([
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

  it("reads a class that is no component as no tool", () => {
    expect(toolExpiryViolations({ local: [Undecorated, Service] })).toEqual([]);
  });

  it("finds nothing in tools without a timeout or an expiry, a good expiry, and a class that is no tool", () => {
    expect(toolExpiryViolations({ local: [PlainTool, AskingTool, SilentTool, Service] })).toEqual(
      [],
    );
    expect(toolExpiryViolations({ local: [] })).toEqual([]);
  });
});
