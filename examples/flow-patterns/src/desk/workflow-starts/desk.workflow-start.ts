import { WorkflowStart } from "agboss";
import { DeskQuestionDto } from "../dtos/desk-question.dto.js";

/** A customer's question. */
@WorkflowStart({
  name: "desk-workflow-start",
  description: "A customer's question about an order",
  input: DeskQuestionDto,
})
export class DeskWorkflowStart {}
