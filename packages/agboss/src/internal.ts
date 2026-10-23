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
export { workflowSnapshotOf, type WorkflowSnapshot } from "./describe/snapshot.js";
export { contractsOf, type ContractsSnapshot } from "./describe/contracts.js";
export {
  checkFederation,
  FederationProblemCode,
  type BlastRadiusEntry,
  type FederationMember,
  type FederationProblem,
  type FederationReport,
} from "./federation/federation.js";
export { federationMemberOf, type SnapshotReading } from "./federation/federation-snapshot.js";
export {
  describeApplication,
  type ApplicationDescription,
} from "./describe/describe-application.js";
export {
  describedTreeOf,
  type DescribedChild,
  type DescribedLaunch,
  type DescribedTree,
  type DescribedWorkflowNode,
} from "./describe/tree.js";
export {
  ChannelImplementationReason,
  describedChannelsOf,
  type DescribedChannel,
} from "./describe/channels.js";
export {
  describedPiiPoliciesOf,
  type DescribedPiiPolicy,
  type DescribedPiiRule,
} from "./describe/pii-policies.js";
export {
  WorstCaseMeasure,
  worstCaseReportLines,
  worstCaseRowsOf,
  type WorstCaseLimits,
  type WorstCaseRow,
} from "./describe/worst-case-report.js";
export type { WorstCase, WorstCaseChild } from "./flow/analyse/worst-case.js";
export {
  describedEnvironmentFor,
  environmentFor,
  selectedEnvironment,
  type EnvironmentOwner,
} from "./environments/load.js";
export {
  environmentVariablesOf,
  resolveEnvironment,
  SecretResolution,
  type DescribedEnvironment,
  type ProcessVariable,
} from "./environments/resolve.js";
export { compareBundleProfiles } from "./eval/compare-profiles.js";
export { formatComparison } from "./eval/compare-report.js";
export { evaluate } from "./eval/eval.js";
export { checkEvalSuite, evalSuiteWarningsOf } from "./eval/suite/check-suite.js";
export { runEvalSuite, type EvalRunOptions } from "./eval/run/run-suite.js";
export { loadEvalSuites, type FoundEvalSuite } from "./loader/load-eval-suites.js";
export { builtApplicationOf, type BuiltApplication } from "./application/create-app.js";
export {
  openExecutionHistory,
  type OpenedExecutionHistory,
} from "./application/execution-history-store.js";
export {
  EXECUTION_RECORD_KIND,
  exportedRecordLine,
  historyRecordsOf,
  type HistoryExportQuery,
} from "./infrastructure/execution-history-export.js";
export { compareEvalRuns } from "./eval/run/compare-runs.js";
export type { ChaosOptions } from "./eval/chaos/chaos-failure.js";
export { evalRunReportOf, type EvalRunReportRead } from "./eval/run/read-report.js";
export { isJudgeCheckName, TRAJECTORY_CHECK } from "./eval/run/report.js";
export { calibrateJudges, type EvalCalibrationResult } from "./eval/calibrate/calibrate.js";
export {
  evalLabelOf,
  evalLabelsOf,
  labelsWith,
  type EvalLabelRead,
  type EvalLabelsRead,
} from "./eval/calibrate/labels.js";
export {
  failureTaxonomyOf,
  type EvalFailureTag,
  type EvalFailureTaxonomyRead,
} from "./eval/calibrate/taxonomy.js";
export {
  attemptDivergenceOf,
  AttemptDivergenceReason,
  type AttemptDivergence,
} from "./eval/run/divergence.js";
export { goldenFile, goldenFromRecent, loadGolden, saveGolden } from "./eval/golden.js";
export { replay } from "./eval/replay.js";
export {
  COST_CATEGORIES,
  type CostLine,
  type CostReport,
  type CostSource,
} from "./finops/usage.js";
export { byClassName, byComponentName, flowLines, pathLines } from "./flow/print.js";
export { childLines, inputLines } from "./describe/inputs.js";
export {
  applicationWarningsOf,
  describedApplicationOf,
  type DescribedApplication,
  type DescribedBudget,
  type DescribedExecutionBudget,
  type DescribedModelProvider,
} from "./describe/application.js";
export { describedLimitsOf, worstCaseLimitsOf, type DescribedLimits } from "./describe/limits.js";
export { stepsRangeOf, type StepsRange } from "./flow/analyse/steps.js";
export { executeUnchecked } from "./app/execute-unchecked.js";
export { standaloneContexts, type RuntimeContexts } from "./flow/context/runtime-contexts.js";
export {
  defaultSourceOf,
  defaultsLevelsOf,
  DefaultsLevel,
  type DefaultSource,
  type DefaultsLevels,
} from "./config/defaults.js";
export { loadApplicationClass } from "./loader/load-application.js";
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
export { modelUsesOf, type ModelUse } from "./models/uses.js";
export { directoryOf, modelSummaryOf } from "./models/workflow-models.js";
export { applicationModelUsesOf, resolvedModelUsesOf } from "./models/resolution.js";
export { frameworkPackageJson } from "./package-json.js";
export { type ExecutionStreamEvent } from "./run/types.js";
export { childSourcesIn, configSnapshot, type ChildSnapshotSources } from "./run/versions.js";
export { shortVersion, versionOf } from "./terns/index.js";
export { isMcpFacade } from "./tools/index.js";
export { applicationOf, type AssembledApplication } from "./application/assemble.js";
export { environmentOwnerOf } from "./application/create-app.js";
export { startsOfApplication, type ApplicationStart } from "./application/application-starts.js";
export { startInputIssuesOf } from "./flow/runtime/start-input-issues.js";
export { ApplicationLoadError } from "./loader/load-errors.js";
export { studioOf, type StudioGraphs, type StudioOptions } from "./studio.js";
export {
  cassetteFilesUnder,
  checkCassettes,
  type CassetteCheck,
  type StaleCassette,
} from "./testing/vcr-check.js";
