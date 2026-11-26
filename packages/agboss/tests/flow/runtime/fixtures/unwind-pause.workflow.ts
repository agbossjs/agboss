import {
  Agent,
  Channel,
  ChannelOutcome,
  PauseRespondent,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ChannelAsk,
  type Tracked,
  Action,
  inline,
  ToolApproval,
  Ttl,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { onStart } from "../../../helpers/flow.js";
import {
  ReservedDto,
  ReserveRoomAction,
  ReserveSeatAction,
  RoomDto,
  SeatDto,
  UndoDesk,
  UndoRequestDto,
} from "./undo.workflow.js";
import { UnwindLog } from "./unwind.workflow.js";
import { days } from "../../../../src/units/index.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";

/**
 * #340 PR 3 — trees that rest paused when they are cancelled: a room reserved, then an agent that
 * asks the guest (the thread's owner) before it answers; once at the root, once in a child under a
 * reserved seat — a cancel withdraws the question and undoes both, the child's from its checkpoint.
 */

@ToolApproval({
  name: "guest-tool-approval",
  description: "The guest approves the reservation",
  input: UndoRequestDto,
  respondent: PauseRespondent.Owner,
  timeout: days(365),
})
export class GuestToolApproval {}

@Channel({
  name: "guest-inbox-channel",
  description: "Asks the guest and waits",
  target: GuestToolApproval,
  ttl: days(1),
})
export class GuestInboxChannel {
  send(_ask: ChannelAsk<GuestToolApproval>): Promise<ChannelOutcome<GuestToolApproval>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Tool({
  name: "ask-guest-tool",
  description: "Asks the guest to approve",
  input: UndoRequestDto,
  output: UndoRequestDto,
  approval: GuestToolApproval,
})
export class AskGuestTool {
  execute(request: UndoRequestDto): Promise<UndoRequestDto> {
    return Promise.resolve(request);
  }
}

@Agent({
  name: "guest-agent",
  description: "Confirms the room with the guest",
  prompt: inline("Ask the guest, then say what is reserved."),
  model: "moonshotai/kimi-k2.6",
  input: { room: RoomDto },
  output: ReservedDto,
  tools: [AskGuestTool],
})
export class GuestAgent {}

@WorkflowFinish({
  name: "guest-reserved-workflow-finish",
  description: "Reserved",
  output: ReservedDto,
})
export class GuestReservedWorkflowFinish {}

@WorkflowStart({
  name: "unwind-guest-workflow-start",
  description: "A guest",
  input: UndoRequestDto,
})
export class UnwindGuestWorkflowStart {}

/** A room, then the guest's approval. */
@Workflow({
  name: "unwind-guest-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(UnwindGuestWorkflowStart)
      .toAction(ReserveRoomAction)
      .toAgent(GuestAgent)
      .toFinish(GuestReservedWorkflowFinish),
  ],
  providers: [UndoDesk],
})
export class UnwindGuestWorkflow {}

@WorkflowStart({
  name: "unwind-paused-workflow-start",
  description: "A seat, then the guest's room",
  input: UndoRequestDto,
})
export class UnwindPausedWorkflowStart {}

@Action({
  name: "seat-reserved-action",
  description: "The seat and the guest's room",
  input: { seat: SeatDto, reserved: ReservedDto },
  output: ReservedDto,
})
export class SeatReservedAction {
  async execute(input: {
    readonly seat: Tracked<SeatDto>;
    readonly reserved: Tracked<ReservedDto>;
  }): Promise<ReservedDto> {
    return { summary: `${input.seat.seatId} + ${input.reserved.summary}` };
  }
}

@WorkflowFinish({
  name: "seat-reserved-workflow-finish",
  description: "The seat and the guest's room",
  output: ReservedDto,
})
export class SeatReservedWorkflowFinish {}

/** A seat, then the child that waits for the guest. */
@Workflow({
  name: "unwind-paused-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(UnwindPausedWorkflowStart)
      .toAction(ReserveSeatAction)
      .toWorkflow(UnwindGuestWorkflow)
      .toAction(SeatReservedAction)
      .toFinish(SeatReservedWorkflowFinish),
  ],
  providers: [UndoDesk],
})
export class UnwindPausedWorkflow {}

@Application({
  name: "unwind-pause-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [UnwindGuestWorkflow, UnwindPausedWorkflow],
  providers: [GuestInboxChannel],
  observers: [UnwindLog],
  budgets: TEST_BUDGETS,
})
export class UnwindPauseApplication {}
