/**
 * The agents of the streaming tests (#1004, #1006, #1007): text agents with a model judge (an
 * internal model call beside their answer) and agents with an output DTO (no text of their own).
 */
import {
  Agent,
  Judge,
  JudgeModel,
  JudgeVerdict,
  type JudgeHandler,
  type JudgeInput,
  inline,
} from "../../src/index.js";
import { PlainTextDto, Text } from "../../src/dto/index.js";

@Judge({ name: "flow-judge", model: "local/judge", output: PlainTextDto, deps: [JudgeModel] })
export class FlowJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ output }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const said = await this.judgeModel.invoke(`Is this fine? ${output.text}`);
    return said.startsWith("PASS") ? JudgeVerdict.passed() : JudgeVerdict.failed("no");
  }
}

export class ShapeDto {
  @Text({ prompt: "the shape" })
  shape!: string;
}

const text = {
  model: "local/llama",
  judges: [FlowJudge],
  executionLimits: { maxRetries: 1 },
} as const;

@Agent({
  name: "editor-agent",
  description: "Edits the shape",
  prompt: inline("Edit."),
  input: { shape: ShapeDto },
  ...text,
})
export class Editor {}

/** The writer of a child workflow: a text agent with a model judge. */
@Agent({ name: "child-writer-agent", description: "Writes", prompt: inline("Write."), ...text })
export class ChildWriter {}

/** Answers through an answer tool: it streams no text. */
@Agent({
  name: "shaper-agent",
  description: "Answers with a DTO",
  prompt: inline("Shape."),
  model: "local/llama",
  output: ShapeDto,
})
export class Shaper {}

export class ColorDto {
  @Text({ prompt: "the color" })
  color!: string;
}

@Judge({ name: "shape-judge", model: "local/judge", output: ShapeDto, deps: [JudgeModel] })
export class ShapeJudge implements JudgeHandler<ShapeDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ output }: JudgeInput<ShapeDto>): Promise<JudgeVerdict> {
    const said = await this.judgeModel.invoke(`Is this shape fine? ${output.shape}`);
    return said.startsWith("PASS") ? JudgeVerdict.passed() : JudgeVerdict.failed("no");
  }
}

/** A branch of the launch: an output DTO with a model judge, so no text of its own. */
@Agent({
  name: "launch-shape-agent",
  description: "A shape",
  prompt: inline("Shape."),
  model: "local/llama",
  output: ShapeDto,
  judges: [ShapeJudge],
})
export class LaunchShape {}

@Agent({
  name: "launch-color-agent",
  description: "A color",
  prompt: inline("Color."),
  model: "local/llama",
  output: ColorDto,
})
export class LaunchColor {}

@Agent({
  name: "closer-agent",
  description: "Closes",
  prompt: inline("Close."),
  model: "local/llama",
  input: { shape: ShapeDto, color: ColorDto },
})
export class Closer {}
