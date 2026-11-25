import {
  Agent,
  DecidedBy,
  Judge,
  JudgeModel,
  JudgeVerdict,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type JudgeHandler,
  inline,
  Ttl,
} from "../../../src/index.js";
import { ModelProvider, OpenAiCompatibleDriver } from "../../../src/models/index.js";
import { seconds } from "../../../src/units/index.js";
import {
  PlainTextDto,
  WorkflowFinishTextDto,
  WorkflowStartTextDto,
} from "../../../src/dto/index.js";
import { onStart } from "../../helpers/flow.js";
import { TestDecisionsModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * `[judge.same-model-family]` (#396 PR 5, S2 Q9): judges of an agent's own model family, of another
 * vendor, decided by code, and on a model id without a vendor prefix.
 */

const passes = (): Promise<JudgeVerdict> => Promise.resolve(JudgeVerdict.passed());

@Judge({ name: "open-ai-judge", model: "openai/gpt-6", output: PlainTextDto, deps: [JudgeModel] })
export class OpenAiJudge implements JudgeHandler<PlainTextDto> {
  judge = passes;
}

@Judge({
  name: "jev-judge",
  model: "typesafe/jev-1.13",
  modelProvider: TestDecisionsModelProvider,
  output: PlainTextDto,
  deps: [JudgeModel],
})
export class JevJudge implements JudgeHandler<PlainTextDto> {
  judge = passes;
}

@Judge({ name: "length-judge", output: PlainTextDto })
export class LengthJudge implements JudgeHandler<PlainTextDto> {
  judge = passes;
}

@Judge({ name: "bare-judge", model: "mistral-large", output: PlainTextDto, deps: [JudgeModel] })
export class BareJudge implements JudgeHandler<PlainTextDto> {
  judge = passes;
}

@Agent({
  name: "writer-agent",
  prompt: inline("Write."),
  description: "Writes on an OpenAI model",
  model: "openai/gpt-6-mini",
  judges: [OpenAiJudge, JevJudge, LengthJudge, BareJudge],
  executionLimits: { maxRetries: 1 },
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
  historyTtl: Ttl.Forever,
  flow: [onStart(FamilyTaskStart).toAgent(FamilyWriter).toFinish(FamilyReply)],
  defaults: { router: { model: "typesafe/jev-1.13" } },
})
export class JudgeFamilyWorkflow {}

/** A judge whose provider maps the role "fast" to an OpenAI model: the alias is resolved first. */
@ModelProvider({
  name: "alias-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://alias.test/v1" }),
  models: { default: "gpt-6", fast: "gpt-6-mini" },
  timeout: seconds(5),
})
export class AliasProvider {}

@Judge({
  name: "alias-judge",
  model: "fast",
  modelProvider: AliasProvider,
  output: PlainTextDto,
  deps: [JudgeModel],
})
export class AliasJudge implements JudgeHandler<PlainTextDto> {
  judge = passes;
}

/** A judge of a bare `claude-…` id, a writer on a bare `gpt-…` id: two vendors. */
@Judge({ name: "claude-judge", model: "claude-sonnet-5", output: PlainTextDto, deps: [JudgeModel] })
export class ClaudeJudge implements JudgeHandler<PlainTextDto> {
  judge = passes;
}

@Agent({
  name: "alias-writer-agent",
  prompt: inline("Write."),
  description: "Writes on a bare OpenAI model id",
  model: "gpt-6-mini",
  judges: [AliasJudge, ClaudeJudge],
  executionLimits: { maxRetries: 1 },
})
export class AliasWriter {}

/** A judge on a provider and a model, and an agent on another provider that serves the same model. */
@ModelProvider({
  name: "mirror-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://mirror.test/v1" }),
  model: "shared-model",
  timeout: seconds(5),
})
export class MirrorProvider {}

@ModelProvider({
  name: "other-provider",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://other.test/v1" }),
  model: "shared-model",
  timeout: seconds(5),
})
export class OtherProvider {}

@Judge({
  name: "mirror-judge",
  modelProvider: MirrorProvider,
  output: PlainTextDto,
  deps: [JudgeModel],
})
export class MirrorJudge implements JudgeHandler<PlainTextDto> {
  judge = passes;
}

/** No judge retries: the zero-retries warning, and an agent with retries and one without judges. */
@Judge({ name: "plain-judge", output: PlainTextDto })
export class PlainJudge implements JudgeHandler<PlainTextDto> {
  judge = passes;
}

@Agent({
  name: "no-retry-agent",
  prompt: inline("Write."),
  description: "No retries",
  judges: [PlainJudge],
})
export class NoRetryAgent {}

@Agent({
  name: "zero-retry-agent",
  prompt: inline("Write."),
  description: "Zero retries",
  judges: [PlainJudge],
  executionLimits: { maxRetries: 0 },
})
export class ZeroRetryAgent {}

@Agent({
  name: "retry-agent",
  prompt: inline("Write."),
  description: "Retries",
  judges: [PlainJudge],
  executionLimits: { maxRetries: 2 },
})
export class RetryAgent {}

@Agent({ name: "judgeless-agent", prompt: inline("Write."), description: "No judges" })
export class JudgelessAgent {}
