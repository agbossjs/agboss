import {
  Agent,
  Injectable,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type OnDestroy,
  type OnInit,
  type OnStart,
  type OnStop,
  type ToolHandler,
} from "../../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { start } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";

/** What the hooks and the tool did, in order (`Pool.onInit`, `search started`, …). */
export const events: string[] = [];

/** Holds the tool's call until `open()`: an execution still running when the app closes. */
class Gate {
  #open: () => void = () => undefined;
  #entered: () => void = () => undefined;
  closed = Promise.resolve();
  entered = Promise.resolve();

  shut(): void {
    this.closed = new Promise<void>((open) => {
      this.#open = open;
    });
    this.entered = new Promise<void>((entered) => {
      this.#entered = entered;
    });
  }

  arrive(): Promise<void> {
    this.#entered();
    return this.closed;
  }

  open(): void {
    this.#open();
  }
}
export const gate = new Gate();

/** A component with every hook, its log line named after it. */
abstract class Hooked implements OnInit, OnStart, OnStop, OnDestroy {
  onInit(): void {
    events.push(`${this.constructor.name}.onInit`);
  }

  onStart(): void {
    events.push(`${this.constructor.name}.onStart`);
  }

  onStop(): void {
    events.push(`${this.constructor.name}.onStop`);
  }

  onDestroy(): void {
    events.push(`${this.constructor.name}.onDestroy`);
  }
}

/** The dependency: a connection pool. */
@Injectable()
export class ConnectionPoolProvider extends Hooked {}

/** The dependant: an index over the pool. */
@Injectable({ deps: [ConnectionPoolProvider] })
export class JobIndexService extends Hooked {
  constructor(readonly connectionPoolProvider: ConnectionPoolProvider) {
    super();
  }
}

export class JobQueryDto {
  @Text({ prompt: "what to search" })
  text!: string;
}

@Tool({
  name: "search_jobs",
  description: "Searches jobs",
  input: JobQueryDto,
  output: JobQueryDto,
  deps: [JobIndexService],
})
export class SearchJobsTool implements ToolHandler<JobQueryDto, JobQueryDto> {
  constructor(readonly jobIndexService: JobIndexService) {}

  async run(input: JobQueryDto): Promise<JobQueryDto> {
    events.push("search started");
    await gate.arrive();
    events.push("search finished");
    return input;
  }
}

@Agent({
  name: "scout-agent",
  description: "Searches jobs",
  prompt: "Search jobs.",
  model: "stub/scout",
  tools: [SearchJobsTool],
})
export class ScoutAgent {}

@WorkflowStart({
  name: "search-workflow-start",
  description: "A search",
  input: WorkflowStartTextDto,
})
export class SearchWorkflowStart {}

@WorkflowFinish({
  name: "search-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class SearchWorkflowFinish {}

@Workflow({
  name: "lifecycle-workflow",
  version: "1.0.0",
  flow: [
    start(SearchWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ScoutAgent)
      .toFinish(SearchWorkflowFinish),
  ],
  providers: [JobIndexService, ConnectionPoolProvider],
})
export class LifecycleWorkflow {}

@Application({
  name: "lifecycle-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LifecycleWorkflow],
  budgets: TEST_BUDGETS,
})
export class LifecycleApplication {}

/** A pool whose `onInit` fails: the application does not start. */
@Injectable()
export class BrokenPoolProvider implements OnInit {
  onInit(): void {
    throw new Error("no database at start");
  }
}

@Tool({
  name: "broken_search_jobs",
  description: "Searches jobs",
  input: JobQueryDto,
  output: JobQueryDto,
  deps: [BrokenPoolProvider],
})
export class BrokenSearchJobsTool implements ToolHandler<JobQueryDto, JobQueryDto> {
  constructor(readonly brokenPoolProvider: BrokenPoolProvider) {}

  run(input: JobQueryDto): Promise<JobQueryDto> {
    return Promise.resolve(input);
  }
}

@Agent({
  name: "broken-scout-agent",
  description: "Searches jobs",
  prompt: "Search jobs.",
  model: "stub/scout",
  tools: [BrokenSearchJobsTool],
})
export class BrokenScoutAgent {}

@Workflow({
  name: "broken-lifecycle-workflow",
  version: "1.0.0",
  flow: [
    start(SearchWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(BrokenScoutAgent)
      .toFinish(SearchWorkflowFinish),
  ],
  providers: [BrokenPoolProvider],
})
export class BrokenLifecycleWorkflow {}

@Application({
  name: "broken-lifecycle-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BrokenLifecycleWorkflow],
  budgets: TEST_BUDGETS,
})
export class BrokenLifecycleApplication {}
