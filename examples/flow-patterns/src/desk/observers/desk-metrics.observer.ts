import {
  Injectable,
  nameOf,
  type ExecutionEndEvent,
  type OnExecutionEnd,
  type OnToolEnd,
  type ToolEndEvent,
} from "@agboss/core";
import { DeskWorkflow } from "../desk.workflow.js";
import { DeskMetricsService } from "../services/desk-metrics.service.js";

/**
 * Counts the desk's finished executions and its tool calls (#261: observers are the application's,
 * called for every execution of every workflow — this one filters by the workflow's name).
 */
@Injectable({ deps: [DeskMetricsService] })
export class DeskMetricsObserver implements OnExecutionEnd, OnToolEnd {
  constructor(private readonly deskMetricsService: DeskMetricsService) {}

  onExecutionEnd(event: ExecutionEndEvent): void {
    if (event.workflow.name !== nameOf(DeskWorkflow)) return;
    this.deskMetricsService.increment("desk_answered", { finish: event.finish.name });
  }

  onToolEnd(event: ToolEndEvent): void {
    if (event.workflow.name !== nameOf(DeskWorkflow)) return;
    this.deskMetricsService.increment("desk_tool_call", { tool: event.toolName });
  }
}
