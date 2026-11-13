// The files check-packed.mjs adds to the project `agboss create packed-probe` writes (#497).

export const PROJECT = "packed-probe";

/** What `workflowOf` throws when the application is loaded outside vitest's module graph. */
export const OUTSIDE_GRAPH =
  "was loaded outside vitest's module graph; use agbossVitest() from @agboss/core/testing/vitest in vitest.config.ts";

/**
 * AC1: `workflowOf` finds the application next to the workflow and assembles the workflow in it — its
 * own model provider, not the built-in one. The file imports no application and no setup file loads
 * one: `workflowOf` has to load it itself. (AC5, `testWith` and the environments: the project's own
 * workflow test.)
 */
export const WORKFLOW_OF_TEST = `// the assembly itself (#895: workflowOf is in @agboss/core/internal)
import { workflowOf } from "@agboss/core/internal";
import { expect, test } from "vitest";
import { OpenRouterModelProvider } from "../../src/model-providers/openrouter.model-provider.js";
import { PackedProbeWorkflow } from "../../src/workflows/packed-probe/packed-probe.workflow.js";

test("workflowOf assembles the workflow in its application, from the installed package", async () => {
  const assembled = await workflowOf(PackedProbeWorkflow);

  expect(assembled.config.name).toBe("packed-probe-workflow");
  expect(assembled.modelProviders).toContain(OpenRouterModelProvider);
});
`;

export const WORKFLOW_OF_TEST_FILE = "tests/packed/workflow-of.test.ts";

/** AC4: the form before #497 — the matchers registered, AGBoss left external to vitest. */
export const PLAIN_VITEST_CONFIG = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], setupFiles: ["@agboss/core/testing/setup"] },
});
`;

/** #645 AC2: a test that fails inside the core — its stack trace must name lines of the package. */
export const CORE_FAILURE_TEST = `import { usd } from "@agboss/core/units";
import { test } from "vitest";

test("a failure inside the core", () => {
  usd(-1);
});
`;

export const CORE_FAILURE_TEST_FILE = "tests/packed/core-failure.test.ts";

/**
 * #904 item 1: an application whose finish returns `WorkflowFinishFileDto` (from `@agboss/core/a2a`,
 * exported by the package only) passes `agboss check` — the generator knows every built-in DTO's
 * entry, no workaround export needed.
 */
export const FILES_APPLICATION = `import {
  Action,
  Application,
  Budget,
  BudgetPeriod,
  BudgetScope,
  EmptyEnvironment,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  start,
} from "@agboss/core";
import { A2AFileDto, WorkflowFinishFileDto } from "@agboss/core/a2a";
import { Nested } from "@agboss/core/dto";
import { usd } from "@agboss/core/units";

export class DocumentDto {
  @Nested(A2AFileDto, { prompt: "the document" })
  document!: A2AFileDto;
}

@WorkflowStart({ name: "files-workflow-start", description: "A document", input: DocumentDto })
export class FilesWorkflowStart {}

@Action({ name: "files-action", description: "Gives the document back", input: { request: DocumentDto }, output: WorkflowFinishFileDto })
export class FilesAction {
  execute(input: { readonly request: { readonly value: DocumentDto } }): WorkflowFinishFileDto {
    return { file: input.request.value.document };
  }
}

@WorkflowFinish({ name: "files-workflow-finish", description: "The document", output: WorkflowFinishFileDto })
export class FilesWorkflowFinish {}

@Workflow({
  name: "files-workflow",
  version: "1.0.0",
  flow: [
    start(FilesWorkflowStart)
      .returns(DocumentDto)
      .toAction(FilesAction)
      .returns(WorkflowFinishFileDto)
      .toFinish(FilesWorkflowFinish),
  ],
})
export class FilesWorkflow {}

@Budget({ name: "files-application-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
export class FilesApplicationBudget {
  maxSpend() {
    return usd(1);
  }
}

@Budget({ name: "files-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class FilesTenantBudget {
  maxSpend() {
    return usd(1);
  }
}

@Budget({ name: "files-execution-budget", scope: BudgetScope.Execution })
export class FilesExecutionBudget {
  maxSpend() {
    return usd(0.1);
  }
}

@Application({
  name: "files-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FilesWorkflow],
  budgets: [FilesApplicationBudget, FilesTenantBudget, FilesExecutionBudget],
})
export class FilesApplication {}
`;

export const FILES_APPLICATION_FILE = "src/files/files.application.ts";
