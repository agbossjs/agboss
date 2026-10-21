import type { TenantContext } from "../flow/context/tenant-context.js";
import type { WorkflowIdentity } from "../flow/runtime/step-frame.js";
import type { WorkflowApp } from "./types.js";

/**
 * The workflow each app runs and its default tenant (internal): what a call into the app from
 * outside an execution (a tool over MCP) names.
 */
export interface AppWorkflow {
  readonly workflow: WorkflowIdentity;
  /** The tenant `"default"` of the app's application (#261). */
  readonly tenant: TenantContext;
}

const workflows = new WeakMap<WorkflowApp, AppWorkflow>();

export const rememberAppWorkflow = (app: WorkflowApp, workflow: AppWorkflow): void => {
  workflows.set(app, workflow);
};

/** The app's workflow; an app not built by `createApp` (a test double) has none. */
export const appWorkflowOf = (app: WorkflowApp): AppWorkflow | undefined => workflows.get(app);
