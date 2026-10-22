import { describe, expect, it } from "vitest";
import * as a2a from "../../src/a2a/index.js";
import * as channels from "../../src/channels/index.js";
import * as core from "../../src/core/index.js";
import * as dto from "../../src/dto/index.js";
import * as graph from "../../src/graph/index.js";
import * as root from "../../src/index.js";
import * as internal from "../../src/internal.js";
import * as mcp from "../../src/mcp/index.js";
import * as memory from "../../src/memory/index.js";
import * as models from "../../src/models/index.js";
import * as rag from "../../src/rag/index.js";
import * as router from "../../src/router/index.js";
import * as testing from "../../src/testing/index.js";
import * as tool from "../../src/tool/index.js";
import * as units from "../../src/units/index.js";

/** Every entry of package.json#exports (`./testing/setup` has no exports). */
const ENTRIES: Readonly<Record<string, object>> = {
  ".": root,
  "./dto": dto,
  "./units": units,
  "./models": models,
  "./testing": testing,
  "./mcp": mcp,
  "./rag": rag,
  "./a2a": a2a,
  "./memory": memory,
  "./internal": internal,
  "./core": core,
  "./graph": graph,
  "./router": router,
  "./tool": tool,
  "./channels": channels,
};

/** The flow DSL before #272 (AC8): none of these is a name of any entry any more. */
const OLD_DSL = [
  "Self",
  "Return",
  "Skip",
  "End",
  "SELF_OPTION",
  "parallel",
  "from",
  "chain",
  "node",
  "nextParallel",
  "sequenceAgents",
  "bg",
  "background",
  "joinAny",
  "byPriority",
  "catchError",
  // the old DSL's export; since #339 `compensateWith` is an option of @Action, not a name of any entry
  "compensateWith",
  "onOutput",
  "cameFrom",
  "precededBy",
  "outcomes",
  "toChooseOne",
  "producedBy",
  "producedByAny",
  "producedByAll",
  "alsoTo",
  "WorkflowAction",
  "BatchParallelStrategy",
  "QuorumRouter",
  "QuorumStrategy",
  "QuorumManager",
  "LocalSagaStrategy",
];

describe("#272 AC8: the path grammar replaces the old flow DSL in every entry", () => {
  it("old DSL names are gone", () => {
    const found = Object.entries(ENTRIES).flatMap(([entry, exports]) =>
      OLD_DSL.filter((name) => name in exports).map((name) => `${entry} ${name}`),
    );

    expect(found).toEqual([]);
  });

  it("the root entry exports the path builder, the v2 decorators, the wrappers and the errors", () => {
    const expected = [
      "Action",
      "Agent",
      "DecidedBy",
      "GraphRuleError",
      "FlowSyntaxError",
      "LimitExceededError",
      "Router",
      "RouterDecisionError",
      "VisitsLimitExceededError",
      "Workflow",
      "WorkflowFinish",
      "WorkflowSettings",
      "WorkflowStart",
      "action",
      "agent",
      "caseOf",
      "isVariant",
      "listOf",
      "oneOf",
      "optional",
      "route",
      "router",
      "start",
      "toAction",
      "toAgent",
      "toFinish",
      "toRouter",
      "variant",
    ];

    expect(Object.keys(root)).toEqual(expect.arrayContaining(expected));
  });

  it("agboss/dto exports the wrappers too, the same values as the root", () => {
    for (const name of ["listOf", "oneOf", "optional", "variant", "isVariant"] as const) {
      expect(dto[name]).toBe(root[name]);
    }
  });

  it("agboss/graph is deprecated (#195): what it still has are the root's values", () => {
    for (const [name, value] of Object.entries(graph)) {
      expect(root[name as keyof typeof root]).toBe(value);
    }
  });

  it("export the unit helpers", () => {
    expect(Object.keys(units).sort()).toEqual(
      ["UnitError", "hours", "kilobytes", "minutes", "seconds", "usd"].sort(),
    );
  });
});
