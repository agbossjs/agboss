import { Agent, Decision, Judge, Workflow, inline, Ttl } from "../../../src/index.js";
import {
  JudgeModel,
  JudgeVerdict,
  type JudgeHandler,
  type JudgeInput,
} from "../../../src/index.js";
import { PlainTextDto } from "../../../src/dto/index.js";
import { ImageDetail } from "../../../src/index.js";
import { onStart } from "../../helpers/flow.js";
import { DEFAULTS, MODEL_PROVIDERS, Reply, TaskStart } from "./judged.workflow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { TestDecisionsModelProvider } from "../../../src/testing/test-model-provider.js";
import { LocalModelProvider, TestDecisionsProvider } from "../../models/providers.fixture.js";

/** The decision model judges run on (OpenRouter Decisions API, images supported). */
export const LUNA = "openai/gpt-6-luna-decisions";

/** A 1×1 png. */
export const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Judges with three typed questions on a decision model: grounded (P(yes)), tone (choice), quality (score). */
@Judge({
  name: "answer-grounded",
  model: LUNA,
  modelProvider: TestDecisionsModelProvider,
  output: PlainTextDto,
  deps: [JudgeModel],
})
export class AnswerGrounded implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ output, task }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const a = await this.judgeModel.decide({
      state: { task, reply: output.text },
      questions: {
        grounded: Decision.boolean("Every fact in the reply appears in the task"),
        tone: Decision.choice("Tone of the reply", {
          neutral: "Plain, factual",
          pushy: "Sells or pressures",
        }),
        quality: Decision.score("Overall usefulness", ["useless", "partial", "complete"]),
      },
    });
    // typed answers: a compile error here if decide's answers lost their types
    const tone: "neutral" | "pushy" = a.tone.choice;
    const quality: number = a.quality.score;
    const grounded: number = a.grounded.probability;
    return grounded > 0.7 && tone === "neutral"
      ? JudgeVerdict.passed({ metrics: { quality, grounded } })
      : JudgeVerdict.failed("Only state facts from the task, neutrally.");
  }
}

/** Looks at an image with the reply: the state is text and image parts. */
@Judge({
  name: "looks-right",
  model: LUNA,
  // the real Decisions wire (a base URL and a key): the wire test reads what goes out
  modelProvider: TestDecisionsProvider,
  output: PlainTextDto,
  deps: [JudgeModel],
})
export class LooksRight implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ output }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const a = await this.judgeModel.decide({
      state: ["Does the chart match the reply?", Decision.image(PNG, ImageDetail.Low), output.text],
      questions: { matches: Decision.boolean("The reply describes the chart") },
    });
    return a.matches.probability >= 0.5
      ? JudgeVerdict.passed()
      : JudgeVerdict.failed("Describe the chart.");
  }
}

@Agent({
  name: "writer-agent",
  prompt: inline("Write."),
  description: "Writes an answer",
  model: "local/llama",
  judges: [AnswerGrounded],
  executionLimits: { maxRetries: 1 },
})
export class Writer {}

@Agent({
  name: "illustrator-agent",
  prompt: inline("Describe the chart."),
  description: "Describes a chart",
  model: "local/llama",
  judges: [LooksRight],
})
export class Illustrator {}

/** One agent gated by a judge on a decision model, one retry. */
@Workflow({
  name: "decision-judged-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TaskStart)
      .toAgent(Writer)
      .toFinish(Reply),
  ],
  defaults: DEFAULTS,
})
export class DecisionDesk {}

@Application({
  name: "decision-judged-desk-application",
  modelProvider: LocalModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DecisionDesk],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class DecisionDeskApplication {}

/** An agent gated by a judge that looks at an image. */
@Workflow({
  name: "image-judged-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TaskStart)
      .toAgent(Illustrator)
      .toFinish(Reply),
  ],
  defaults: DEFAULTS,
})
export class ImageDesk {}

@Application({
  name: "image-judged-desk-application",
  modelProvider: LocalModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ImageDesk],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class ImageDeskApplication {}
