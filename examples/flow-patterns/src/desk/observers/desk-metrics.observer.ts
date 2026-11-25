import { Observer, type ExecutionEndEvent, type ToolEndEvent } from "@agboss/core";
import { DeskWorkflow } from "../workflows/desk/desk.workflow.js";
import { DeskMetricsService } from "../services/desk-metrics.service.js";

/**
 * Counts the desk's finished executions and its tool calls (#261): an observer is the
 * application's, and `workflows` narrows its hooks to the desk's events.
 */
@Observer({ workflows: [DeskWorkflow], deps: [DeskMetricsService] })
export class DeskMetricsObserver {
  constructor(private readonly deskMetricsService: DeskMetricsService) {}

  onExecutionEnd(event: ExecutionEndEvent): void {
    this.deskMetricsService.increment("desk_answered", { finish: event.finish.name });
  }

  onToolEnd(event: ToolEndEvent): void {
    this.deskMetricsService.increment("desk_tool_call", { tool: event.tool });
  }
}
