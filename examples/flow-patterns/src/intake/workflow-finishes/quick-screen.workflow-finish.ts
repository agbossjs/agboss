import { WorkflowFinish } from "agboss";
import { FastScreenDto } from "../dtos/intake.dto.js";

/** Where the quick screen's group finishes: its verdict. */
@WorkflowFinish({
  name: "quick-screen-workflow-finish",
  description: "The quick screen's verdict",
  output: FastScreenDto,
})
export class QuickScreenWorkflowFinish {}
