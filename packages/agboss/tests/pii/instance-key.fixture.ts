/**
 * #334: an application without `pseudonymKey` — a desk agent whose tools echo the start's author
 * as a `sensitive` field (one approved, one that holds until its execution stops), a child
 * workflow that reads the author again, and a checkpointer that keeps every `piiKey` it saved.
 */
import { TerminalUserChannel } from "../../src/channels/terminal-channel.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  Agent,
  ExecutionContext,
  Injectable,
  PiiAction,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ToolHandler,
} from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { InMemoryCheckpointSaver } from "../../src/infrastructure/contracts.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { start } from "../helpers/flow.js";
import {
  levers,
  MortalExecutionLeaseRepository,
  RecoveryLog,
  StampedExecutionRecordRepository,
} from "../infrastructure/fixtures/recovery.workflow.js";

/** Every `piiKey` a checkpoint of the test held (reset with `resetSavedKeys`). */
export const savedKeys: (string | null)[] = [];

export function resetSavedKeys(): void {
  savedKeys.length = 0;
}

/** The test's checkpoints in memory; the execution's PII key of each one kept. */
@Injectable()
export class PeekCheckpointSaver extends InMemoryCheckpointSaver {
  override put(
    ...args: Parameters<InMemoryCheckpointSaver["put"]>
  ): ReturnType<InMemoryCheckpointSaver["put"]> {
    const [, checkpoint] = args;
    const key: unknown = checkpoint.channel_values.piiKey;
    if (key === null || typeof key === "string") savedKeys.push(key);
    return super.put(...args);
  }
}

export class LookupDto {
  @Text({ prompt: "who to look up" })
  author!: string;
}

/** What a lookup found: the author again, a token for the model. */
export class LookedUpDto {
  @Text({ prompt: "what was found" })
  status!: string;

  @Text({ prompt: "who it is about", sensitive: PiiAction.replaceWithToken() })
  author!: string;
}

const lookedUp = (input: LookupDto): LookedUpDto => ({ status: "found", author: input.author });

/** A lookup that waits for an approval: the execution pauses on the instance that asked. */
@Tool({
  name: "lookup-tool",
  description: "Looks the author up",
  channel: TerminalUserChannel,
  input: LookupDto,
  output: LookedUpDto,
})
export class LookupTool implements ToolHandler<LookupDto, LookedUpDto> {
  run(input: LookupDto): Promise<LookedUpDto> {
    return Promise.resolve(lookedUp(input));
  }
}

/** The first call holds until its execution stops (its instance died); later ones return. */
@Tool({
  name: "slow-lookup-tool",
  description: "Looks the author up, slowly",
  input: LookupDto,
  output: LookedUpDto,
  deps: [ExecutionContext],
})
export class SlowLookupTool implements ToolHandler<LookupDto, LookedUpDto> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run(input: LookupDto): Promise<LookedUpDto> {
    const { signal } = this.executionContext;
    if (levers.holdStarted === undefined) return Promise.resolve(lookedUp(input));
    const started = levers.holdStarted;
    delete levers.holdStarted;
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        resolve(lookedUp(input));
      });
      started();
    });
  }
}

/** What the desk found: the author once more, for the child. */
export class DeskNoteDto {
  @Text({ prompt: "the note" })
  text!: string;

  @Text({ prompt: "who it is about", sensitive: PiiAction.replaceWithToken() })
  author!: string;
}

const price = { inputPerMTok: 1, outputPerMTok: 10 };
const defaults = { models: { temperature: 0 }, tools: { maxToolCalls: 4 } } as const;

@Agent({
  name: "desk-agent",
  description: "Looks the author up",
  prompt: "Look the author up.",
  model: "test/desk",
  price,
  tools: [LookupTool, SlowLookupTool],
  output: DeskNoteDto,
})
export class DeskAgent {}

/** The child's agent: it reads the desk's note, its author a token again. */
@Agent({
  name: "follow-up-agent",
  description: "Follows up",
  prompt: "Follow up.",
  model: "test/follow-up",
  price,
  input: { note: DeskNoteDto },
})
export class FollowUpAgent {}

@WorkflowStart({
  name: "follow-up-workflow-start",
  description: "The desk's note",
  input: DeskNoteDto,
})
export class FollowUpStart {}

@WorkflowFinish({
  name: "follow-up-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
export class FollowUpFinish {}

@Workflow({
  name: "follow-up-workflow",
  version: "1.0.0",
  flow: [start(FollowUpStart).returns(DeskNoteDto).toAgent(FollowUpAgent).toFinish(FollowUpFinish)],
  defaults,
})
export class FollowUpWorkflow {}

@WorkflowStart({
  name: "desk-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class DeskStart {}

@WorkflowFinish({
  name: "desk-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
export class DeskFinish {}

/** The desk, then the child: one root execution, one key for both. */
@Workflow({
  name: "instance-key-workflow",
  version: "1.0.0",
  flow: [
    start(DeskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(DeskAgent)
      .returns(DeskNoteDto)
      .toWorkflow(FollowUpWorkflow)
      .returns(WorkflowFinishTextDto)
      .toFinish(DeskFinish),
  ],
  defaults,
})
export class InstanceKeyWorkflow {}

/** No `pseudonymKey` and no policy that needs one: field tokens on a key of each execution. */
@Application({
  name: "instance-key-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [InstanceKeyWorkflow],
  observers: [RecoveryLog],
  providers: [
    MortalExecutionLeaseRepository,
    StampedExecutionRecordRepository,
    PeekCheckpointSaver,
  ],
  budgets: TEST_BUDGETS,
})
export class InstanceKeyApplication {}
