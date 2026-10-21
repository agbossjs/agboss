import { beforeEach, describe, expect } from "vitest";
import {
  Injectable,
  InjectionToken,
  provide,
  type AgentEndEvent,
  type AgentStartEvent,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
  type ExecutionStartEvent,
  type OnAgentEnd,
  type OnAgentStart,
  type OnExecutionError,
  type OnToolEnd,
  type OnToolStart,
  type OnExecutionEnd,
  type OnExecutionStart,
  type ToolEndEvent,
  type ToolStartEvent,
} from "../../../src/index.js";
import {
  callTool,
  failWith,
  ModelFailure,
  replyWith,
  testWith,
} from "../../../src/testing/index.js";
import { auditCalls, EchoTool, Start, Worker, applicationWith } from "./fixture.js";
import { logged, RecordingLogger, resetLogged } from "../../helpers/log.js";
import { execute } from "../../helpers/flow.js";
import { ExecutionStatus } from "../../../src/app/types.js";

/** What the observers of this file saw, in order. */
const events: string[] = [];
const toolEvents: (ToolStartEvent | ToolEndEvent)[] = [];
const agentStarts: AgentStartEvent[] = [];
const results: ExecutionEndEvent[] = [];

beforeEach(() => {
  for (const list of [events, toolEvents, agentStarts, results, auditCalls]) list.length = 0;
});

/** One observer for every start and end hook of the run, keeping the typed payloads. */
@Injectable()
class RunRecorder
  implements
    OnExecutionStart,
    OnExecutionEnd,
    OnAgentStart,
    OnAgentEnd,
    OnToolStart,
    OnToolEnd,
    OnExecutionError
{
  onExecutionStart(event: ExecutionStartEvent): void {
    events.push(`execution-start:${event.executionId}`);
  }
  onExecutionEnd(event: ExecutionEndEvent): void {
    events.push("execution-end");
    results.push(event);
  }
  onAgentStart(event: AgentStartEvent): void {
    events.push(`agent-start:${event.name}`);
    agentStarts.push(event);
  }
  onAgentEnd(event: AgentEndEvent): void {
    events.push(`agent-end:${event.name}`);
  }
  onToolStart(event: ToolStartEvent): void {
    events.push(`tool-start:${event.toolName}`);
    toolEvents.push(event);
  }
  onToolEnd(event: ToolEndEvent): void {
    events.push(`tool-end:${event.toolName}:${event.update}`);
    toolEvents.push(event);
  }
  onExecutionError(event: ExecutionErrorEvent): void {
    events.push(`error:${event.error.name}`);
  }
}

const recorded = testWith(applicationWith("observed-workflow", [RunRecorder]));

describe("a registered observer", () => {
  recorded(
    "receives workflow, agent and tool events with typed payloads",
    async ({ app, mockLlm }) => {
      mockLlm(Worker).thenReturn(callTool(EchoTool, { text: "hi" }), replyWith("done"));

      const result = await execute(app, Start, { text: "hello" });

      expect(events).toEqual([
        "execution-start:execution-1",
        "agent-start:worker-agent",
        "tool-start:echo",
        'tool-end:echo:{"text":"echo hi"}',
        "agent-end:worker-agent",
        "execution-end",
      ]);
      expect(toolEvents[0]).toMatchObject({ agentName: "worker-agent", arguments: { text: "hi" } });
      expect(agentStarts[0]).toMatchObject({ name: "worker-agent" });
      expect(results).toEqual([
        expect.objectContaining({
          executionId: result.runId,
          finish: result.finish,
          spend: result.spend,
        }),
      ]);
    },
  );

  recorded(
    "a service with hook-named methods that is not registered is never called as one",
    async ({ app, mockLlm }) => {
      mockLlm(Worker).thenReturn(callTool(EchoTool, { text: "hi" }), replyWith("done"));
      await execute(app, Start, { text: "hello" });
      mockLlm(Worker).thenReturn(failWith(ModelFailure.ServerError));
      await expect(execute(app, Start, { text: "again" })).rejects.toThrow();

      expect(events).toContain("error:AgentFailedError");
      expect(auditCalls).toEqual(["record:hi"]);
    },
  );
});

const CLOCK = new InjectionToken<() => string>("CLOCK");

/** An observer with a dependency, resolved by the container. */
@Injectable({ deps: [CLOCK] })
class StampedObserver implements OnAgentStart {
  constructor(private readonly now: () => string) {}
  onAgentStart(event: AgentStartEvent): void {
    events.push(`${this.now()} ${event.name}`);
  }
}

/** An observer whose hook throws: reported, skipped, the run goes on. */
@Injectable()
class BrokenObserver implements OnAgentStart {
  onAgentStart(): void {
    throw new Error("observer bug");
  }
}

const stamped = testWith(
  applicationWith(
    "stamped-workflow",
    [BrokenObserver, StampedObserver],
    [provide(CLOCK, () => "12:00")],
    [RecordingLogger],
  ),
);

describe("observers with dependencies and failures", () => {
  stamped(
    "gets its deps from the container; a throwing observer does not fail the run",
    async ({ app, mockLlm }) => {
      resetLogged();
      mockLlm(Worker).thenReturn(replyWith("done"));

      const result = await execute(app, Start, { text: "hello" });

      expect(result.status).toBe(ExecutionStatus.Finished);
      expect(events).toEqual(["12:00 worker-agent"]);
      expect(logged).toEqual([
        expect.objectContaining({
          level: "warn",
          code: "observer.failed",
          message: "BrokenObserver.onAgentStart threw: observer bug",
        }),
      ]);
    },
  );
});
