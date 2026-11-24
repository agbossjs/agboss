/**
 * #1366: the rules on the options of a flow's components, called directly with graphs built by hand: the count limits
 * (`[limits.count-invalid]`, #1373: each field, each kind of node, the value shown by its kind) and the shared agent
 * options (`[agent.dynamic-options]`, #272 AC16). The shard `assembly-rules` mutates `options.ts` of the rules whole.
 */
import { describe, expect, it } from "vitest";
import type { AnalysisContext } from "../../../src/flow/analyse/rules/context.js";
import { countLimitRules, optionsRules } from "../../../src/flow/analyse/rules/options.js";
import { NodeKind } from "../../../src/flow/ast.js";
import { graphOf, node } from "./graph-fixture.js";

const shown = (found: readonly { code: string; message: string; nodes: readonly string[] }[]) =>
  found.map(({ code, message, nodes }) => ({ code, message, nodes }));

/** A node of `kind` whose declaration carries `options`. */
const withOptions = (name: string, kind: NodeKind, options: object) => ({
  ...node(name, kind),
  declaration: { kind, options },
});

const contextOf = (
  nodes: readonly object[],
  extra: { readonly defaults?: object; readonly modules?: readonly object[] } = {},
): AnalysisContext =>
  ({
    workflow: { name: "limited-workflow", defaults: extra.defaults },
    graph: graphOf(nodes as never, [], []),
    options: { modules: extra.modules },
  }) as never;

const count = (name: string, field: string, value: string, example: string) => ({
  code: "limits.count-invalid",
  message: `${name}: ${field} is ${value}, not a whole number from 0 — ${example} sets it; leave it out for no limit`,
  nodes: [name],
});

describe("#1366: the count limits of the components", () => {
  it("names an agent's maxVisits, maxToolCalls and maxRetries, each by its field", () => {
    const agent = withOptions("busy-agent", NodeKind.Agent, {
      executionLimits: { maxVisits: -1, maxToolCalls: 2.5, maxRetries: Number.NaN },
    });

    expect(shown(countLimitRules(contextOf([agent])))).toEqual([
      count("busy-agent", "executionLimits.maxVisits", "-1", "maxVisits: 3"),
      count("busy-agent", "executionLimits.maxToolCalls", "2.5", "maxToolCalls: 10"),
      count("busy-agent", "executionLimits.maxRetries", "NaN", "maxRetries: 2"),
    ]);
  });

  it("names a router's and a question's maxVisits, and no other field of theirs", () => {
    const router = withOptions("pick-router", NodeKind.Router, {
      maxVisits: "x",
      maxToolCalls: -1,
    });
    const question = withOptions("ask-question", NodeKind.Question, { maxVisits: null });

    expect(shown(countLimitRules(contextOf([router, question])))).toEqual([
      count("pick-router", "maxVisits", "a string", "maxVisits: 3"),
      count("ask-question", "maxVisits", "null", "maxVisits: 3"),
    ]);
  });

  it("shows an object by its kind, and reads no limit of an action, a start or a finish", () => {
    const agent = withOptions("odd-agent", NodeKind.Agent, { executionLimits: { maxVisits: {} } });
    const action = withOptions("do-action", NodeKind.Action, { maxVisits: -1, maxRetries: -1 });

    expect(shown(countLimitRules(contextOf([agent, action])))).toEqual([
      count("odd-agent", "executionLimits.maxVisits", "an object", "maxVisits: 3"),
    ]);
  });

  it("finds nothing in counts from 0, or in limits left out", () => {
    const agent = withOptions("fine-agent", NodeKind.Agent, {
      executionLimits: { maxVisits: 0, maxModelCalls: 6, maxToolCalls: 10, maxRetries: 2 },
    });
    const bare = withOptions("bare-agent", NodeKind.Agent, {});

    expect(countLimitRules(contextOf([agent, bare]))).toEqual([]);
  });

  it("names the default maxToolCalls of the workflow, by the workflow", () => {
    const defaults = { tools: { maxToolCalls: -3 } };

    expect(shown(countLimitRules(contextOf([], { defaults })))).toEqual([
      count("limited-workflow", "defaults.tools.maxToolCalls", "-3", "maxToolCalls: 10"),
    ]);
    expect(countLimitRules(contextOf([], { defaults: { tools: {} } }))).toEqual([]);
    expect(countLimitRules(contextOf([], { defaults: {} }))).toEqual([]);
    expect(countLimitRules(contextOf([]))).toEqual([]);
  });
});

describe("#1366: the shared agent options", () => {
  const shared = {
    input: {
      draft: class Draft {
        readonly fixture = true;
      },
    },
    retries: 2,
  };
  const agentOf = (name: string, kind: NodeKind = NodeKind.Agent) =>
    withOptions(name, kind, { ...shared });
  const spread = (name: string, file: string, exports: object = { sharedOptions: shared }) =>
    contextOf([agentOf(name)], { modules: [{ file, exports }] });

  it("accepts a const from an *.options file of any extension", () => {
    for (const file of ["a/x.options.ts", "a/x.options.js", "a/x.options.mts", "a/x.options.cjs"]) {
      expect(optionsRules(spread("one-agent", file))).toEqual([]);
    }
  });

  it("names a const from another file, by its export and file", () => {
    for (const file of [
      "a/x.options.tsx",
      "a/x.options.ts.bak",
      "a/xoptions.ts",
      "a/x.options.mjs.ts",
    ]) {
      expect(shown(optionsRules(spread("one-agent", file)))).toEqual([
        {
          code: "agent.dynamic-options",
          message: `one-agent spreads sharedOptions from ${file} — shared agent options are a static object literal in an *.options.ts file (satisfies Omit<AgentOptions, "name" | "description">)`,
          nodes: ["one-agent"],
        },
      ]);
    }
  });

  it("names an action or a router that spreads one, even from an *.options file", () => {
    for (const kind of [NodeKind.Action, NodeKind.Router]) {
      const context = contextOf([agentOf("other-step", kind)], {
        modules: [{ file: "a/x.options.ts", exports: { sharedOptions: shared } }],
      });

      expect(shown(optionsRules(context))).toEqual([
        {
          code: "agent.dynamic-options",
          message:
            "other-step spreads sharedOptions from a/x.options.ts — *.options.ts is for agents only; share logic through a service in deps",
          nodes: ["other-step"],
        },
      ]);
    }
  });

  it("finds a spread only in a plain object export that holds one of the node's own objects", () => {
    const own = { input: shared.input };
    const unrelated = { input: {} };
    const modules = [
      {
        file: "a/y.ts",
        exports: {
          primitive: 1,
          nothing: null,
          list: [shared.input],
          unrelated,
          own: { retries: 2 },
        },
      },
    ];

    expect(optionsRules(contextOf([agentOf("one-agent")], { modules }))).toEqual([]);
    expect(
      optionsRules(
        contextOf([agentOf("one-agent")], { modules: [{ file: "a/y.ts", exports: { own } }] }),
      ),
    ).toHaveLength(1);
    const instance = Object.create({ inherited: true }) as Record<string, unknown>;
    instance.input = shared.input;

    expect(
      optionsRules(
        contextOf([agentOf("one-agent")], { modules: [{ file: "a/y.ts", exports: { instance } }] }),
      ),
    ).toEqual([]);
  });

  it("reads an export that is undefined, and a null that no option holds in common", () => {
    const withNull = withOptions("null-agent", NodeKind.Agent, { input: shared.input, gone: null });
    const modules = [
      { file: "a/y.ts", exports: { missing: undefined, empty: { gone: null }, count: 3 } },
    ];

    expect(optionsRules(contextOf([agentOf("one-agent")], { modules }))).toEqual([]);
    expect(optionsRules(contextOf([withNull], { modules }))).toEqual([]);
  });

  it("names a function exported from an *.options file, with no node", () => {
    const modules = [
      { file: "a/x.options.ts", exports: { build: () => ({}), fine: {} } },
      { file: "a/other.ts", exports: { helper: () => ({}) } },
    ];

    expect(shown(optionsRules(contextOf([], { modules })))).toEqual([
      {
        code: "agent.dynamic-options",
        message:
          "a/x.options.ts exports build, a function — an *.options.ts file declares static object literals, never options built by a call",
        nodes: [],
      },
    ]);
  });

  it("finds nothing without modules, and reads every node against every module", () => {
    expect(optionsRules(contextOf([agentOf("one-agent")]))).toEqual([]);
    const modules = [
      { file: "a/p.ts", exports: { sharedOptions: shared } },
      { file: "a/q.ts", exports: { sharedOptions: shared } },
    ];

    expect(
      optionsRules(contextOf([agentOf("one-agent"), agentOf("two-agent")], { modules })),
    ).toHaveLength(4);
  });
});
