import { TerminalUserChannel } from "../../../src/channels/terminal-channel.js";
import { Integer, Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Agent,
  ExecutionContext,
  Injectable,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ActionStartEvent,
  type ExecutionEndEvent,
  type ExecutionStartEvent,
  type ModelStartEvent,
  type OnActionStart,
  type OnExecutionEnd,
  type OnExecutionStart,
  type OnModelStart,
  type OnToolStart,
  type ToolHandler,
  type ToolStartEvent,
} from "../../../src/index.js";
import { start } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";

/** What the components and the observer saw of their run, in order (reset with `resetSeen`). */
export const seen = {
  /** The execution id each tool call read (`deps: [ExecutionContext]`). */
  tools: [] as string[],
  /** The start input each execution of the action read from the path scope (#280: not the context). */
  actions: [] as SearchInDto[],
  /** `hook:runId` per observer event. */
  events: [] as string[],
};

export function resetSeen(): void {
  for (const list of Object.values(seen)) list.length = 0;
}

/** A start with more than the text: `limit` must reach the run. */
export class SearchInDto extends WorkflowStartTextDto {
  @Integer({ prompt: "how many jobs at most", min: 1 })
  limit!: number;
}

export class ShortlistDto {
  @Text({ prompt: "the jobs kept" })
  text!: string;
}

export class Query {
  @Text({ prompt: "what to look up" })
  text!: string;
}

/** A read tool: records its run. */
@Tool({
  name: "lookup",
  description: "Looks jobs up",
  input: Query,
  output: Query,
  deps: [ExecutionContext],
})
export class Lookup implements ToolHandler<Query, Query> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run(input: Query): Promise<Query> {
    seen.tools.push(this.executionContext.executionId);
    return Promise.resolve(input);
  }
}

/** A write tool: it waits for an approval, so a run pauses before it. */
@Tool({
  name: "apply",
  description: "Applies for a job",
  channel: TerminalUserChannel,
  input: Query,
  output: Query,
  deps: [ExecutionContext],
})
export class Apply implements ToolHandler<Query, Query> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run(input: Query): Promise<Query> {
    seen.tools.push(this.executionContext.executionId);
    return Promise.resolve(input);
  }
}

@Agent({
  name: "searcher-agent",
  description: "Finds jobs",
  prompt: "Find jobs. Return at most `limit` jobs.",
  tools: [Lookup, Apply],
  model: "test/searcher",
  input: { search: SearchInDto },
  output: ShortlistDto,
})
export class Searcher {}

/** Records the start input it reads from the path scope. */
@Action({
  name: "shortlist-action",
  description: "Keeps the shortlist",
  input: { search: SearchInDto },
})
export class Shortlist {
  execute(input: { readonly search: { readonly value: SearchInDto } }): Promise<void> {
    seen.actions.push(input.search.value);
    return Promise.resolve();
  }
}

/** Every event's run id. */
@Injectable()
export class RunIds
  implements OnExecutionStart, OnExecutionEnd, OnModelStart, OnToolStart, OnActionStart
{
  onExecutionStart(event: ExecutionStartEvent): void {
    seen.events.push(`execution-start:${event.executionId}`);
  }
  onExecutionEnd(event: ExecutionEndEvent): void {
    seen.events.push(`execution-end:${event.executionId}`);
  }
  onModelStart(event: ModelStartEvent): void {
    seen.events.push(`model-start:${event.executionId}`);
  }
  onToolStart(event: ToolStartEvent): void {
    seen.events.push(`tool-start:${event.executionId}`);
  }
  onActionStart(event: ActionStartEvent): void {
    seen.events.push(`action-start:${event.executionId}`);
  }
}

@WorkflowStart({ name: "search-workflow-start", description: "A job search", input: SearchInDto })
export class SearchStart {}

@WorkflowFinish({
  name: "done-workflow-finish",
  description: "The shortlist",
  output: ShortlistDto,
})
export class Done {}

/** search → searcher → shortlist → done, observed. */
@Workflow({
  name: "job-search-workflow",
  version: "1.0.0",
  defaults: {
    models: { maxTokens: 100, temperature: 0 },
    tools: { maxToolCalls: 3 },
  },
  uncompactedTurns: 1,
  providers: [Shortlist],
  flow: [
    start(SearchStart)
      .returns(SearchInDto)
      .toAgent(Searcher)
      .returns(ShortlistDto)
      .toAction(Shortlist)
      .toFinish(Done),
  ],
})
export class JobSearch {}

@Application({
  name: "job-search-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [JobSearch],
  observers: [RunIds],
  budgets: TEST_BUDGETS,
})
export class JobSearchApplication {}

@Agent({
  name: "typo-agent",
  description: "Names an input field in its instructions",
  prompt: "Return at most {{input.limit}} jobs.",
  model: "test/typo",
  input: { search: SearchInDto },
  output: ShortlistDto,
})
export class Typo {}

/** Its agent's instructions name `{{input.limit}}`: instructions are static (#270 Q51). */
@Workflow({
  name: "typo-search-workflow",
  version: "1.0.0",
  defaults: { models: { maxTokens: 100, temperature: 0 } },
  uncompactedTurns: 1,
  flow: [
    start(SearchStart)
      .returns(SearchInDto)
      .toAgent(Typo)
      .returns(ShortlistDto)
      .toFinish(Done),
  ],
})
export class TypoSearch {}
