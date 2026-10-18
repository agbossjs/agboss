/**
 * `agboss/internal` — the framework internals the `agboss` CLI (packages/agboss-cli) is built
 * on (#205): environment and model checks, describe data, golden sets, replay, the template renderer.
 *
 * Not public API: no semver promise, and examples and projects may not import it (the lint allowlist
 * is the public entries only). Its API report (api/agboss-internal.api.md) shows the CLI's
 * contract in review. The CLI depends on the exact same `agboss` version: they ship together.
 */
export { createStartComponents } from "./app/start-components.js";
export { renderTemplate } from "./components/render-template.js";
export { ProfileError } from "./config/profiles.js";
export { describeServices, describeServicesWith } from "./describe/describe-workflow.js";
export {
  describedEnvironmentFor,
  environmentFor,
  selectedEnvironment,
  type EnvironmentOwner,
} from "./environments/load.js";
export {
  environmentVariablesOf,
  resolveEnvironment,
  type DescribedEnvironment,
  type ProcessVariable,
} from "./environments/resolve.js";
export { compareBundleProfiles } from "./eval/compare-profiles.js";
export { formatComparison } from "./eval/compare-report.js";
export { evaluate } from "./eval/eval.js";
export { goldenFile, goldenFromRecent, loadGolden, saveGolden } from "./eval/golden.js";
export { replay } from "./eval/replay.js";
export {
  COST_CATEGORIES,
  type CostLine,
  type CostReport,
  type CostSource,
} from "./finops/usage.js";
export { byClassName, byComponentName, flowLines, pathLines } from "./flow/print.js";
export { inputLines } from "./describe/inputs.js";
export { stepsRangeOf, type StepsRange } from "./flow/analyse/steps.js";
export { executeUnchecked } from "./app/execute-unchecked.js";
export { textStartOfWorkflow } from "./application/compose-app.js";
export {
  defaultSourceOf,
  defaultsLevelsOf,
  DefaultsLevel,
  type DefaultSource,
  type DefaultsLevels,
} from "./config/defaults.js";
export { environmentOwnerOfFile, loadApplicationClass } from "./loader/load-application.js";
export { requestOfTask, textRequestOf, type StartRequest } from "./flow/runtime/start-input.js";
export { GENERATED_TYPES_FILE } from "./flow/types/generate.js";
export {
  FlowTypesStatus,
  writeFlowTypes,
  type FlowTypesResult,
  type FlowTypesWrite,
} from "./flow/types/write.js";
export { checkModelUses } from "./models/check.js";
export { problemLine } from "./models/problems.js";
export { type ProviderFetch } from "./models/resilient-fetch.js";
export { modelUsesOf } from "./models/uses.js";
export { directoryOf, modelSummaryOf } from "./models/workflow-models.js";
export { frameworkPackageJson } from "./package-json.js";
export { type RunStreamEvent } from "./run/types.js";
export { configSnapshot } from "./run/versions.js";
export { shortVersion, versionOf } from "./terns/index.js";
export { isMcpFacade } from "./tools/index.js";
