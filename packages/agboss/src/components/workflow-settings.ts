import { DEFAULT_WORKFLOW_SETTINGS, type WorkflowSettings } from "../graph/settings.js";
import type { Class } from "./injection.js";

const isDefinition = (value: unknown): value is { settings(): WorkflowSettings } =>
  typeof value === "object" &&
  value !== null &&
  "settings" in value &&
  typeof value.settings === "function";

/** The workflow's `settings()` when it has one (`implements WorkflowDefinition`), else the defaults. */
export function settingsOf(workflow: Class): WorkflowSettings {
  // a @Workflow class is constructed with no arguments: it holds declarations only
  const instance: unknown = Reflect.construct(workflow, []);
  return isDefinition(instance) ? instance.settings() : DEFAULT_WORKFLOW_SETTINGS;
}
