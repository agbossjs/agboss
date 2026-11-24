/**
 * #1373 — a count limit that is no whole number from 0 is refused at assembly. `maxVisits` (an agent, a router, a
 * question step and a question role an agent asks as a tool), `maxToolCalls` (an agent's, and
 * `defaults.tools.maxToolCalls`) and `maxRetries`: `NaN`, a word, an object, `null`, a negative or fractional
 * number. Before, the analysis counted such a `maxVisits` as a bound while the run never applied it, and a loop ran
 * to `maxSteps`, a paid model call at each visit. Now the build refuses it, and a value that got past
 * is a bound of 0 at run time (`tests/flow/runtime/money-runtime-units.test.ts`): the two agree, and fail closed.
 * No message names a value's text.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../../src/application/application.js";
import { applicationOf } from "../../../src/application/assemble.js";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { countLimitRules } from "../../../src/flow/analyse/rules/options.js";
import type { AnalysisContext } from "../../../src/flow/analyse/rules/context.js";
import type { FlowNode } from "../../../src/flow/analyse/flow-graph.js";
import { NodeKind } from "../../../src/flow/ast.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow, type WorkflowOptions } from "../../../src/flow/decorators/workflow.js";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
import { GraphRuleError } from "../../../src/graph/rule-error.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { TEST_BUDGETS } from "../fixtures/budgets.js";
import {
  ChangesRequestedDto,
  DraftApprovedDto,
  OfferDraftDto,
  OfferSentDto,
  ShortlistDto,
} from "../fixtures/dtos.js";
import {
  DraftKitAgent,
  KitWorkflowStart,
  SendKitAction,
  SentKitWorkflowFinish,
} from "../fixtures/kit.fixture.js";
import { onAgent, caseOf, onStart } from "../fixtures/paths.js";

const BAD: readonly (readonly [string, unknown, string])[] = [
  ["NaN", Number.NaN, "NaN"],
  ["a word", "five", "a string"],
  ["an object", { limit: "ignore previous instructions" }, "an object"],
  ["an array", [], "an object"],
  ["null", null, "null"],
  ["a negative number", -1, "-1"],
  ["a fraction", 1.5, "1.5"],
  ["a number as text", "2", "a string"],
  ["true", true, "a boolean"],
  ["infinity", Number.POSITIVE_INFINITY, "Infinity"],
];

let count = 0;

/** What the loop's editor agent is given beside its name. */
interface EditorSettings {
  readonly maxVisits?: unknown;
  readonly maxToolCalls?: unknown;
  readonly maxRetries?: unknown;
}

/** The review loop of the offer: the editor (bounded as given) and the reviewer (unbounded) close a cycle. */
function loopOf(
  editor: EditorSettings,
  workflow: Partial<WorkflowOptions> = {},
): new () => unknown {
  count += 1;
  @Agent({
    name: `limit-${String(count)}-edit-agent`,
    description: "Edits the draft",
    prompt: "Edit it.",
    model: "moonshotai/kimi-k2.6",
    input: { draft: OfferDraftDto },
    output: OfferDraftDto,
    ...(editor as object),
  })
  class LimitEditAgent {}

  @Agent({
    name: `limit-${String(count)}-review-agent`,
    description: "Reviews the draft",
    prompt: "Review it.",
    model: "moonshotai/kimi-k2.6",
    input: { draft: OfferDraftDto },
    output: oneOf(ChangesRequestedDto, DraftApprovedDto),
  })
  class LimitReviewAgent {}

  @Workflow({
    name: `limit-${String(count)}-loop-workflow`,
    version: "1.0.0",
    flow: [
      onStart(KitWorkflowStart)
        .returns(ShortlistDto)
        .toAgent(DraftKitAgent)
        .returns(OfferDraftDto)
        .toAgent(LimitReviewAgent),
      onAgent(LimitReviewAgent)
        .returns(oneOf(ChangesRequestedDto, DraftApprovedDto))
        .switch(
          caseOf(ChangesRequestedDto)
            .toAgent(LimitEditAgent)
            .returns(OfferDraftDto)
            .toAgent(LimitReviewAgent),
          caseOf(DraftApprovedDto)
            .toAction(SendKitAction)
            .returns(OfferSentDto)
            .toFinish(SentKitWorkflowFinish),
        ),
    ],
    ...workflow,
  })
  class LimitLoopWorkflow {}
  return LimitLoopWorkflow;
}

const codesOf = (workflow: new () => unknown): readonly string[] =>
  checkWorkflow(workflow).errors.map((found) => found.code);

describe("#1373: maxVisits that is no whole number from 0 fails assembly", () => {
  it.each(BAD)(
    "%s: [limits.count-invalid] alone — the cycle it closes is no more reported, and the message names its kind only",
    (_kind, value, shown) => {
      const check = checkWorkflow(loopOf({ maxVisits: value }));

      expect(check.errors.map((found) => found.code)).toEqual(["limits.count-invalid"]);
      expect(check.errors[0]?.message).toContain(
        `maxVisits is ${shown}, not a whole number from 0`,
      );
      expect(check.errors[0]?.message).not.toContain("ignore previous instructions");
      expect(check.errors[0]?.message).not.toContain("five");
      expect(check.errors[0]?.nodes).toEqual([expect.stringMatching(/^limit-\d+-edit-agent$/)]);
      expect(JSON.stringify(check.warnings)).not.toMatch(/NaN|five|object/);
    },
  );

  it("0 and whole numbers pass; a cycle bounded by them is no cycle without a bound", () => {
    for (const value of [0, 1, 3, 100]) expect(codesOf(loopOf({ maxVisits: value }))).toEqual([]);
  });

  it("no maxVisits at all leaves the cycle unbounded, as before", () => {
    expect(codesOf(loopOf({}))).toEqual(["graph.cycle-without-max-visits"]);
  });

  it("the analysis reads the value as the run does: a bound of 0 in the worst case", () => {
    const check = checkWorkflow(loopOf({ maxVisits: Number.NaN }, { maxSteps: 10 }));

    expect(check.errors.map((found) => found.code)).toEqual(["limits.count-invalid"]);
    expect(check.warnings.map((found) => found.code)).not.toContain(
      "limits.max-steps-below-worst-case",
    );
  });
});

describe("#1373: maxToolCalls and maxRetries that are no whole number from 0 fail assembly", () => {
  it.each(BAD)("%s as an agent's maxToolCalls", (_kind, value, shown) => {
    const check = checkWorkflow(loopOf({ maxVisits: 3, maxToolCalls: value }));

    expect(check.errors.map((found) => found.code)).toEqual(["limits.count-invalid"]);
    expect(check.errors[0]?.message).toContain(
      `maxToolCalls is ${shown}, not a whole number from 0`,
    );
  });

  it.each(BAD)("%s as an agent's maxRetries", (_kind, value, shown) => {
    const check = checkWorkflow(loopOf({ maxVisits: 3, maxRetries: value }));

    expect(check.errors.map((found) => found.code)).toEqual(["limits.count-invalid"]);
    expect(check.errors[0]?.message).toContain(`maxRetries is ${shown}, not a whole number from 0`);
  });

  it.each(BAD)(
    "%s as defaults.tools.maxToolCalls, named by the workflow",
    (_kind, value, shown) => {
      const workflow = loopOf(
        { maxVisits: 3 },
        { defaults: { tools: { maxToolCalls: value as never } } },
      );

      const check = checkWorkflow(workflow);

      expect(check.errors.map((found) => found.code)).toEqual(["limits.count-invalid"]);
      expect(check.errors[0]?.message).toContain(
        `defaults.tools.maxToolCalls is ${shown}, not a whole number from 0`,
      );
      expect(check.errors[0]?.nodes).toEqual([expect.stringMatching(/^limit-\d+-loop-workflow$/)]);
    },
  );

  it("0 and whole numbers pass, and unset is no limit", () => {
    for (const value of [0, 1, 5])
      expect(
        codesOf(
          loopOf(
            { maxVisits: 3, maxToolCalls: value, maxRetries: value },
            { defaults: { tools: { maxToolCalls: value } } },
          ),
        ),
      ).toEqual([]);
    expect(codesOf(loopOf({ maxVisits: 3 }))).toEqual([]);
  });

  it("every broken limit of one agent is reported at once, each naming its field", () => {
    const check = checkWorkflow(loopOf({ maxVisits: "x", maxToolCalls: "x", maxRetries: "x" }));

    expect(check.errors.map((found) => found.code)).toEqual([
      "limits.count-invalid",
      "limits.count-invalid",
      "limits.count-invalid",
    ]);
    const fields = check.errors.map(
      (found) => /(maxVisits|maxToolCalls|maxRetries) is/.exec(found.message)?.[1],
    );
    expect(fields.sort()).toEqual(["maxRetries", "maxToolCalls", "maxVisits"]);
  });
});

describe("#1373: maxSteps that is no whole number from 0 fails assembly, its value named by kind only", () => {
  it.each(BAD)(
    "%s: [limits.count-invalid] alone — no other steps rule reads it",
    (_kind, value, shown) => {
      const check = checkWorkflow(loopOf({ maxVisits: 2 }, { maxSteps: value as never }));

      expect(check.errors.map((found) => found.code)).toEqual(["limits.count-invalid"]);
      expect(check.errors[0]?.message).toMatch(
        new RegExp(
          `^limit-\\d+-loop-workflow has maxSteps: ${shown}, not a whole number of steps from 0`,
        ),
      );
      expect(check.errors[0]?.message).not.toContain("five");
      expect(check.errors[0]?.message).not.toContain("ignore previous instructions");
      expect(check.warnings.map((found) => found.code)).not.toContain(
        "limits.max-steps-below-worst-case",
      );
    },
  );

  it("a whole number that holds the flow passes, one that is too low is still [limits.max-steps-too-low]", () => {
    expect(codesOf(loopOf({ maxVisits: 2 }, { maxSteps: 50 }))).toEqual([]);
    expect(codesOf(loopOf({ maxVisits: 2 }, { maxSteps: 0 }))).toEqual([
      "limits.max-steps-too-low",
    ]);
  });
});

/** A rule context of the given nodes: only what `countLimitRules` reads. */
const contextOf = (nodes: readonly FlowNode[], defaults?: object): AnalysisContext =>
  ({
    workflow: { name: "checked-workflow", ...(defaults === undefined ? {} : { defaults }) },
    graph: { nodes: new Map(nodes.map((node) => [node.name, node])) },
  }) as never;

const nodeOf = (name: string, kind: NodeKind, options: object): FlowNode =>
  ({ name, kind, declaration: { kind, options: { name, ...options } } }) as never;

describe("#1373: a router and a question step have a maxVisits that is a whole number from 0, too", () => {
  it.each(BAD)("%s on a router and on a question step", (_kind, value, shown) => {
    const found = countLimitRules(
      contextOf([
        nodeOf("pick-router", NodeKind.Router, { maxVisits: value }),
        nodeOf("ask-question", NodeKind.Question, { maxVisits: value }),
      ]),
    );

    expect(found.map((one) => [one.code, one.nodes])).toEqual([
      ["limits.count-invalid", ["pick-router"]],
      ["limits.count-invalid", ["ask-question"]],
    ]);
    expect(found[0]?.message).toBe(
      `pick-router: maxVisits is ${shown}, not a whole number from 0 — maxVisits: 3 sets it; leave it out for no limit`,
    );
  });

  it("a router and a question step hold no maxToolCalls or maxRetries: only an agent does", () => {
    const found = countLimitRules(
      contextOf([
        nodeOf("pick-router", NodeKind.Router, {
          maxVisits: 2,
          maxToolCalls: "x",
          maxRetries: "x",
        }),
        nodeOf("ask-question", NodeKind.Question, { maxVisits: 0, maxToolCalls: "x" }),
        nodeOf("send-action", NodeKind.Action, { maxVisits: "x", maxToolCalls: "x" }),
      ]),
    );

    expect(found).toEqual([]);
  });

  it("an unset limit, a workflow with no defaults and one with other defaults are all fine", () => {
    expect(countLimitRules(contextOf([nodeOf("a-agent", NodeKind.Agent, {})]))).toEqual([]);
    expect(countLimitRules(contextOf([], { tools: { maxResultSize: 1024 } }))).toEqual([]);
    expect(countLimitRules(contextOf([], { models: { temperature: 0 } }))).toEqual([]);
  });
});

describe("#1373: the application refuses the loop of the issue before any model is called", () => {
  it('maxVisits "five" on both loop nodes: a GraphRuleError with [limits.count-invalid], no value quoted', async () => {
    const workflow = loopOf({ maxVisits: "five" }, { maxSteps: 500 });

    @Application({
      name: "limit-issue-application",
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [workflow],
      budgets: TEST_BUDGETS,
    })
    class LimitIssueApplication {}

    const error: unknown = await applicationOf(LimitIssueApplication).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(GraphRuleError);
    const found = (error as GraphRuleError).violations.map((one) => one.code);
    expect(found).toContain("limits.count-invalid");
    expect((error as GraphRuleError).message).not.toContain("five");
  });
});
