import type { ContextFields } from "../flow/context/context-values.js";
import type { GivenContextValues } from "../flow/context/runtime-contexts.js";
import type { TenantContext } from "../flow/context/tenant-context.js";
import type { WorkflowIdentity } from "../flow/runtime/step-frame.js";
import type { WorkflowApp } from "./types.js";

/**
 * The workflow each app runs and how it builds the contexts of a call (internal): what a call into the app from
 * outside an execution (a tool over MCP) names.
 */
export interface AppWorkflow {
  readonly workflow: WorkflowIdentity;
  /**
   * The contexts of a call that names its own tenant and execution values (a session's, over MCP):
   * checked against the declared classes, nothing passed → the default tenant.
   */
  readonly contextsOf: (given: GivenContextValues) => {
    readonly tenant: TenantContext;
    readonly execution: ContextFields;
  };
}

const workflows = new WeakMap<WorkflowApp, AppWorkflow>();

export const rememberAppWorkflow = (app: WorkflowApp, workflow: AppWorkflow): void => {
  workflows.set(app, workflow);
};

/** The app's workflow; an app not built by `createApp` (a test double) has none. */
export const appWorkflowOf = (app: WorkflowApp): AppWorkflow | undefined => workflows.get(app);
