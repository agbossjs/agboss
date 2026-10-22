// `agboss check` fixture (#376 AC2): one workflow with two DTO classes named BookingDto, one here,
// one in hotel.workflow.ts — the names clash ([dto.duplicate-name]) inside one workflow
import {
  Action,
  Application,
  EmptyEnvironment,
  Workflow,
  WorkflowFinish,
} from "../../../../../agboss/src/index.js";
import { Text } from "../../../../../agboss/src/dto/index.js";
import { TEST_BUDGETS } from "../../../../../agboss/tests/flow/fixtures/budgets.js";
import { start } from "../../../../../agboss/tests/flow/fixtures/paths.js";
import { BookingDto as HotelBookingDto, HotelWorkflowStart } from "./hotel.workflow.js";

export class BookingDto {
  @Text({ prompt: "the stay confirmed" })
  confirmation!: string;
}

@Action({
  name: "confirm-action",
  description: "Confirms the stay",
  input: { booking: HotelBookingDto },
  output: BookingDto,
})
export class ConfirmAction {
  execute(input: { readonly booking: { readonly value: HotelBookingDto } }): Promise<BookingDto> {
    return Promise.resolve({ confirmation: input.booking.value.room });
  }
}

@WorkflowFinish({ name: "stay-workflow-finish", description: "Confirmed", output: BookingDto })
export class StayWorkflowFinish {}

@Workflow({
  name: "stay-workflow",
  version: "1.0.0",
  flow: [
    start(HotelWorkflowStart)
      .returns(HotelBookingDto)
      .toAction(ConfirmAction)
      .returns(BookingDto)
      .toFinish(StayWorkflowFinish),
  ],
})
export class StayWorkflow {}

@Application({
  name: "stay-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [StayWorkflow],
  budgets: TEST_BUDGETS,
})
export class StayApplication {}
