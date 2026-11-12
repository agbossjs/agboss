// #811 — the conformance application the official A2A TCK (a2aproject/a2a-tck) runs against: a task
// skill, the expose's `defaultSkill` (the TCK names none), whose paths end at a text finish, at a DTO
// finish (a `data` artifact) or at a pause its caller answers (INPUT_REQUIRED); and (#860) a skill
// that answers with a direct `Message` (`A2AReply.Message`, `tck-message-response-*`), which
// `tck-serve.ts` names in the message's metadata. Which path a message takes is the
// TCK's scenario — its in-band signal is the messageId's prefix (`tck-complete-task-<session>`),
// which no workflow sees: `tck-serve.ts` puts it in a header and the caller resolver passes it to
// the execution as a declared context field. Everything past that is AGBoss as an application
// serves it.
import { A2AExpose, A2AReply } from "../../src/a2a/a2a-expose.decorator.js";
import { WorkflowFinishFileDto } from "../../src/a2a/files/a2a-file.dto.js";
import { A2AFiles } from "../../src/a2a/files/a2a-files.service.js";
import {
  A2ACallerResolution,
  type A2ACaller,
  type A2ACallerRequest,
  type A2ACallerResolver,
} from "../../src/a2a/a2a-caller.js";
import { Application } from "../../src/application/application.js";
import { Channel, Injectable } from "../../src/components/decorators.js";
import { ChannelOf, type ChannelAsk } from "../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import {
  ChannelRole,
  PauseAnswerer,
  ReplyInterpretation,
  ReplyInterpreter,
} from "../../src/channels/channel-role.decorator.js";
import type { Class } from "../../src/components/injection.js";
import { AGBossError } from "../../src/core/errors.js";
import { Integer, Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { ExecutionContext } from "../../src/flow/context/execution-context.js";
import { Action } from "../../src/flow/decorators/action.js";
import { DecidedBy } from "../../src/flow/decorators/router.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../src/flow/decorators/workflow-start.js";
import { oneOf, variant, type Variant } from "../../src/flow/dto-wrappers.js";
import { EmptyEnvironment, type Produced } from "../../src/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { caseOf, start } from "../helpers/flow.js";

/** The header the TCK adapter (`tck-serve.ts`) names a message's scenario in. */
export const TCK_SCENARIO_HEADER = "x-agboss-tck-scenario";

/** The one owner of every TCK call: the TCK authenticates nothing. */
export const TCK_OWNER = "tck";

/** What the execution runs for: the TCK scenario its message names. */
export class TckExecutionContext extends ExecutionContext {
  @Text({ optional: true })
  scenario?: string;
}

/** A data answer (`tck-artifact-data`): `{ "key": "value", "count": 42 }`. */
export class TckDataDto {
  @Text()
  key!: string;

  @Integer()
  count!: number;
}

/** What the paused path asks its caller. */
export class TckAskDto {
  @Text({ prompt: "what the task needs from its caller" })
  ask!: string;
}

/** The caller's reply to it. */
export class TckReplyDto {
  @Text({ prompt: "the caller's reply" })
  reply!: string;
}

/** A scenario that rejects its task (`tck-reject-task`): a coded failure. */
export class TckRejectedError extends AGBossError {
  static override readonly code: string = "tck.rejected";
}

/** The text a scenario answers with: the TCK scenarios' own texts (`scenarios/*.feature`). */
const TEXTS: Readonly<Record<string, string>> = {
  "complete-task": "Hello from TCK",
  "artifact-text": "Generated text content",
  "stream-001": "Stream hello from TCK",
  "stream-002": "Stream hello from TCK",
  "stream-003": "Stream task lifecycle",
  "stream-ordering-001": "Ordered output",
  "stream-artifact-text": "Streamed text content",
  "stream-artifact-chunked": "chunk-1 chunk-2",
};

/** The file the file scenarios answer with (`tck-artifact-file`, `-url`, #859). */
const TCK_FILE = { filename: "output.txt", mediaType: "text/plain" } as const;

/** What a scenario answers with. */
type TckAnswer = Variant<
  typeof WorkflowFinishTextDto | typeof TckDataDto | typeof TckAskDto | typeof WorkflowFinishFileDto
>;

/** A scenario's answer: a text, a data value, a file, or a question for its caller. */
@Action({
  name: "tck-scenario-action",
  description: "Answers as the TCK scenario of the message says",
  input: { message: WorkflowStartTextDto },
  output: oneOf(WorkflowFinishTextDto, TckDataDto, TckAskDto, WorkflowFinishFileDto),
  deps: [TckExecutionContext, A2AFiles],
})
export class TckScenarioAction {
  constructor(
    private readonly tckExecutionContext: TckExecutionContext,
    private readonly a2aFiles: A2AFiles,
  ) {}

  async execute(_input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<TckAnswer> {
    const scenario = this.tckExecutionContext.scenario ?? "complete-task";
    if (scenario === "artifact-file") {
      const bytes = new TextEncoder().encode("Generated file content");
      const file = await this.a2aFiles.save({ ...TCK_FILE, bytes });
      return variant(WorkflowFinishFileDto, { file });
    }
    if (scenario === "artifact-file-url") {
      const file = this.a2aFiles.fromUrl("https://example.com/output.txt", TCK_FILE);
      return variant(WorkflowFinishFileDto, { file });
    }
    return this.#answerOf(scenario);
  }

  #answerOf(scenario: string): Promise<TckAnswer> {
    if (scenario === "reject-task") return Promise.reject(new TckRejectedError("rejected"));
    if (scenario === "artifact-data")
      return Promise.resolve(variant(TckDataDto, { key: "value", count: 42 }));
    if (scenario === "input-required")
      return Promise.resolve(variant(TckAskDto, { ask: "the TCK's next message" }));
    const text = TEXTS[scenario] ?? "Hello from TCK";
    return Promise.resolve(variant(WorkflowFinishTextDto, { text }));
  }
}

/** Any reply answers the question: its text. */
@ReplyInterpreter({
  name: "tck-reply-interpreter",
  description: "Takes the caller's reply as it is",
  decidedBy: DecidedBy.Code,
})
export class TckReplyInterpreter {
  interpret(input: { readonly reply: string }): ReplyInterpretation<TckReplyDto> {
    return ReplyInterpretation.understood({ reply: input.reply });
  }
}

@ChannelRole({
  name: "tck-input-question",
  description: "Asks the task's caller for its next message",
  ask: TckAskDto,
  answer: TckReplyDto,
  answerer: PauseAnswerer.ThreadOwner,
  replyInterpreter: TckReplyInterpreter,
})
export abstract class TckInputQuestion extends ChannelOf<TckInputQuestion> {}

/** The caller answers over A2A: the question waits for its follow-up message. */
@Channel({ name: "tck-caller-channel", description: "The task's caller" })
export class TckCallerChannel extends TckInputQuestion {
  send(_ask: ChannelAsk<TckInputQuestion>): Promise<ChannelOutcome<TckInputQuestion>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

/** The answered question completes the task. */
@Action({
  name: "tck-answered-action",
  description: "Completes the task once its caller answered",
  input: { reply: TckReplyDto },
  output: WorkflowFinishTextDto,
})
export class TckAnsweredAction {
  execute(_input: {
    readonly reply: Produced<TckReplyDto, unknown>;
  }): Promise<WorkflowFinishTextDto> {
    return Promise.resolve({ text: "Hello from TCK" });
  }
}

@WorkflowStart({
  name: "tck-workflow-start",
  description: "A message of the A2A TCK",
  input: WorkflowStartTextDto,
})
export class TckWorkflowStart {}

@WorkflowFinish({
  name: "tck-text-workflow-finish",
  description: "A text answer",
  output: WorkflowFinishTextDto,
})
export class TckTextFinish {}

@WorkflowFinish({
  name: "tck-file-workflow-finish",
  description: "A file answer",
  output: WorkflowFinishFileDto,
})
export class TckFileFinish {}

@WorkflowFinish({
  name: "tck-data-workflow-finish",
  description: "A data answer",
  output: TckDataDto,
})
export class TckDataFinish {}

@Workflow({
  name: "tck-workflow",
  version: "1.0.0",
  flow: [
    start(TckWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(TckScenarioAction)
      .returns(oneOf(WorkflowFinishTextDto, TckDataDto, TckAskDto, WorkflowFinishFileDto))
      .switch(
        caseOf(WorkflowFinishTextDto).toFinish(TckTextFinish),
        caseOf(WorkflowFinishFileDto).toFinish(TckFileFinish),
        caseOf(TckDataDto).toFinish(TckDataFinish),
        caseOf(TckAskDto)
          .toQuestion(TckInputQuestion)
          .returns(TckReplyDto)
          .toAction(TckAnsweredAction)
          .returns(WorkflowFinishTextDto)
          .toFinish(TckTextFinish),
      ),
  ],
})
export class TckWorkflow {}

/** Every caller is the TCK; its scenario is the adapter's header. */
@Injectable()
export class TckCallerResolver implements A2ACallerResolver<Class> {
  resolveCaller(request: A2ACallerRequest): A2ACallerResolution<Class> {
    const scenario = request.http.headers[TCK_SCENARIO_HEADER];
    const caller: Record<string, unknown> =
      typeof scenario === "string"
        ? { ownerId: TCK_OWNER, execution: { scenario } }
        : { ownerId: TCK_OWNER };
    // the generated types (check:types) cover the flow fixtures, not this application: its
    // declared context field is checked when the execution starts, like every caller's values
    return A2ACallerResolution.resolved(caller);
  }
}

/** The direct reply of `tck-message-response` (DM-MSG-001): its text, no task. */
@Action({
  name: "tck-message-action",
  description: "Answers with the TCK's direct message",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
})
export class TckMessageAction {
  execute(_input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<WorkflowFinishTextDto> {
    return Promise.resolve({ text: "Direct message response" });
  }
}

@WorkflowStart({
  name: "tck-message-workflow-start",
  description: "A message of the A2A TCK answered with a direct message",
  input: WorkflowStartTextDto,
})
export class TckMessageWorkflowStart {}

@WorkflowFinish({
  name: "tck-message-workflow-finish",
  description: "The direct message",
  output: WorkflowFinishTextDto,
})
export class TckMessageFinish {}

@Workflow({
  name: "tck-message-workflow",
  version: "1.0.0",
  flow: [
    start(TckMessageWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(TckMessageAction)
      .returns(WorkflowFinishTextDto)
      .toFinish(TckMessageFinish),
  ],
})
export class TckMessageWorkflow {}

@A2AExpose({
  name: "tck-a2a-expose",
  version: "1.0.0",
  description: "The AGBoss conformance agent of the A2A TCK",
  exports: [TckWorkflowStart, TckMessageWorkflowStart],
  skills: { "tck-message-workflow-start": { reply: A2AReply.Message } },
  defaultSkill: TckWorkflowStart,
})
export class TckA2AExpose {}

@Application({
  name: "tck-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  executionContext: TckExecutionContext,
  workflows: [TckWorkflow, TckMessageWorkflow],
  providers: [TckCallerChannel, TckCallerResolver],
  exposes: [TckA2AExpose],
  budgets: TEST_BUDGETS,
})
export class TckApplication {}
