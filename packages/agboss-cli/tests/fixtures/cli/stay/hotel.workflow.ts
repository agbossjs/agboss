// `agboss check` fixture (#376 AC2): a start with its own BookingDto — the stay's action answers
// another class of that name
import { WorkflowStart } from "../../../../../agboss/src/flow/decorators/workflow-start.js";
import { Text } from "../../../../../agboss/src/dto/index.js";

// declared next to the start: the check loads the components' files
export class BookingDto {
  @Text({ prompt: "the room booked" })
  room!: string;
}

@WorkflowStart({ name: "hotel-workflow-start", description: "A hotel booking", input: BookingDto })
export class HotelWorkflowStart {}
