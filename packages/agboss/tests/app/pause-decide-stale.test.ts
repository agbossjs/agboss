/**
 * #1307 (A2, review of #1421, H1 and M1): a channel's decision at once is the decision of the pause
 * it was sent. An expiry that changed the pause in place while `send` was still returning
 * (reassigned it to a manager under a new deadline) makes that decision stale: never taken, the pause
 * waits for the manager — and, marked sent by the step, its channel and listeners are told.
 */
import { beforeEach, describe, expect } from "vitest";
import { Application } from "../../src/application/application.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import { PauseExpiration } from "../../src/channels/pause-expiration.js";
import { ExternalTask } from "../../src/channels/pause-targets.js";
import { Channel } from "../../src/components/decorators.js";
import { Action } from "../../src/flow/decorators/action.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../src/flow/decorators/workflow-start.js";
import { ExecutionStatus, PauseStatus, Ttl } from "../../src/index.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { NO_RECIPIENTS } from "../../src/infrastructure/pause-notices.js";
import { withSeenNow } from "../../src/testing/contracts/paused-execution-data.js";
import { PauseRespondent } from "../../src/pause/respondent.js";
import { testWith } from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { days, hours, seconds } from "../../src/units/index.js";
import { until } from "../channels/fixtures/pause-scripts.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  ExpiryDecisionDto,
  ExpiryDoneDto,
  ExpiryOrderDto,
} from "../flow/fixtures/expiry.fixture.js";
import { onStart } from "../flow/fixtures/paths.js";
import { execute } from "../helpers/flow.js";

const told = {
  sent: [] as string[],
  reassigned: [] as { assignees?: readonly string[]; previousAssignees?: readonly string[] }[],
  hold: undefined as Promise<void> | undefined,
};

beforeEach(() => {
  told.sent.length = 0;
  told.reassigned.length = 0;
  told.hold = undefined;
});

@ExternalTask({
  name: "stale-decision-external-task",
  description: "Ten seconds to answer; an expiry hands it to the manager",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: seconds(10),
})
class StaleTask {
  onExpired() {
    return PauseExpiration.reassign({ assignees: ["manager"], timeout: hours(2) });
  }
}

@Channel({
  name: "stale-decision-channel",
  description: "Decides at once, but only after a held send",
  target: StaleTask,
  ttl: days(1),
})
class StaleChannel {
  async send(ask: { pauseId: string }) {
    told.sent.push(ask.pauseId);
    await told.hold;
    return ChannelOutcome.decided({ approved: true, comment: "clerk" });
  }

  onPauseReassigned(event: { assignees?: readonly string[] }): Promise<void> {
    told.reassigned.push(event);
    return Promise.resolve();
  }
}

@WorkflowStart({ name: "stale-workflow-start", description: "An order", input: ExpiryOrderDto })
class StaleStart {}

@WorkflowFinish({ name: "stale-workflow-finish", description: "Done", output: ExpiryDoneDto })
class StaleFinish {}

@Action({
  name: "record-stale-action",
  description: "Records the decision",
  input: { order: ExpiryOrderDto, decision: ExpiryDecisionDto },
  output: ExpiryDoneDto,
})
class RecordStaleAction {
  execute({ order }: { order: ExpiryOrderDto }): Promise<ExpiryDoneDto> {
    return Promise.resolve({ status: order.orderId });
  }
}

@Workflow({
  name: "stale-workflow",
  version: "1.0.0",
  historyTtl: Ttl.None,
  flow: [
    onStart(StaleStart).toExternalTask(StaleTask).toAction(RecordStaleAction).toFinish(StaleFinish),
  ],
})
class StaleWorkflow {}

@Application({
  name: "stale-decision-application",
  version: "1.0.0",
  workflows: [StaleWorkflow],
  providers: [StaleChannel],
  budgets: TEST_BUDGETS,
})
class StaleApplication {}

const test = testWith(StaleApplication);

const pauseOf = async (app: TestApp, pauseId: string) => {
  const found = await app
    .resolve(PausedExecutionRepository)
    .findByTenantIdAndPauseId("default", pauseId);
  if (found === undefined) throw new Error("the pause is gone");
  return found;
};

describe("a decision at once from a send that outlived an expiry's reassignment", () => {
  test("is not taken: the pause waits for the manager, is marked sent, and its channel is told it was reassigned", async ({
    app,
    clock,
  }) => {
    let release: () => void = () => undefined;
    told.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = execute(app, StaleStart, { orderId: "o-1" }, { threadId: "stale-1" });
    await until(() => told.sent.length === 1);
    const pauseId = told.sent[0] ?? "";

    // the deadline passes while `send` is still returning: the expiry's due-at reassignment, as its
    // worker makes it (the store's compare-and-set; the asking step holds the tree, so the worker's
    // own tree move is not what this pins)
    await clock.advance(seconds(15));
    const store = app.resolve(PausedExecutionRepository);
    const moved = await store.reassignByTenantIdAndPauseId(
      "default",
      pauseId,
      await withSeenNow(store, pauseId, {
        assignees: ["manager"],
        due: { expiresAt: new Date(clock.now().getTime() + hours(2)).toISOString() },
      }),
      clock.now(),
      NO_RECIPIENTS,
    );
    expect(moved?.assignees).toEqual(["manager"]);
    expect((await pauseOf(app, pauseId)).isSent).toBe(false);
    release();
    const paused = await running;

    const stored = await pauseOf(app, pauseId);
    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(stored).toMatchObject({
      status: PauseStatus.Pending,
      assignees: ["manager"],
      isSent: true,
    });
    expect(stored.answer).toBeUndefined();
    expect(stored.trail.map((entry) => entry.action)).toEqual(["opened", "reassigned"]);
    await until(() => told.reassigned.length === 1);
    expect(told.reassigned[0]).toMatchObject({ assignees: ["manager"] });
    const done = await app.resume(
      { pauseId, decision: { approved: true } },
      { actor: { id: "manager" } },
    );
    expect(done.status).toBe(ExecutionStatus.Finished);
  });
});
