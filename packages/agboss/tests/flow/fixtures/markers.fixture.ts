import { caseOf, start } from "../../../src/flow/builder.js";
import { Text } from "../../../src/dto/index.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { oneOf } from "../../../src/flow/dto-wrappers.js";
import { ShortlistDto } from "./dtos.js";

/**
 * #272 S39 — two DTOs of the same shape: one type to TypeScript without their brands, so a
 * `.switch(…)` with one of them twice would compile; the generated brands tell them apart.
 */

export class ApprovedVerdictDto {
  @Text({ prompt: "a note for the record" })
  note!: string;
}

export class RejectedVerdictDto {
  @Text({ prompt: "a note for the record" })
  note!: string;
}

@WorkflowStart({
  name: "verdict-workflow-start",
  description: "A shortlist to judge",
  input: ShortlistDto,
})
export class VerdictWorkflowStart {}

@Agent({
  name: "verdict-agent",
  description: "Approves or rejects the shortlist",
  prompt: "Judge the shortlist.",
  model: "moonshotai/kimi-k2.6",
  input: {
    shortlist: ShortlistDto,
  },
  output: oneOf(ApprovedVerdictDto, RejectedVerdictDto),
})
export class VerdictAgent {}

@WorkflowFinish({
  name: "approved-workflow-finish",
  description: "The shortlist is approved",
  output: ApprovedVerdictDto,
})
export class ApprovedWorkflowFinish {}

@WorkflowFinish({
  name: "rejected-workflow-finish",
  description: "The shortlist is rejected",
  output: RejectedVerdictDto,
})
export class RejectedWorkflowFinish {}

export const verdictPaths = [
  start(VerdictWorkflowStart)
    .returns(ShortlistDto)
    .toAgent(VerdictAgent)
    .returns(oneOf(ApprovedVerdictDto, RejectedVerdictDto))
    .switch(
      caseOf(ApprovedVerdictDto)
        .toFinish(ApprovedWorkflowFinish),
      caseOf(RejectedVerdictDto)
        .toFinish(RejectedWorkflowFinish),
    ),
] as const;

@Workflow({
  name: "verdict-workflow",
  version: "1.0.0",
  flow: verdictPaths,
})
export class VerdictWorkflow {}
