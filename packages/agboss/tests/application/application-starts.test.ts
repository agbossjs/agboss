import { describe, expect, it } from "vitest";
import { startsOfApplication } from "../../src/application/application-starts.js";
import { listOf } from "../../src/flow/dto-wrappers.js";
import { CompanyDto } from "../flow/fixtures/data-dtos.js";
import {
  CompanyBatchWorkflowStart,
  CompanyCheckApplication,
  CompanyCheckWorkflowStart,
} from "../flow/fixtures/starts.fixture.js";
import { ChildrenApplication } from "../flow/runtime/fixtures/children.workflow.js";

/** #268 AC2: the starts the CLI chooses from, read from the decorators only. */
describe("#268 AC2: the starts of an application", () => {
  it("every start of its workflow: name, description, workflow, class and input", () => {
    const starts = startsOfApplication(CompanyCheckApplication);

    expect(starts).toEqual([
      {
        name: "company-batch-workflow-start",
        description: "A batch of companies to check",
        workflow: "company-check-workflow",
        component: CompanyBatchWorkflowStart,
        input: listOf(CompanyDto),
      },
      expect.objectContaining({
        name: "company-check-workflow-start",
        workflow: "company-check-workflow",
        component: CompanyCheckWorkflowStart,
      }),
    ]);
  });

  it("a child workflow's starts too: it runs alone through them (#263)", () => {
    const workflows = new Set(startsOfApplication(ChildrenApplication).map((s) => s.workflow));

    expect(workflows.size).toBeGreaterThan(1);
  });

  it("a class that is not an @Application names the fix", () => {
    expect(() => startsOfApplication(CompanyDto)).toThrow(/@Application/);
  });
});
