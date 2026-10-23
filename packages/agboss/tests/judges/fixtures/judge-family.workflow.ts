import {
  Agent,
  DecidedBy,
  Judge,
  JudgeVerdict,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type JudgeHandler,
} from "../../../src/index.js";
import {
  PlainTextDto,
  WorkflowFinishTextDto,
  WorkflowStartTextDto,
} from "../../../src/dto/index.js";
import { start } from "../../helpers/flow.js";

/**
 * `[judge.same-model-family]` (#396 PR 5, S2 Q9): judges of an agent's own model family, of another
 * vendor, decided by code, and on a model id without a vendor prefix.
 */

const passes = (): Promise<JudgeVerdict> => Promise.resolve(JudgeVerdict.passed());

@Judge({ name: "open-ai-judge", model: "openai/gpt-6", reply: PlainTextDto })
export class OpenAiJudge implements JudgeHandler<PlainTextDto> {
  judge = passes;
}

@Judge({ name: "jev-judge", model: "typesafe/jev-1.13", reply: PlainTextDto })
export class JevJudge implements JudgeHandler<PlainTextDto> {
  judge = passes;
}

@Judge({ name: "length-judge", decidedBy: DecidedBy.Code, reply: PlainTextDto })
export class LengthJudge implements JudgeHandler<PlainTextDto> {
  judge = passes;
}

@Judge({ name: "bare-judge", model: "gpt-6", reply: PlainTextDto })
export class BareJudge implements JudgeHandler<PlainTextDto> {
  judge = passes;
}

@Agent({
  name: "writer-agent",
  prompt: "Write.",
  description: "Writes on an OpenAI model",
  model: "openai/gpt-6-mini",
  judges: [OpenAiJudge, JevJudge, LengthJudge, BareJudge],
})
export class FamilyWriter {}

@WorkflowStart({ name: "task-workflow-start", description: "A task", input: WorkflowStartTextDto })
export class FamilyTaskStart {}

@WorkflowFinish({
  name: "reply-workflow-finish",
  description: "The reply",
  output: WorkflowFinishTextDto,
})
export class FamilyReply {}

@Workflow({
  name: "judge-family-workflow",
  version: "1.0.0",
  flow: [
    start(FamilyTaskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(FamilyWriter)
      .toFinish(FamilyReply),
  ],
  defaults: { router: { model: "typesafe/jev-1.13" } },
})
export class JudgeFamilyWorkflow {}
