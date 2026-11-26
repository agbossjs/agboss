import { describe, expect } from "vitest";
import { Application } from "../../src/application/application.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import { ChannelSelector } from "../../src/channels/channel-selector.js";
import { Channel } from "../../src/components/decorators.js";
import { ExternalTask } from "../../src/channels/pause-targets.js";
import { Action } from "../../src/flow/decorators/action.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../src/flow/decorators/workflow-start.js";
import { Ttl } from "../../src/index.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { PauseRespondent } from "../../src/pause/respondent.js";
import { testWith } from "../../src/testing/index.js";
import { hours, days } from "../../src/units/index.js";
import { PauseError, PauseStatus } from "../../src/index.js";
import { execute } from "../helpers/flow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  ExpiryDecisionDto,
  ExpiryDoneDto,
  ExpiryOrderDto,
} from "../flow/fixtures/expiry.fixture.js";
import { onStart } from "../flow/fixtures/paths.js";

/**
 * Bug hunt 2026-11-25 (pauses, finding 3): a reassignment that sets a deadline counts as an
 * extension wherever it moves the pause — a move to another channel or target adds its
 * `timeout-changed` entry in the store's write, so `escalationLimits.maxExtensions` holds.
 */

const sent: string[] = [];

@ExternalTask({
  name: "hunt-limited-task-external-task",
  description: "one extension at most",
  input: ExpiryOrderDto,
  output: ExpiryDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
  escalationLimits: { maxExtensions: 1 },
})
class LimitedTask {}

@Channel({ name: "hunt-a-channel", description: "A", target: LimitedTask, ttl: days(1) })
class AChannel {
  send(ask: { pauseId: string }) {
    sent.push(ask.pauseId);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}
@Channel({ name: "hunt-b-channel", description: "B", target: LimitedTask, ttl: days(1) })
class BChannel {
  send(ask: { pauseId: string }) {
    sent.push(ask.pauseId);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}
@ChannelSelector({ name: "hunt-selector", description: "A", target: LimitedTask })
class Selector {
  selectChannel() {
    return AChannel;
  }
}
@WorkflowStart({
  name: "hunt-lim-start-workflow-start",
  description: "An order",
  input: ExpiryOrderDto,
})
class LimStart {}
@WorkflowFinish({
  name: "hunt-lim-finish-workflow-finish",
  description: "Done",
  output: ExpiryDoneDto,
})
class LimFinish {}
@Action({
  name: "hunt-lim-action",
  description: "x",
  input: { order: ExpiryOrderDto, decision: ExpiryDecisionDto },
  output: ExpiryDoneDto,
})
class LimAction {
  execute() {
    return Promise.resolve({ status: "ok" });
  }
}
@Workflow({
  name: "hunt-lim-workflow",
  version: "1.0.0",
  historyTtl: Ttl.None,
  flow: [onStart(LimStart).toExternalTask(LimitedTask).toAction(LimAction).toFinish(LimFinish)],
})
class LimWorkflow {}
@Application({
  name: "hunt-lim-application",
  version: "1.0.0",
  workflows: [LimWorkflow],
  providers: [AChannel, BChannel, Selector],
  budgets: TEST_BUDGETS,
})
class LimApplication {}

const test = testWith(LimApplication);
const operator = { actor: { id: "operator-1" } };

describe("maxExtensions and moved reassignments", () => {
  test("a move to another channel with a timeout counts as an extension: the second is refused, and so is extendPause", async ({
    app,
  }) => {
    const paused = await execute(app, LimStart, { orderId: "o-1" }, { threadId: "lim-1" });
    const pauses = () =>
      app
        .resolve(PausedExecutionRepository)
        .findAllByTenantIdAndRootExecutionId("default", paused.executionId);
    const live = async () => (await pauses()).find((pause) => pause.status === PauseStatus.Pending);
    const first = await live();

    await app.reassignPause(
      { pauseId: first?.pauseId ?? "", channel: BChannel, timeout: hours(48) },
      operator,
    );
    const moved = await live();
    const movedId = moved?.pauseId ?? "";
    expect(moved?.trail.map((entry) => entry.action)).toEqual([
      "opened",
      "reassigned",
      "timeout-changed",
    ]);

    await expect(
      app.reassignPause({ pauseId: movedId, channel: AChannel, timeout: hours(72) }, operator),
    ).rejects.toBeInstanceOf(PauseError.EscalationLimitExceeded);
    await expect(
      app.extendPause({ pauseId: movedId, expiresIn: hours(200) }, operator),
    ).rejects.toBeInstanceOf(PauseError.EscalationLimitExceeded);
    expect((await live())?.pauseId).toBe(movedId);
    // a move with no deadline is no extension: still allowed
    await app.reassignPause({ pauseId: movedId, channel: AChannel }, operator);
    expect(sent).toHaveLength(3);
  });
});
