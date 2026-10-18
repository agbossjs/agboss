import {
  Agent,
  Injectable,
  Tool,
  Workflow,
  type ObserverClass,
  type Provider,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import { WorkflowStartTextDto, WorkflowFinishTextDto, Text } from "../../../src/dto/index.js";
import { start } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import type { Class } from "../../../src/components/injection.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";

export class EchoInput {
  @Text() text!: string;
}

/** Every call of `AuditService`, across its instances. */
export const auditCalls: string[] = [];

/** A service with hook-named methods, injected into the tool but never listed as an observer. */
@Injectable()
export class AuditService {
  record(text: string): void {
    auditCalls.push(`record:${text}`);
  }
  onError(error: Error): void {
    auditCalls.push(`onError:${error.message}`);
  }
  onToolEnd(): void {
    auditCalls.push("onToolEnd");
  }
  onExecutionStart(): void {
    auditCalls.push("onExecutionStart");
  }
}

@Tool({
  name: "echo",
  description: "Echoes the text",
  input: EchoInput,
  output: EchoInput,
  deps: [AuditService],
})
export class EchoTool {
  constructor(private readonly audit: AuditService) {}
  run(input: EchoInput): Promise<EchoInput> {
    this.audit.record(input.text);
    return Promise.resolve({ text: `echo ${input.text}` });
  }
}

@Agent({ name: "worker-agent", model: "stub", description: "worker", tools: [EchoTool] })
export class Worker {}

@WorkflowStart({ name: "start-workflow-start", description: "Start", input: WorkflowStartTextDto })
export class Start {}

@WorkflowFinish({
  name: "finish-workflow-finish",
  description: "Finish",
  output: WorkflowFinishTextDto,
})
export class Finish {}

/** A workflow `start → worker (echo tool) → finish` with the given providers. */
export function workflowWith(name: string, providers: readonly Provider[] = []): Class {
  @Workflow({
    name,
    version: "1",
    defaults: {
      models: { temperature: 0, cache: true },
      router: { model: "typesafe/jev-1.13" },
      tools: { maxToolCalls: 2 },
      history: { limit: 1 },
    },
    flow: [
      start(Start)
        .returns(WorkflowStartTextDto)
        .toAgent(Worker)
        .toFinish(Finish),
    ],
    providers: [AuditService, ...providers],
  })
  class ObservedWorkflow {}
  return ObservedWorkflow;
}

/**
 * The application of `workflowWith(…)` with the given observers (`@Application({ observers })`,
 * #261): what the tests build; `infrastructure` goes in its own providers (a `Logger`).
 */
export function applicationWith(
  name: string,
  observers: readonly ObserverClass[],
  providers: readonly Provider[] = [],
  infrastructure: readonly Provider[] = [],
): Class {
  const workflow = workflowWith(name, providers);
  @Application({
    name: name.replace(/-workflow$/, "-application"),
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [workflow],
    budgets: TEST_BUDGETS,
    observers,
    providers: infrastructure,
  })
  class ObservedApplication {}
  return ObservedApplication;
}
