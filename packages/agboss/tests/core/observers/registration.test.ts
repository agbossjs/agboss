import { beforeEach, describe, expect, vi } from "vitest";
import type { ExecutionOutput } from "../../../src/app/types.js";
import {
  Injectable,
  InjectionToken,
  provide,
  type AgentEndEvent,
  type AgentStartEvent,
  type AppState,
  type OnAgentEnd,
  type OnAgentStart,
  type OnError,
  type OnToolEnd,
  type OnToolStart,
  type OnWorkflowEnd,
  type OnWorkflowStart,
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
import { execute } from "../../helpers/flow.js";
import { ExecutionStatus } from "../../../src/app/types.js";

/** What the observers of this file saw, in order. */
const events: string[] = [];
const toolEvents: (ToolStartEvent | ToolEndEvent)[] = [];
const agentStarts: AgentStartEvent[] = [];
const results: ExecutionOutput[] = [];

beforeEach(() => {
  for (const list of [events, toolEvents, agentStarts, results, auditCalls]) list.length = 0;
});

/** One observer for every start and end hook of the run, keeping the typed payloads. */
@Injectable()
class RunRecorder
  implements
    OnWorkflowStart,
    OnWorkflowEnd,
    OnAgentStart,
    OnAgentEnd,
    OnToolStart,
    OnToolEnd,
    OnError
{
  onWorkflowStart(state: AppState): void {
    events.push(`workflow-start:${state.runId.startsWith("run-") ? "run" : state.runId}`);
  }
  onWorkflowEnd(result: ExecutionOutput): void {
    events.push("workflow-end");
    results.push(result);
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
  onError(error: Error): void {
    events.push(`error:${error.name}`);
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
        "workflow-start:run",
        "agent-start:worker-agent",
        "tool-start:echo",
        'tool-end:echo:{"text":"echo hi"}',
        "agent-end:worker-agent",
        "workflow-end",
      ]);
      expect(toolEvents[0]).toMatchObject({ agentName: "worker-agent", arguments: { text: "hi" } });
      expect(agentStarts[0]).toMatchObject({ name: "worker-agent" });
      expect(results).toEqual([result]);
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
  ),
);

describe("observers with dependencies and failures", () => {
  stamped(
    "gets its deps from the container; a throwing observer does not fail the run",
    async ({ app, mockLlm }) => {
      const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
      mockLlm(Worker).thenReturn(replyWith("done"));

      const result = await execute(app, Start, { text: "hello" });

      expect(result.status).toBe(ExecutionStatus.Finished);
      expect(events).toEqual(["12:00 worker-agent"]);
      expect(warning).toHaveBeenCalledWith("BrokenObserver.onAgentStart threw: observer bug", {
        code: "observer.failed",
      });
      warning.mockRestore();
    },
  );
});
