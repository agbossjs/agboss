import { Text } from "../../../src/dto/index.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { optional } from "../../../src/flow/dto-wrappers.js";
import { returnsEach, start } from "./paths.js";

/**
 * #272 S4 — the 32-shape threshold of `InputOf`: a start whose map has 5 optional fields brings
 * 2^5 = 32 combinations to its agent (an exact union), one with 6 brings 64 (a flat type and a
 * note). Self-contained — DTOs, components and workflows in one module — so the CLI tests can load
 * it where no import is recorded (TypeScript compiled by Vitest).
 */

export class FirstPartDto {
  @Text({ prompt: "part 1" })
  text!: string;
}
export class SecondPartDto {
  @Text({ prompt: "part 2" })
  text!: string;
}
export class ThirdPartDto {
  @Text({ prompt: "part 3" })
  text!: string;
}
export class FourthPartDto {
  @Text({ prompt: "part 4" })
  text!: string;
}
export class FifthPartDto {
  @Text({ prompt: "part 5" })
  text!: string;
}
export class SixthPartDto {
  @Text({ prompt: "part 6" })
  text!: string;
}
export class SummaryDto {
  @Text({ prompt: "the summary" })
  text!: string;
}

const fiveParts = {
  first: optional(FirstPartDto),
  second: optional(SecondPartDto),
  third: optional(ThirdPartDto),
  fourth: optional(FourthPartDto),
  fifth: optional(FifthPartDto),
};
const sixParts = { ...fiveParts, sixth: optional(SixthPartDto) };

@WorkflowStart({ name: "five-parts-workflow-start", description: "Five parts", input: fiveParts })
export class FivePartsWorkflowStart {}

@WorkflowStart({ name: "six-parts-workflow-start", description: "Six parts", input: sixParts })
export class SixPartsWorkflowStart {}

@Agent({
  name: "five-parts-agent",
  description: "Sums five parts up",
  prompt: "Sum the parts up.",
  model: "moonshotai/kimi-k2.6",
  input: fiveParts,
  output: SummaryDto,
})
export class FivePartsAgent {}

@Agent({
  name: "six-parts-agent",
  description: "Sums six parts up",
  prompt: "Sum the parts up.",
  model: "moonshotai/kimi-k2.6",
  input: sixParts,
  output: SummaryDto,
})
export class SixPartsAgent {}

@WorkflowFinish({ name: "summary-workflow-finish", description: "The summary", output: SummaryDto })
export class SummaryWorkflowFinish {}

const parts = Object.values(sixParts);

@Workflow({
  name: "parts-workflow",
  version: "1.0.0",
  flow: [
    returnsEach(start(FivePartsWorkflowStart), parts.slice(0, 5))
      .toAgent(FivePartsAgent)
      .returns(SummaryDto)
      .toFinish(SummaryWorkflowFinish),
    returnsEach(start(SixPartsWorkflowStart), parts)
      .toAgent(SixPartsAgent)
      .returns(SummaryDto)
      .toFinish(SummaryWorkflowFinish),
  ],
})
export class PartsWorkflow {}
