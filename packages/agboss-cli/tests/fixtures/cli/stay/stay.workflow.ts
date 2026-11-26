// `agboss check` fixture (#376 AC2): one workflow with two DTO classes named BookingDto, one here,
// one in hotel.workflow.ts — the names clash ([dto.duplicate-name]) inside one workflow
import {
  Action,
  Application,
  Workflow,
  WorkflowFinish,
  Ttl,
} from "../../../../../agboss/src/index.js";
import { Text } from "../../../../../agboss/src/dto/index.js";
import { TEST_BUDGETS } from "../../../../../agboss/tests/flow/fixtures/budgets.js";
import { onStart } from "../../../../../agboss/tests/flow/fixtures/paths.js";
import { BookingDto as HotelBookingDto, HotelWorkflowStart } from "./hotel.workflow.js";
import { TestModelProvider } from "../../../../../agboss/src/testing/test-model-provider.js";

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
  execute(input: { readonly booking: HotelBookingDto }): Promise<BookingDto> {
    return Promise.resolve({ confirmation: input.booking.room });
  }
}

@WorkflowFinish({ name: "stay-workflow-finish", description: "Confirmed", output: BookingDto })
export class StayWorkflowFinish {}

@Workflow({
  name: "stay-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(HotelWorkflowStart)
      .toAction(ConfirmAction)
      .toFinish(StayWorkflowFinish),
  ],
})
export class StayWorkflow {}

@Application({
  modelProvider: TestModelProvider,
  name: "stay-application",
  version: "1.0.0",
  workflows: [StayWorkflow],
  budgets: TEST_BUDGETS,
})
export class StayApplication {}
