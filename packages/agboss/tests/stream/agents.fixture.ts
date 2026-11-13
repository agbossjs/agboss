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
} from "../../src/index.js";
import { PlainTextDto, Text } from "../../src/dto/index.js";

@Judge({ name: "flow-judge", model: "local/judge", reply: PlainTextDto, deps: [JudgeModel] })
export class FlowJudge implements JudgeHandler<PlainTextDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ reply }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const said = await this.judgeModel.invoke(`Is this fine? ${reply.text}`);
    return said.startsWith("PASS") ? JudgeVerdict.passed() : JudgeVerdict.failed({ reason: "no" });
  }
}

export class ShapeDto {
  @Text({ prompt: "the shape" })
  shape!: string;
}

const text = { model: "local/llama", judges: [FlowJudge], maxRetries: 1 } as const;

@Agent({
  name: "editor-agent",
  description: "Edits the shape",
  prompt: "Edit.",
  input: { shape: ShapeDto },
  ...text,
})
export class Editor {}

/** The writer of a child workflow: a text agent with a model judge. */
@Agent({ name: "child-writer-agent", description: "Writes", prompt: "Write.", ...text })
export class ChildWriter {}

/** Answers through an answer tool: it streams no text. */
@Agent({
  name: "shaper-agent",
  description: "Answers with a DTO",
  prompt: "Shape.",
  model: "local/llama",
  output: ShapeDto,
})
export class Shaper {}

export class ColorDto {
  @Text({ prompt: "the color" })
  color!: string;
}

@Judge({ name: "shape-judge", model: "local/judge", reply: ShapeDto, deps: [JudgeModel] })
export class ShapeJudge implements JudgeHandler<ShapeDto> {
  constructor(private readonly judgeModel: JudgeModel) {}

  async judge({ reply }: JudgeInput<ShapeDto>): Promise<JudgeVerdict> {
    const said = await this.judgeModel.invoke(`Is this shape fine? ${reply.shape}`);
    return said.startsWith("PASS") ? JudgeVerdict.passed() : JudgeVerdict.failed({ reason: "no" });
  }
}

/** A branch of the launch: an output DTO with a model judge, so no text of its own. */
@Agent({
  name: "launch-shape-agent",
  description: "A shape",
  prompt: "Shape.",
  model: "local/llama",
  output: ShapeDto,
  judges: [ShapeJudge],
})
export class LaunchShape {}

@Agent({
  name: "launch-color-agent",
  description: "A color",
  prompt: "Color.",
  model: "local/llama",
  output: ColorDto,
})
export class LaunchColor {}

@Agent({
  name: "closer-agent",
  description: "Closes",
  prompt: "Close.",
  model: "local/llama",
  input: { shape: ShapeDto, color: ColorDto },
})
export class Closer {}
