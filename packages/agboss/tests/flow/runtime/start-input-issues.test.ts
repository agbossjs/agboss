import { describe, expect, it } from "vitest";
import { startInputIssuesOf } from "../../../src/flow/runtime/start-input-issues.js";
import {
  CompanyBatchWorkflowStart,
  CompanyCheckWorkflowStart,
} from "../fixtures/starts.fixture.js";
import { CompanyDto } from "../fixtures/data-dtos.js";
import { PayStart } from "./fixtures/pay.workflow.js";

/** #268 AC3: every problem of a start's input at once, by field — one DTO, a list, a map. */
describe("#268 AC3: the issues of a start's input", () => {
  it("one DTO: none when it fits, else each field with its reason", () => {
    expect(startInputIssuesOf(PayStart, { id: "7", outcome: "pay" })).toEqual([]);

    const issues = startInputIssuesOf(PayStart, { outcome: "steal" });

    expect(issues.map((issue) => issue.path)).toEqual(["id", "outcome"]);
  });

  it("a listOf(…): each item by its index; not a list is one issue at the root", () => {
    expect(startInputIssuesOf(CompanyBatchWorkflowStart, [{ name: "Acme" }])).toEqual([]);

    expect(
      startInputIssuesOf(CompanyBatchWorkflowStart, [{ name: "Acme" }, {}, { name: 3 }]),
    ).toEqual([
      { path: "[1].name", reason: expect.any(String) as string },
      { path: "[2].name", reason: expect.any(String) as string },
    ]);
    expect(startInputIssuesOf(CompanyBatchWorkflowStart, { name: "Acme" })).toEqual([
      { path: "(root)", reason: "expected a list" },
    ]);
  });

  it("a map of fields: each field by its name, an optional one may be missing", () => {
    expect(startInputIssuesOf(CompanyCheckWorkflowStart, { company: { name: "Acme" } })).toEqual(
      [],
    );

    const issues = startInputIssuesOf(CompanyCheckWorkflowStart, {
      company: {},
      request: { criteria: 5 },
    });

    expect(issues.map((issue) => issue.path)).toEqual(["company.name", "request.criteria"]);
    expect(startInputIssuesOf(CompanyCheckWorkflowStart, ["Acme"])).toEqual([
      { path: "(root)", reason: "expected an object of fields" },
    ]);
  });

  it("a missing required field of a map is that field's issue", () => {
    const issues = startInputIssuesOf(CompanyCheckWorkflowStart, {});

    expect(issues.map((issue) => issue.path)).toEqual(["company"]);
  });

  it("a class that is not a start is a programming error", () => {
    expect(() => startInputIssuesOf(CompanyDto, {})).toThrow(TypeError);
  });
});
