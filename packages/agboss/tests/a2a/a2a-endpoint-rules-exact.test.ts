/**
 * #1356 (ledger-a2a-client shard): what the assembly says of an `@A2AEndpoint` (#1320), each violation worked out as
 * a whole — its code, its message and the application it is told for: a ttl that is no duration, a message ttl at or
 * below the lease, an endpoint with no description, a skill that is no start of the workflows, a skill listed twice,
 * and a name that is not kebab-case on an endpoint or an agent.
 */
import { describe, expect, it } from "vitest";
import { A2AEndpoint, type A2AEndpointOptions } from "../../src/a2a/a2a-endpoint.decorator.js";
import { ttlViolations } from "../../src/a2a/a2a-endpoint-ttl.js";
import { contractRuleViolations } from "../../src/a2a/a2a-rules.js";
import { ComponentOptions } from "../../src/components/component-options.js";
import { hours, minutes, ms, seconds, Ttl } from "../../src/units/index.js";
import { OrderWorkflowStart } from "../infrastructure/fixtures/recovery.workflow.js";
import { RefundWorkflow, RefundWorkflowStart } from "./fixtures/contracts.workflow.js";

const CENTURY = 100 * 365 * 24 * 60 * 60 * 1000;
const where = "refunds-application";
const TTL = { tasks: hours(24), messages: minutes(15) };

const ttlOf = (ttl: unknown) =>
  ttlViolations({ name: "refunds", ttl } as never, where).map(({ code, message, nodes }) => ({
    code,
    message,
    nodes,
  }));
const invalid = (problem: string) => ({
  code: "a2a.ttl-invalid",
  message: `refunds's ${problem}`,
  nodes: [where],
});
const tasksProblem = (shown: string) =>
  invalid(`ttl.tasks is ${shown}, not a duration (days(30)) or Ttl.Forever`);
const messagesProblem = (shown: string) =>
  invalid(`ttl.messages is ${shown}, not a duration above the lease's 30000 ms`);

describe("#1356: the ttl of an endpoint", () => {
  it("is valid as a duration from 1 ms to a century for tasks, or forever, and above the lease up to a century for messages", () => {
    expect(ttlOf({ tasks: 1, messages: seconds(30) + 1 })).toEqual([]);
    expect(ttlOf({ tasks: CENTURY, messages: CENTURY })).toEqual([]);
    expect(ttlOf({ tasks: Ttl.Forever, messages: minutes(15) })).toEqual([]);
  });

  it("says what a task ttl is that is none: zero, below zero, past a century, infinite, text, absent", () => {
    expect(ttlOf({ tasks: 0, messages: minutes(15) })).toEqual([tasksProblem("0")]);
    expect(ttlOf({ tasks: -5, messages: minutes(15) })).toEqual([tasksProblem("-5")]);
    expect(ttlOf({ tasks: CENTURY + 1, messages: minutes(15) })).toEqual([
      tasksProblem(String(CENTURY + 1)),
    ]);
    expect(ttlOf({ tasks: Infinity, messages: minutes(15) })).toEqual([tasksProblem("Infinity")]);
    expect(ttlOf({ tasks: Ttl.None, messages: minutes(15) })).toEqual([tasksProblem("a string")]);
    expect(ttlOf({ tasks: "1h", messages: minutes(15) })).toEqual([tasksProblem("a string")]);
    expect(ttlOf({ tasks: {}, messages: minutes(15) })).toEqual([tasksProblem("an object")]);
    expect(ttlOf({ messages: minutes(15) })).toEqual([tasksProblem("undefined")]);
  });

  it("says what a message ttl is that is none, or at or below the lease", () => {
    expect(ttlOf({ tasks: hours(1), messages: seconds(30) })).toEqual([messagesProblem("30000")]);
    expect(ttlOf({ tasks: hours(1), messages: 1 })).toEqual([messagesProblem("1")]);
    expect(ttlOf({ tasks: hours(1), messages: 0 })).toEqual([messagesProblem("0")]);
    expect(ttlOf({ tasks: hours(1), messages: CENTURY + 1 })).toEqual([
      messagesProblem(String(CENTURY + 1)),
    ]);
    expect(ttlOf({ tasks: hours(1), messages: Number.NaN })).toEqual([messagesProblem("NaN")]);
    expect(ttlOf({ tasks: hours(1) })).toEqual([messagesProblem("undefined")]);
  });

  it("says both, tasks first, when neither is a duration, and without a ttl at all", () => {
    expect(ttlOf({})).toEqual([tasksProblem("undefined"), messagesProblem("undefined")]);
    expect(ttlOf(undefined)).toEqual([tasksProblem("undefined"), messagesProblem("undefined")]);
  });
});

/** The violations of an application serving one endpoint (its options changed by `changes`). */
function violationsOf(changes: Partial<A2AEndpointOptions>) {
  @A2AEndpoint({
    name: "refunds",
    version: "1.0.0",
    description: "Refunds",
    ttl: TTL,
    skills: [RefundWorkflowStart],
    ...changes,
  })
  class RefundsEndpoint {}

  return contractRuleViolations(
    { name: where, workflows: [RefundWorkflow], endpoints: [RefundsEndpoint] } as never,
    ComponentOptions.none,
  ).map(({ code, message, nodes }) => ({ code, message, nodes }));
}

describe("#1356: the rules of one @A2AEndpoint", () => {
  it("an endpoint that is as it should be has no violation", () => {
    expect(violationsOf({})).toEqual([]);
  });

  it("an endpoint with no description, or one of blanks, is told so", () => {
    const expected = [
      {
        code: "a2a.endpoint-description-required",
        message:
          "refunds has no description — the Agent Card's description says what the agent does for a caller that finds it",
        nodes: [where],
      },
    ];

    expect(violationsOf({ description: "" })).toEqual(expected);
    expect(violationsOf({ description: " \n " })).toEqual(expected);
  });

  it("a name that is not kebab-case is told on its decorator", () => {
    expect(violationsOf({ name: "Refunds_X" })).toEqual([
      {
        code: "name.not-kebab-case",
        message: '"Refunds_X" on @A2AEndpoint — a name is kebab-case: "refunds-x"',
        nodes: [where],
      },
    ]);
  });

  it("a ttl that is none is told with its own code, after the name and the description", () => {
    expect(violationsOf({ ttl: { tasks: ms(0), messages: minutes(15) } })).toEqual([
      { ...tasksProblem("0"), nodes: [where] },
    ]);
  });

  it("a skill that is no start of the application's workflows is told, once", () => {
    expect(violationsOf({ skills: [RefundWorkflowStart, OrderWorkflowStart] })).toEqual([
      {
        code: "application.endpoint-unknown-start",
        message: `refunds serves OrderWorkflowStart, which is no @WorkflowStart of ${where}'s workflows — list a start of a listed workflow`,
        nodes: [where],
      },
    ]);
  });

  it("a start listed twice, plain or with options, is told once, at its second place", () => {
    expect(violationsOf({ skills: [RefundWorkflowStart, { start: RefundWorkflowStart }] })).toEqual(
      [
        {
          code: "a2a.duplicate-skill",
          message: "refunds lists the skill RefundWorkflowStart twice — one entry per start",
          nodes: [where],
        },
      ],
    );
  });
});
