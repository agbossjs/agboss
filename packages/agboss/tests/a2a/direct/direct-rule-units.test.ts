/**
 * #860 (mutation shard `a2a-direct`): the direct-reply rule on an application's declarations alone
 * — each problem's code and text: a question role and an approval tool among an agent's tools, an
 * effect behind a harmless service, an A2A client, an action committed with no undo, a recursion;
 * each problem once; a token, a cycle of deps, a class of no decorator (as a tool, a node, a
 * workflow, an export, an expose) read past without a throw; a skill option of no reply; the start
 * of no listed workflow; every violation placed on the application.
 */
import { describe, expect, it } from "vitest";
import { A2AExpose, A2AReply } from "../../../src/a2a/a2a-expose.decorator.js";
import {
  messageSkillsOf,
  messageSkillViolations,
} from "../../../src/a2a/a2a-message-skill-rule.js";
import type { ApplicationOptions } from "../../../src/application/application.js";
import { componentOf } from "../../../src/components/metadata.js";
import type { Class } from "../../../src/components/injection.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { NodeKind } from "../../../src/flow/ast.js";
import { declarationOf } from "../../../src/flow/decorators/declaration.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { McpExpose } from "../../../src/mcp/mcp-expose.decorator.js";
import {
  OnceLevelWorkflow,
  OnceLevelWorkflowStart,
} from "../../app/fixtures/undo-once.workflow.js";
import { start } from "../../helpers/flow.js";
import {
  AskingAgent,
  CallingAction,
  CommittedAction,
  FirstLedgerAgent,
  LateEffectAction,
  PlainAgent,
  PlainTool,
  SecondLedgerAgent,
  TokenAction,
} from "../fixtures/direct-rule-units.fixture.js";

@WorkflowFinish({
  name: "unit-rule-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
class UnitRuleFinish {}

let made = 0;

/** A start whose workflow runs `nodes` in order (agents and actions), and that workflow. */
function skillOf(nodes: readonly Class[]): { readonly start: Class; readonly workflow: Class } {
  const id = `unit-rule-${String((made += 1))}`;
  @WorkflowStart({ name: `${id}-workflow-start`, description: id, input: WorkflowStartTextDto })
  class Start {}
  let path = start(Start).returns(WorkflowStartTextDto);
  for (const node of nodes)
    path = declarationOf(node)?.kind === NodeKind.Agent ? path.toAgent(node) : path.toAction(node);
  @Workflow({ name: `${id}-workflow`, version: "1.0.0", flow: [path.toFinish(UnitRuleFinish)] })
  class Made {}
  return { start: Start, workflow: Made };
}

const nameOf = (start: Class): string => declarationOf(start)?.options.name ?? start.name;

/** An expose of `exports` whose first export answers with a direct message, `skills` over it. */
function exposeOf(exports: readonly Class[], skills: Record<string, object> = {}): Class {
  const first = exports[0];
  const name = first === undefined ? "none" : nameOf(first);
  @A2AExpose({
    name: "unit-rule-a2a-expose",
    version: "1.0.0",
    description: "Direct replies",
    exports: [...exports],
    skills: { [name]: { reply: A2AReply.Message }, ...skills },
  })
  class Made {}
  return Made;
}

const violationsOf = (workflows: readonly Class[], exposes: readonly Class[]) =>
  messageSkillViolations({
    name: "unit-rule-application",
    workflows,
    exposes,
  } as ApplicationOptions);

/** The problems of a skill running `nodes`: each `[code] text`, the skill's prefix cut. */
function problemsOf(nodes: readonly Class[]): string[] {
  const { start: exported, workflow } = skillOf(nodes);
  return violationsOf([workflow], [exposeOf([exported])]).map(
    (found) =>
      `[${found.code}] ${found.message.replace(/^.* must be stateless, but /, "").replace(/ — answer with a task.*$/, "")}`,
  );
}

describe("#860: a direct-reply skill's problems, each with its code and text", () => {
  it("an agent's question role and approval tool are pauses; a class of no decorator among its tools is read past", () => {
    expect(problemsOf([AskingAgent])).toEqual([
      "[a2a.message-skill-pause] asking-agent asks TckInputQuestion (a question role)",
      "[a2a.message-skill-pause] ApprovedReadTool asks for approval",
    ]);
  });

  it("an effect behind a harmless service, and an A2A client, are effects; a token and a cycle of deps are none", () => {
    expect(problemsOf([LateEffectAction, CallingAction, TokenAction, PlainAgent])).toEqual([
      "[a2a.message-skill-effect] Made injects OutboundCalls, which changes things outside the run",
      "[a2a.message-skill-effect] Made injects RuleA2AAgent, which changes things outside the run",
    ]);
  });

  it("an action committed with no undo declares its undo", () => {
    expect(problemsOf([CommittedAction])).toEqual([
      "[a2a.message-skill-compensation] committed-action declares its undo",
    ]);
  });

  it("a problem two agents share is one problem", () => {
    expect(problemsOf([FirstLedgerAgent, SecondLedgerAgent])).toEqual([
      "[a2a.message-skill-effect] LedgerReadTool injects FencedEffectRepository, which changes things outside the run",
    ]);
  });

  it("a node of no decorator is read past: another rule names it", () => {
    expect(problemsOf([PlainTool])).toEqual([]);
  });

  it("a recursion launches the workflow itself", () => {
    const found = violationsOf([OnceLevelWorkflow], [exposeOf([OnceLevelWorkflowStart])]);

    expect(found.map((one) => one.code)).toContain("a2a.message-skill-child");
  });

  it("is placed on the application, prefixed by the skill that answers with a message", () => {
    const { start: exported, workflow } = skillOf([CommittedAction]);

    expect(violationsOf([workflow], [exposeOf([exported])])).toEqual([
      {
        code: "a2a.message-skill-compensation",
        message: `${nameOf(exported)} answers with a direct message (A2AReply.Message) and must be stateless, but committed-action declares its undo — answer with a task (A2AReply.Task) or drop it`,
        nodes: ["unit-rule-application"],
      },
    ]);
  });
});

describe("#860: what the direct-reply rule reads past", () => {
  it("the skill's workflow found among several; a start of no listed workflow has none", () => {
    const quiet = skillOf([PlainAgent]);
    const busy = skillOf([CommittedAction]);

    expect(violationsOf([quiet.workflow, busy.workflow], [exposeOf([busy.start])])).toHaveLength(1);
    expect(violationsOf([quiet.workflow], [exposeOf([busy.start])])).toEqual([]);
  });

  it("a workflow, an export or an expose of no decorator, an MCP expose: nothing thrown, nothing found", () => {
    const { start: exported, workflow } = skillOf([PlainAgent]);
    @McpExpose({ name: "unit-rule-mcp-expose", version: "1.0.0", exports: [exported] })
    class UnitMcpExpose {}

    expect(violationsOf([PlainTool, workflow], [exposeOf([exported, PlainTool])])).toEqual([]);
    expect(violationsOf([workflow], [UnitMcpExpose, PlainTool])).toEqual([]);
  });

  it("an option of no reply for no export is no unknown reply; an export of no name never answers with a message", () => {
    const { start: exported, workflow } = skillOf([PlainAgent]);
    const expose = exposeOf([exported, PlainTool], {
      "files-only": { files: { maxFiles: 1 } },
      undefined: { reply: A2AReply.Message },
    });
    const meta = componentOf(expose);
    if (meta?.kind !== "a2a-expose") throw new Error("not an expose");

    const codes = violationsOf([workflow], [expose]).map((found) => found.message);

    expect(codes).toEqual([
      "unit-rule-a2a-expose sets the reply of undefined, which it does not export — name an exported start",
    ]);
    expect(messageSkillsOf(meta.meta)).toEqual([exported]);
    expect(violationsOf([workflow], [expose]).map((found) => found.nodes)).toEqual([
      ["unit-rule-application"],
    ]);
  });

  it("a defaultSkill of no export is placed on the application", () => {
    const { start: exported, workflow } = skillOf([PlainAgent]);
    @A2AExpose({
      name: "unit-default-a2a-expose",
      version: "1.0.0",
      description: "Direct replies",
      exports: [exported],
      defaultSkill: PlainTool,
    })
    class DefaultExpose {}

    expect(violationsOf([workflow], [DefaultExpose]).map((found) => found.nodes)).toEqual([
      ["unit-rule-application"],
    ]);
  });
});
