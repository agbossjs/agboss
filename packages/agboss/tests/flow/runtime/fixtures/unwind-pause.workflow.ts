import {
  Agent,
  Channel,
  ChannelOf,
  ChannelOutcome,
  ChannelRole,
  EmptyEnvironment,
  PauseAnswerer,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ChannelAsk,
  type Produced,
  type ToolHandler,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { start } from "../../../helpers/flow.js";
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

/**
 * #340 PR 3 — trees that rest paused when they are cancelled: a room reserved, then an agent that
 * asks the guest (the thread's owner) before it answers; once at the root, once in a child under a
 * reserved seat — a cancel withdraws the question and undoes both, the child's from its checkpoint.
 */

@ChannelRole({
  name: "guest-approval-channel",
  description: "The guest approves the reservation",
  approves: UndoRequestDto,
  answeredBy: PauseAnswerer.ThreadOwner,
})
export abstract class GuestApprovalChannel extends ChannelOf<GuestApprovalChannel> {}

@Channel({ name: "guest-inbox-channel", description: "Asks the guest and waits" })
export class GuestInboxChannel extends GuestApprovalChannel {
  send(_ask: ChannelAsk<GuestApprovalChannel>): Promise<ChannelOutcome<GuestApprovalChannel>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Tool({
  name: "ask-guest-tool",
  description: "Asks the guest to approve",
  input: UndoRequestDto,
  output: UndoRequestDto,
  channel: GuestApprovalChannel,
})
export class AskGuestTool implements ToolHandler<UndoRequestDto, UndoRequestDto> {
  run(request: UndoRequestDto): Promise<UndoRequestDto> {
    return Promise.resolve(request);
  }
}

@Agent({
  name: "guest-agent",
  description: "Confirms the room with the guest",
  prompt: "Ask the guest, then say what is reserved.",
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
  flow: [
    start(UnwindGuestWorkflowStart)
      .returns(UndoRequestDto)
      .toAction(ReserveRoomAction)
      .returns(RoomDto)
      .toAgent(GuestAgent)
      .returns(ReservedDto)
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

@WorkflowFinish({
  name: "seat-reserved-workflow-finish",
  description: "The seat and the guest's room",
  input: { seat: SeatDto, reserved: ReservedDto },
  output: ReservedDto,
})
export class SeatReservedWorkflowFinish {
  finish(input: {
    readonly seat: Produced<SeatDto, unknown>;
    readonly reserved: Produced<ReservedDto, unknown>;
  }): ReservedDto {
    return { summary: `${input.seat.value.seatId} + ${input.reserved.value.summary}` };
  }
}

/** A seat, then the child that waits for the guest. */
@Workflow({
  name: "unwind-paused-workflow",
  version: "1.0.0",
  flow: [
    start(UnwindPausedWorkflowStart)
      .returns(UndoRequestDto)
      .toAction(ReserveSeatAction)
      .returns(SeatDto)
      .toWorkflow(UnwindGuestWorkflow)
      .returns(ReservedDto)
      .toFinish(SeatReservedWorkflowFinish),
  ],
  providers: [UndoDesk],
})
export class UnwindPausedWorkflow {}

@Application({
  name: "unwind-pause-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [UnwindGuestWorkflow, UnwindPausedWorkflow],
  providers: [GuestInboxChannel],
  observers: [UnwindLog],
  budgets: TEST_BUDGETS,
})
export class UnwindPauseApplication {}
