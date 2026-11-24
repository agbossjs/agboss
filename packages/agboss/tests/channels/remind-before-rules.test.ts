/**
 * #942 (the assembly rules of a reminder): `[channel.remind-before-invalid]` for a role's
 * `remindBefore` that is no positive finite duration or is not shorter than the role's own
 * `expiresIn`; the warning `[channel.remind-before-exceeds-expiry]` (an error under `--strict`) when
 * a question step's or a tool's `expiresIn` is no longer than the role's `remindBefore` — that
 * pause gets no reminder; what is valid assembles; `agboss describe` says it.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { ChannelOf } from "../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import { ChannelRole, PauseAnswerer } from "../../src/channels/channel-role.decorator.js";
import { Channel, Tool } from "../../src/components/decorators.js";
import type { Class } from "../../src/components/injection.js";
import { Agent } from "../../src/flow/decorators/agent.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../src/flow/decorators/workflow-start.js";
import { checkWorkflow } from "../../src/flow/analyse/analyse.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { EmptyEnvironment } from "../../src/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { hours, minutes, seconds, type Milliseconds } from "../../src/units/index.js";
import { RecordExtensionAction } from "../flow/fixtures/pause-extension.fixture.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../flow/fixtures/paths.js";
import { AgentRefundDoneDto, AgentRefundDto } from "../flow/fixtures/agent-expiry.fixture.js";
import {
  ExpiryDecisionDto,
  ExpiryDoneDto,
  ExpiryOrderDto,
} from "../flow/fixtures/expiry.fixture.js";

const assemble = (application: Class) =>
  createTestAppWith(application, {
    processEnv: {},
    gateway: createScriptedGateway(new ScriptBook()),
  });

const violationsOf = async (
  application: Class,
): Promise<readonly { code: string; message: string }[]> => {
  const error: unknown = await assemble(application).catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(GraphRuleError);
  return (error as GraphRuleError).violations;
};

interface Times {
  readonly expiresIn?: Milliseconds | undefined;
  readonly remindBefore?: Milliseconds | undefined;
}

/** A question role with its times, its channel, and a workflow asking it (the step's own `expiresIn`). */
function questionFlow(name: string, role: Times, step?: Milliseconds) {
  @ChannelRole({
    name: `${name}-question`,
    description: "d",
    ask: ExpiryOrderDto,
    answer: ExpiryDecisionDto,
    answerer: PauseAnswerer.Channel,
    ...(role.expiresIn === undefined ? {} : { expiresIn: role.expiresIn }),
    ...(role.remindBefore === undefined ? {} : { remindBefore: role.remindBefore }),
  })
  abstract class SomeQuestion extends ChannelOf<SomeQuestion> {}
  @Channel({ name: `${name}-channel`, description: "d" })
  class SomeChannel extends SomeQuestion {
    send(): Promise<ChannelOutcome<SomeQuestion>> {
      return Promise.resolve(ChannelOutcome.awaitReply());
    }
  }
  @WorkflowStart({ name: `${name}-workflow-start`, description: "d", input: ExpiryOrderDto })
  class SomeStart {}
  @WorkflowFinish({ name: `${name}-workflow-finish`, description: "d", output: ExpiryDoneDto })
  class SomeFinish {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [
      onStart(SomeStart)
        .toExternalTask(SomeQuestion, step === undefined ? undefined : { expiresIn: step })
        .toAction(RecordExtensionAction)
        .toFinish(SomeFinish),
    ],
  })
  class SomeWorkflow {}
  @Application({
    name: `${name}-application`,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [SomeWorkflow],
    budgets: TEST_BUDGETS,
    providers: [SomeChannel],
  })
  class SomeApplication {}
  return { workflow: SomeWorkflow, application: SomeApplication, role: SomeQuestion };
}

/** An approval role asked through agent tools with their own `expiresIn`. */
function toolFlow(
  name: string,
  toolExpiresIn: Milliseconds | undefined,
  remindBefore: Milliseconds = hours(2),
) {
  @ChannelRole({
    name: `${name}-approval`,
    description: "d",
    approves: AgentRefundDto,
    answerer: PauseAnswerer.Channel,
    expiresIn: hours(24),
    remindBefore,
  })
  abstract class SomeApproval extends ChannelOf<SomeApproval> {}
  @Channel({ name: `${name}-channel`, description: "d" })
  class SomeChannel extends SomeApproval {
    send(): Promise<ChannelOutcome<SomeApproval>> {
      return Promise.resolve(ChannelOutcome.awaitReply());
    }
  }
  @Tool({
    name: `${name}-refund-tool`,
    description: "d",
    channel: SomeApproval,
    ...(toolExpiresIn === undefined ? {} : { expiresIn: toolExpiresIn }),
    input: AgentRefundDto,
    output: AgentRefundDoneDto,
  })
  class SomeTool {
    execute(): Promise<AgentRefundDoneDto> {
      return Promise.resolve({ text: "done" });
    }
  }
  @Agent({
    name: `${name}-agent`,
    description: "d",
    prompt: "Refund.",
    model: "moonshotai/kimi-k2.6",
    tools: [SomeTool],
    input: { request: AgentRefundDto },
    output: AgentRefundDoneDto,
  })
  class SomeAgent {}
  @WorkflowStart({ name: `${name}-workflow-start`, description: "d", input: AgentRefundDto })
  class SomeStart {}
  @WorkflowFinish({ name: `${name}-workflow-finish`, description: "d", output: AgentRefundDoneDto })
  class SomeFinish {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [onStart(SomeStart).toAgent(SomeAgent).toFinish(SomeFinish)],
  })
  class SomeWorkflow {}
  return { workflow: SomeWorkflow, channel: SomeChannel };
}

const warningsOf = (workflow: Class, strict = false) => {
  const checked = checkWorkflow(workflow, { strict });
  return {
    errors: checked.errors.map((one) => one.code),
    warnings: checked.warnings.map((one) => one.code),
  };
};

describe("#942: a role's remindBefore", () => {
  it("[channel.remind-before-invalid]: zero, negative, not finite, not a number", async () => {
    for (const [index, bad] of [0, -1, Infinity, Number.NaN, "1h"].entries()) {
      const { application } = questionFlow(`bad${String(index)}`, { remindBefore: bad as never });

      expect(await violationsOf(application)).toEqual([
        expect.objectContaining({
          code: "channel.remind-before-invalid",
          message: expect.stringContaining(`bad${String(index)}-question`),
        }),
      ]);
    }
  });

  it("[channel.remind-before-invalid]: not shorter than the role's own expiresIn", async () => {
    for (const [index, remindBefore] of [hours(24), hours(25)].entries()) {
      const { application } = questionFlow(`long${String(index)}`, {
        expiresIn: hours(24),
        remindBefore,
      });

      const found = await violationsOf(application);

      expect(found).toEqual([expect.objectContaining({ code: "channel.remind-before-invalid" })]);
      expect(found[0]?.message).toContain("expiresIn");
    }
  });

  it("a remindBefore shorter than expiresIn, and one with no expiresIn, assemble", async () => {
    for (const [index, times] of [
      { expiresIn: hours(24), remindBefore: hours(23) },
      { expiresIn: seconds(2), remindBefore: seconds(1) },
      { remindBefore: minutes(5) },
    ].entries()) {
      const { application } = questionFlow(`good${String(index)}`, times);

      const app = await assemble(application);
      expect(app.warnings.filter((one) => one.includes("remind-before"))).toEqual([]);
      await app.close();
    }
  });
});

describe("#942: [channel.remind-before-exceeds-expiry]", () => {
  it("a question step's expiresIn not longer than the role's remindBefore: a warning, an error under strict", () => {
    for (const step of [hours(2), hours(1)]) {
      const { workflow } = questionFlow(
        `step${String(step)}`,
        { expiresIn: hours(24), remindBefore: hours(2) },
        step,
      );

      expect(warningsOf(workflow)).toEqual({
        errors: [],
        warnings: ["channel.remind-before-exceeds-expiry"],
      });
      expect(warningsOf(workflow, true)).toEqual({
        errors: ["channel.remind-before-exceeds-expiry"],
        warnings: [],
      });
    }
  });

  it("a step longer than the reminder, or none: nothing", () => {
    for (const [index, step] of [hours(3), undefined].entries()) {
      const { workflow } = questionFlow(
        `fine${String(index)}`,
        { expiresIn: hours(24), remindBefore: hours(2) },
        step,
      );

      expect(warningsOf(workflow, true)).toEqual({ errors: [], warnings: [] });
    }
  });

  it("a role without remindBefore is never warned about", () => {
    const { workflow } = questionFlow("plain", { expiresIn: hours(24) }, hours(1));

    expect(warningsOf(workflow, true)).toEqual({ errors: [], warnings: [] });
  });

  it("a tool's expiresIn not longer than its role's remindBefore: a warning; a longer one, or none: nothing", () => {
    expect(warningsOf(toolFlow("short", hours(2)).workflow)).toEqual({
      errors: [],
      warnings: ["channel.remind-before-exceeds-expiry"],
    });
    expect(warningsOf(toolFlow("urgent", minutes(5)).workflow).warnings).toEqual([
      "channel.remind-before-exceeds-expiry",
    ]);
    expect(warningsOf(toolFlow("long", hours(3)).workflow, true)).toEqual({
      errors: [],
      warnings: [],
    });
    expect(warningsOf(toolFlow("bare", undefined).workflow, true)).toEqual({
      errors: [],
      warnings: [],
    });
  });
});

describe("#1099: [channel.remind-before-below-tick]", () => {
  it("a role's remindBefore shorter than the pause timers' tick: a warning (an error under strict), the rule's message says why", () => {
    const { workflow } = questionFlow("quick", { expiresIn: hours(24), remindBefore: seconds(2) });

    expect(warningsOf(workflow)).toEqual({
      errors: [],
      warnings: ["channel.remind-before-below-tick"],
    });
    expect(warningsOf(workflow, true)).toEqual({
      errors: ["channel.remind-before-below-tick"],
      warnings: [],
    });
    expect(
      checkWorkflow(workflow)
        .warnings.map((one) => one.message)
        .join(),
    ).toContain("shorter than the pause timers' tick (5000 ms)");
  });

  it("exactly the tick, or longer, or none: nothing", () => {
    for (const [index, remindBefore] of [seconds(5), seconds(6), minutes(1), undefined].entries()) {
      const { workflow } = questionFlow(`tick${String(index)}`, {
        expiresIn: hours(24),
        remindBefore,
      });

      expect(warningsOf(workflow, true)).toEqual({ errors: [], warnings: [] });
    }
  });

  it("a tool's role is checked too; exactly the tick on it is fine", () => {
    expect(warningsOf(toolFlow("quicktool", hours(3), seconds(1)).workflow).warnings).toEqual([
      "channel.remind-before-below-tick",
    ]);
    expect(warningsOf(toolFlow("slowtool", hours(3), seconds(5)).workflow, true)).toEqual({
      errors: [],
      warnings: [],
    });
  });
});
