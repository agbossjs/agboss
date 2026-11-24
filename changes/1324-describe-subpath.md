---
section: Added
issue: 1324
---

**`@agboss/core/describe`: `describeApplication(AppClass, options?)`, `describeWorkflow(AppClass, WorkflowClass, options?)` and `describeApplicationData(AppClass, options?)`** (#1324): they assemble the application themselves (`options` is `{ profile?, processEnv?, source? }`), so no `AssembledApplication` is public; the first two give the text lines, the third the typed JSON projection `{ application: DescribedApplication, workflows: DescribedWorkflow[] }` that `agboss describe --json` prints. The projection types (`DescribedApplication`, `DescribedWorkflow`, `DescribedImplementation`, `DescribedWorkflowTree`, `DescribedStorage`, `DescribedModelProvider`, `DescribedChannel`, `DescribedTool`, `DescribedPiiPolicy`, `DescribedLimits`, `ResolvedModelUse`, `StepsRange`, `WorkflowSnapshot`, `ApplicationContracts`, `A2AExportContract`, `McpExportContract`, `A2AImportContract`, `McpImportContract`, `ContractDto`) are exported with them; `ContractsSnapshot` is now `ApplicationContracts`.
