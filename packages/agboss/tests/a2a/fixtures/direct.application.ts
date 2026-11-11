// #860 — an application with a direct-reply skill: a quote agent (one read-only tool) that answers
// with a direct A2A `Message`, beside an ordinary task skill (an action). The quote skill is the
// expose's `defaultSkill`. Stores: the in-memory defaults (DirectApplication), the SQLite files of
// the instances' environment (SqliteDirectApplication, two instances).
import { A2AExpose, A2AReply } from "../../../src/a2a/a2a-expose.decorator.js";
import { WorkflowFinishFileDto } from "../../../src/a2a/files/a2a-file.dto.js";
import { A2AFiles } from "../../../src/a2a/files/a2a-files.service.js";
import { Application } from "../../../src/application/application.js";
import { Tool, type ToolHandler } from "../../../src/components/decorators.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { EmptyEnvironment, type Produced } from "../../../src/index.js";
import { InMemoryA2AFileRepository } from "../../../src/infrastructure/in-memory-a2a-file.repository.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { BearerCallerResolver } from "./bearer-caller-resolver.js";

export class SkuDto {
  @Text({ prompt: "the product" })
  sku!: string;
}

export class PriceDto {
  @Text({ prompt: "its price" })
  price!: string;
}

/** Reads a price: changes nothing. */
@Tool({
  name: "price-lookup-tool",
  description: "The price of a product",
  input: SkuDto,
  output: PriceDto,
  readOnly: true,
})
export class PriceLookupTool implements ToolHandler<SkuDto, PriceDto> {
  run(input: SkuDto): Promise<PriceDto> {
    return Promise.resolve({ price: `${input.sku}: 12.50 EUR` });
  }
}

@Agent({
  name: "quote-agent",
  description: "Answers a price question",
  prompt: "Answer the price question; look prices up.",
  model: "moonshotai/kimi-k2.6",
  tools: [PriceLookupTool],
})
export class QuoteAgent {}

@WorkflowStart({
  name: "quote-workflow-start",
  description: "A price question",
  input: WorkflowStartTextDto,
})
export class QuoteWorkflowStart {}

@WorkflowFinish({
  name: "quote-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class QuoteWorkflowFinish {}

@Workflow({
  name: "quote-workflow",
  version: "1.0.0",
  flow: [
    start(QuoteWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(QuoteAgent)
      .toFinish(QuoteWorkflowFinish),
  ],
})
export class QuoteWorkflow {}

/** A direct reply with a file (#859 in a Message, #860): the quote as a text file. */
@Action({
  name: "quote-file-action",
  description: "Writes the quote as a file",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishFileDto,
  deps: [A2AFiles],
})
export class QuoteFileAction {
  constructor(private readonly a2aFiles: A2AFiles) {}

  async execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<WorkflowFinishFileDto> {
    const bytes = new TextEncoder().encode(`quote for ${input.message.value.text}`);
    return {
      file: await this.a2aFiles.save({ bytes, mediaType: "text/plain", filename: "quote.txt" }),
    };
  }
}

@WorkflowStart({
  name: "quote-file-workflow-start",
  description: "A quote as a file",
  input: WorkflowStartTextDto,
})
export class QuoteFileWorkflowStart {}

@WorkflowFinish({
  name: "quote-file-workflow-finish",
  description: "The file",
  output: WorkflowFinishFileDto,
})
export class QuoteFileWorkflowFinish {}

@Workflow({
  name: "quote-file-workflow",
  version: "1.0.0",
  flow: [
    start(QuoteFileWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(QuoteFileAction)
      .returns(WorkflowFinishFileDto)
      .toFinish(QuoteFileWorkflowFinish),
  ],
})
export class QuoteFileWorkflow {}

/** The task skill beside it: an acknowledgement. */
@Action({
  name: "ack-action",
  description: "Acknowledges the message",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
})
export class AckAction {
  execute(_input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<WorkflowFinishTextDto> {
    return Promise.resolve({ text: "acknowledged" });
  }
}

@WorkflowStart({
  name: "ack-workflow-start",
  description: "A message to acknowledge",
  input: WorkflowStartTextDto,
})
export class AckWorkflowStart {}

@WorkflowFinish({
  name: "ack-workflow-finish",
  description: "The acknowledgement",
  output: WorkflowFinishTextDto,
})
export class AckWorkflowFinish {}

@Workflow({
  name: "ack-workflow",
  version: "1.0.0",
  flow: [
    start(AckWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(AckAction)
      .returns(WorkflowFinishTextDto)
      .toFinish(AckWorkflowFinish),
  ],
})
export class AckWorkflow {}

@A2AExpose({
  name: "quotes-a2a-expose",
  version: "1.0.0",
  description: "Answers price questions at once; acknowledges messages as tasks",
  exports: [QuoteWorkflowStart, QuoteFileWorkflowStart, AckWorkflowStart],
  skills: {
    "quote-workflow-start": { reply: A2AReply.Message },
    "quote-file-workflow-start": { reply: A2AReply.Message },
  },
  defaultSkill: QuoteWorkflowStart,
})
export class QuotesA2AExpose {}

@Application({
  name: "quotes-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [QuoteWorkflow, QuoteFileWorkflow, AckWorkflow],
  providers: [BearerCallerResolver, InMemoryA2AFileRepository],
  exposes: [QuotesA2AExpose],
  budgets: TEST_BUDGETS,
})
export class DirectApplication {}
