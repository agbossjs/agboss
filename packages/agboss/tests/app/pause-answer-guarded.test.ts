/**
 * #1307, H2: a target that guards its answers with `permitAnswer` must not lose that guard to an
 * operator act that forces what only an answer may — a shorter deadline makes `onExpired` decide
 * (it may auto-approve), a reassignment changes who answers. Without `permitTimeoutChange` /
 * `permitReassign` on that target such an act is `PauseError.PermissionDenied` (fail closed);
 * a longer deadline is allowed; declaring the hook allows the rest (the hook then decides).
 */
import { describe, expect } from "vitest";
import { Application } from "../../src/application/application.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import { PauseExpiration } from "../../src/channels/pause-expiration.js";
import { ExternalTask } from "../../src/channels/pause-targets.js";
import { Channel } from "../../src/components/decorators.js";
import { Action } from "../../src/flow/decorators/action.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../src/flow/decorators/workflow-start.js";
import { PauseError, Ttl } from "../../src/index.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { PauseRespondent } from "../../src/pause/respondent.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { days, hours, Timeout } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  ExpiryDecisionDto,
  ExpiryDoneDto,
  ExpiryOrderDto,
} from "../flow/fixtures/expiry.fixture.js";
import { onStart } from "../flow/fixtures/paths.js";
import { execute } from "../helpers/flow.js";

const sent: string[] = [];

/** Only `permitAnswer`; an expiry would approve. */
@ExternalTask({
  name: "answer-guarded-external-task",
  description: "Finance approves; an expiry approves too",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
})
class GuardedTask {
  permitAnswer(): boolean {
    return true;
  }

  onExpired(): never {
    return PauseExpiration.decide({ approved: true }) as never;
  }
}

/** `permitAnswer` and both operator hooks: the hooks decide. */
@ExternalTask({
  name: "answer-and-hooks-external-task",
  description: "Finance approves; operators are asked",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
})
class HookedTask {
  permitAnswer(): boolean {
    return true;
  }

  permitTimeoutChange(): boolean {
    return true;
  }

  permitReassign(): boolean {
    return true;
  }
}

/** No hook at all: nothing guards the answers, so nothing is refused. */
@ExternalTask({
  name: "unguarded-external-task",
  description: "Anybody may answer",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
})
class OpenTask {}

const channelOf = (target: new () => object, name: string) => {
  @Channel({ name, description: "Asks", target, ttl: days(1) })
  class AskChannel {
    send(ask: { pauseId: string }) {
      sent.push(ask.pauseId);
      return Promise.resolve(ChannelOutcome.awaitReply());
    }
  }
  return AskChannel;
};

@WorkflowStart({ name: "guarded-workflow-start", description: "An order", input: ExpiryOrderDto })
class GuardedStart {}
@WorkflowStart({ name: "hooked-workflow-start", description: "An order", input: ExpiryOrderDto })
class HookedStart {}
@WorkflowStart({ name: "open-workflow-start", description: "An order", input: ExpiryOrderDto })
class OpenStart {}

@WorkflowFinish({ name: "guarded-workflow-finish", description: "Done", output: ExpiryDoneDto })
class GuardedFinish {}

@Action({
  name: "record-guarded-action",
  description: "Records",
  input: { order: ExpiryOrderDto, decision: ExpiryDecisionDto },
  output: ExpiryDoneDto,
})
class RecordGuardedAction {
  execute({ order }: { order: ExpiryOrderDto }): Promise<ExpiryDoneDto> {
    return Promise.resolve({ status: order.orderId });
  }
}

const flowOf = (name: string, start: new () => object, target: new () => object) => {
  @Workflow({
    name,
    version: "1.0.0",
    historyTtl: Ttl.None,
    flow: [
      onStart(start).toExternalTask(target).toAction(RecordGuardedAction).toFinish(GuardedFinish),
    ],
  })
  class OneFlow {}
  return OneFlow;
};

@Application({
  name: "answer-guarded-application",
  version: "1.0.0",
  workflows: [
    flowOf("guarded-workflow", GuardedStart, GuardedTask),
    flowOf("hooked-workflow", HookedStart, HookedTask),
    flowOf("open-workflow", OpenStart, OpenTask),
  ],
  providers: [
    channelOf(GuardedTask, "answer-guarded-channel"),
    channelOf(HookedTask, "answer-and-hooks-channel"),
    channelOf(OpenTask, "unguarded-channel"),
  ],
  budgets: TEST_BUDGETS,
})
class GuardedApplication {}

const test = testWith(GuardedApplication);
const operator = { actor: { id: "operator-1" } };

async function opened(app: TestApp, start: new () => object): Promise<string> {
  sent.length = 0;
  await execute(app, start, { orderId: "o-1" }, { threadId: `t-${start.name}` });
  return sent[0] ?? "";
}

const deadlineOf = async (app: TestApp, pauseId: string) =>
  (await app.resolve(PausedExecutionRepository).findByTenantIdAndPauseId("default", pauseId))
    ?.expiresAt;

const failureOf = (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("a target with permitAnswer and no permitTimeoutChange", () => {
  test("a shorter deadline is PauseError.PermissionDenied, the deadline untouched: it could make onExpired approve", async ({
    app,
  }) => {
    const pauseId = await opened(app, GuardedStart);
    const before = await deadlineOf(app, pauseId);

    const refused = await failureOf(app.setPauseTimeout({ pauseId, timeout: hours(1) }, operator));

    expect(refused).toBeInstanceOf(PauseError.PermissionDenied);
    expect(refused).toMatchObject({ message: expect.stringContaining("permitTimeoutChange") });
    expect(await deadlineOf(app, pauseId)).toBe(before);
  });

  test("Timeout.None over a deadline is refused too; a longer deadline is allowed", async ({
    app,
  }) => {
    const pauseId = await opened(app, GuardedStart);

    const none = await failureOf(app.setPauseTimeout({ pauseId, timeout: Timeout.None }, operator));
    const longer = await app.setPauseTimeout({ pauseId, timeout: hours(30) }, operator);

    expect(none).toBeInstanceOf(PauseError.PermissionDenied);
    expect(longer.expiresAt).toBeInstanceOf(Date);
  });
});

describe("a target with permitAnswer and no permitReassign", () => {
  test("reassignPause is PauseError.PermissionDenied, the pause untouched", async ({ app }) => {
    const pauseId = await opened(app, GuardedStart);

    const refused = await failureOf(
      app.reassignPause({ pauseId, assignees: ["deputy-1"] }, operator),
    );

    expect(refused).toBeInstanceOf(PauseError.PermissionDenied);
    expect(refused).toMatchObject({ message: expect.stringContaining("permitReassign") });
    expect(
      (await app.resolve(PausedExecutionRepository).findByTenantIdAndPauseId("default", pauseId))
        ?.assignees,
    ).toBeUndefined();
  });
});

describe("the hooks declared, or nothing guarded: nothing is refused for the guard", () => {
  test("permitAnswer with permitTimeoutChange and permitReassign: the hooks decide, both acts go through", async ({
    app,
  }) => {
    const pauseId = await opened(app, HookedStart);

    const shorter = await app.setPauseTimeout({ pauseId, timeout: hours(1) }, operator);
    const moved = await app.reassignPause({ pauseId, assignees: ["deputy-1"] }, operator);

    expect(shorter.expiresAt).toBeInstanceOf(Date);
    expect(moved.assignees).toEqual(["deputy-1"]);
  });

  test("no permitAnswer: a shorter deadline and a reassignment are as before", async ({ app }) => {
    const pauseId = await opened(app, OpenStart);

    const shorter = await app.setPauseTimeout({ pauseId, timeout: hours(1) }, operator);
    const moved = await app.reassignPause({ pauseId, assignees: ["deputy-1"] }, operator);

    expect(shorter.expiresAt).toBeInstanceOf(Date);
    expect(moved.assignees).toEqual(["deputy-1"]);
  });
});
