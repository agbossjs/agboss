/**
 * #860 (mutation shard `a2a-direct`): the direct-reply rule on an application's declarations alone
 * — each problem's code and text: a question role and an approval tool among an agent's tools, an
 * effect behind a harmless service, an A2A client, an action committed with no undo, a recursion;
 * each problem once; a token, a cycle of deps, a class of no decorator (as a tool, a node, a
 * workflow, an export, an expose) read past without a throw; a skill option of no reply; the start
 * of no listed workflow; every violation placed on the application.
 */
import { ComponentKind } from "../../../src/flow/runtime/records.js";
import { hours, minutes, Ttl } from "../../../src/units/index.js";
import { describe, expect, it } from "vitest";
import { A2AEndpoint, A2AReply } from "../../../src/a2a/a2a-endpoint.decorator.js";
import { boundClassesOf, effectOf } from "../../../src/a2a/a2a-effect-reach.js";
import { Idempotency } from "../../../src/app/idempotency.js";
import { Injectable } from "../../../src/components/decorators.js";
import { Clock } from "../../../src/infrastructure/clock.js";
import { messageSkillViolations } from "../../../src/a2a/a2a-message-skill-rule.js";
import type { ApplicationOptions } from "../../../src/application/application.js";
import type { Class } from "../../../src/components/injection.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { declarationOf } from "../../../src/flow/decorators/declaration.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { McpEndpoint } from "../../../src/mcp/mcp-endpoint.decorator.js";
import {
  OnceLevelWorkflow,
  OnceLevelWorkflowStart,
} from "../../app/fixtures/undo-once.workflow.js";
import { onStart } from "../../helpers/flow.js";
import {
  AskingAgent,
  CallingAction,
  CommittedAction,
  FirstLedgerAgent,
  LoopService,
  REGION,
  RuleA2AAgent,
  LateEffectAction,
  PlainAgent,
  PlainTool,
  PortAction,
  PortMcpServer,
  UnboundPortAction,
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
  let path = onStart(Start);
  for (const node of nodes)
    path =
      declarationOf(node)?.kind === ComponentKind.Agent ? path.toAgent(node) : path.toAction(node);
  @Workflow({
    name: `${id}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [path.toFinish(UnitRuleFinish)],
  })
  class Made {}
  return { start: Start, workflow: Made };
}

const nameOf = (start: Class): string => declarationOf(start)?.options.name ?? start.name;

/** An expose of `exports` whose first export answers with a direct message, `skills` over it. */
function exposeOf(exports: readonly Class[]): Class {
  const first = exports[0];
  @A2AEndpoint({
    name: "unit-rule-a2a-expose",
    version: "1.0.0",
    description: "Direct replies",
    ttl: { tasks: hours(24), messages: minutes(15) },
    skills: exports.map((start) => (start === first ? { start, reply: A2AReply.Message } : start)),
  })
  class Made {}
  return Made;
}

const violationsOf = (
  workflows: readonly Class[],
  endpoints: readonly Class[],
  more: Partial<ApplicationOptions> = {},
) =>
  messageSkillViolations({
    name: "unit-rule-application",
    workflows,
    endpoints,
    ...more,
  } as ApplicationOptions);

/** The problems of a skill running `nodes`: each `[code] text`, the skill's prefix cut. */
function problemsOf(nodes: readonly Class[], more: Partial<ApplicationOptions> = {}): string[] {
  const { start: exported, workflow } = skillOf(nodes);
  return violationsOf([workflow], [exposeOf([exported])], more).map(
    (found) =>
      `[${found.code}] ${found.message.replace(/^.* must be stateless, but /, "").replace(/ — answer with a task.*$/, "")}`,
  );
}

describe("#860: a direct-reply skill's problems, each with its code and text", () => {
  it("an agent's question role and approval tool are pauses; a class of no decorator among its tools is read past", () => {
    expect(problemsOf([AskingAgent])).toEqual([
      "[a2a.message-skill-pause] asking-agent asks TckInputExternalTask (an external task)",
      "[a2a.message-skill-pause] ApprovedReadTool asks for approval",
    ]);
  });

  it("an effect behind a harmless service, and an A2A client, are effects; a token and a cycle of deps are none", () => {
    expect(problemsOf([LateEffectAction, CallingAction, TokenAction, PlainAgent])).toEqual([
      "[a2a.message-skill-effect] Made injects Idempotency, which changes things outside the run",
      "[a2a.message-skill-effect] Made injects RuleA2AAgent, which changes things outside the run",
    ]);
  });

  it("a port bound by injectAs to an MCP server is that effect; a port bound to nothing is refused", () => {
    expect(problemsOf([PortAction], { services: [PortMcpServer] })).toEqual([
      "[a2a.message-skill-effect] Made injects PortMcpServer, which changes things outside the run",
    ]);
    expect(problemsOf([UnboundPortAction])).toEqual([
      "[a2a.message-skill-effect] Made injects UnboundPort, which changes things outside the run",
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
    @McpEndpoint({ name: "unit-rule-mcp-expose", version: "1.0.0", tools: [exported] })
    class UnitMcpEndpoint {}

    expect(violationsOf([PlainTool, workflow], [exposeOf([exported, PlainTool])])).toEqual([]);
    expect(violationsOf([workflow], [UnitMcpEndpoint, PlainTool])).toEqual([]);
  });

  it("a defaultSkill of no export is placed on the application", () => {
    const { start: exported, workflow } = skillOf([PlainAgent]);
    @A2AEndpoint({
      name: "unit-default-a2a-expose",
      version: "1.0.0",
      description: "Direct replies",
      defaultSkill: PlainTool,
      ttl: { tasks: hours(24), messages: minutes(15) },
      skills: [exported],
    })
    class DefaultExpose {}

    expect(violationsOf([workflow], [DefaultExpose]).map((found) => found.nodes)).toEqual([
      ["unit-rule-application"],
    ]);
  });
});

@Injectable()
class ReachHarmless {}
@Injectable({ deps: [Idempotency] })
class ReachWriter {}
@Injectable({ deps: [ReachHarmless] })
class ReachViaHarmless {}
@Injectable({ deps: [ReachWriter] })
class ReachViaWriter {}
@Injectable({ deps: [ReachHarmless, ReachWriter] })
class ReachSecondDepWrites {}
abstract class ReachPort {
  abstract port(): void;
}
@Injectable()
class ReachHarmlessPortImpl extends ReachPort {
  port(): void {
    return undefined;
  }
}
@Injectable({ deps: [Idempotency] })
class ReachWritingPortImpl extends ReachPort {
  port(): void {
    return undefined;
  }
}
@Injectable({ deps: [ReachPort] })
class ReachUsesPort {}
@Injectable({ deps: [Clock] })
class ReachUsesClock {}
abstract class ReachOwnClock extends Clock {}
@Injectable({ deps: [ReachOwnClock] })
class ReachUsesOwnClock {}
class ReachUndecorated {
  readonly kind = "undecorated";
}
@Injectable({ deps: [ReachUndecorated] })
class ReachUsesUndecorated {}
@Injectable({ deps: [RuleA2AAgent] })
class ReachUsesA2A {}

describe("#1319: the effect a component's deps reach", () => {
  it("none behind a harmless service; the effect itself; one behind another service; the first of several deps", () => {
    expect(effectOf(ReachViaHarmless, [])).toBeUndefined();
    expect(effectOf(ReachWriter, [])).toBe(Idempotency);
    expect(effectOf(ReachViaWriter, [])).toBe(Idempotency);
    expect(effectOf(ReachSecondDepWrites, [])).toBe(Idempotency);
    expect(effectOf(ReachUsesA2A, [])).toBe(RuleA2AAgent);
  });

  it("a cycle of deps ends with none", () => {
    expect(effectOf(LoopService, [])).toBeUndefined();
  });

  it("a port is the effect of the class bound to it, or what that class reaches; a harmless one, none, whatever else is bound", () => {
    expect(effectOf(ReachUsesPort, [ReachHarmlessPortImpl])).toBeUndefined();
    expect(effectOf(ReachUsesPort, [ReachHarmlessPortImpl, ReachWriter])).toBeUndefined();
    expect(effectOf(ReachUsesPort, [ReachWritingPortImpl])).toBe(Idempotency);
    expect(effectOf(ReachUsesPort, [ReachPort as never])).toBe(ReachPort);
  });

  it("a port that nothing bound implements is the effect itself", () => {
    expect(effectOf(ReachUsesPort, [])).toBe(ReachPort);
    expect(effectOf(ReachUsesUndecorated, [])).toBe(ReachUndecorated);
  });

  it("the clocks and contexts every container has are no effect, nor a class that extends one", () => {
    expect(effectOf(ReachUsesClock, [])).toBeUndefined();
    expect(effectOf(ReachUsesOwnClock, [])).toBeUndefined();
  });

  it("a port with several implementations is the first effect among them, in the order bound", () => {
    expect(effectOf(ReachUsesPort, [ReachHarmlessPortImpl, ReachWritingPortImpl])).toBe(
      Idempotency,
    );
    expect(effectOf(ReachUsesPort, [ReachWritingPortImpl, ReachHarmlessPortImpl])).toBe(
      Idempotency,
    );
  });

  it("a value token and a function with no prototype are read past, the first with bound classes about", () => {
    const arrow = () => 1;
    @Injectable({ deps: [REGION as never, arrow as never] })
    class ReachUsesOdd {}

    expect(effectOf(ReachUsesOdd, [ReachHarmlessPortImpl])).toBe(arrow);
    @Injectable({ deps: [REGION as never] })
    class ReachUsesValue {}
    expect(effectOf(ReachUsesValue, [ReachHarmlessPortImpl, ReachWriter])).toBeUndefined();
  });

  it("a node of the flow, declared and not a component, is no port without a class", () => {
    @Injectable({ deps: [PlainAgent] })
    class ReachUsesAgent {}

    expect(effectOf(ReachUsesAgent, [])).toBeUndefined();
  });

  it("a port bound to an MCP server is that server", () => {
    expect(effectOf(PortAction, [PortMcpServer])).toBe(PortMcpServer);
  });
});

describe("#1319: the classes an application can bind to a port", () => {
  it("its providers and services, then those of its workflows and their children", () => {
    @Workflow({
      name: "reach-bound-workflow",
      version: "1.0.0",
      historyTtl: Ttl.Forever,
      flow: [onStart(ReachBoundStart).toFinish(UnitRuleFinish)],
      providers: [ReachHarmless],
      services: [ReachHarmlessPortImpl],
    })
    class BoundWorkflow {}
    const plain = skillOf([PlainAgent]).workflow;

    const bound = boundClassesOf({
      providers: [ReachWriter],
      services: [ReachViaWriter],
      workflows: [BoundWorkflow, plain, PlainTool],
    } as never);

    expect(bound).toEqual([ReachWriter, ReachViaWriter, ReachHarmless, ReachHarmlessPortImpl]);
    expect(boundClassesOf({ workflows: [] } as never)).toEqual([]);
  });
});

@WorkflowStart({
  name: "reach-bound-workflow-start",
  description: "Reach",
  input: WorkflowStartTextDto,
})
class ReachBoundStart {}
