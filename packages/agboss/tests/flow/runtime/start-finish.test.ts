import { ValidationError } from "../../../src/index.js";
import { describe, expect } from "vitest";
import { ExecutionStatus } from "../../../src/app/types.js";
import { replyWith, testWith } from "../../../src/testing/index.js";
import { CompanyScoreDto } from "../fixtures/data-dtos.js";
import {
  BatchRankAgent,
  CompanyBatchWorkflowStart,
  CompanyCheckAgent,
  CompanyCheckWorkflowStart,
  CompanyScoreWorkflowFinish,
  CompanyCheckApplication,
} from "../fixtures/starts.fixture.js";

const test = testWith(CompanyCheckApplication);

describe("#270 AC20 / AC21: starts with a map of fields or a list, typed by the generated types", () => {
  test("a map start: the fields reach the agent; the finish passes its output through", async ({
    app,
    mockModel,
  }) => {
    mockModel(CompanyCheckAgent).thenReturn(replyWith(CompanyScoreDto, { score: "strong" }));

    const result = await app.execute(CompanyCheckWorkflowStart, {
      company: { name: "Acme" },
      request: { criteria: "TS backend" },
    });

    expect(result.status).toBe(ExecutionStatus.Finished);
    expect(result.finish).toMatchObject({ name: "company-score-workflow-finish" });
    expect(result).toFinishWith(CompanyScoreWorkflowFinish, { score: "strong" });
    expect(result.record).toBeUndefined();
    const { input } = mockModel(CompanyCheckAgent).onlyRequest;
    expect(input).toContain(
      '### company (from company-check-workflow-start)\n{\n  "name": "Acme"\n}',
    );
    expect(input).toContain("### request (from company-check-workflow-start)");
  });

  test("an optional field left out is none in the input message", async ({ app, mockModel }) => {
    mockModel(CompanyCheckAgent).thenReturn(replyWith(CompanyScoreDto, { score: "weak" }));

    await app.execute(CompanyCheckWorkflowStart, { company: { name: "Acme" } });

    expect(mockModel(CompanyCheckAgent).onlyRequest.input).toContain("### request\nnone");
  });

  test("a list start: the list reaches its agent", async ({ app, mockModel }) => {
    mockModel(BatchRankAgent).thenReturn(replyWith(CompanyScoreDto, { score: "Acme first" }));

    const result = await app.execute(CompanyBatchWorkflowStart, [
      { name: "Acme" },
      { name: "Globex" },
    ]);

    expect(result).toFinishWith(CompanyScoreWorkflowFinish, { score: "Acme first" });
    expect(mockModel(BatchRankAgent).onlyRequest.input).toContain('"name": "Globex"');
  });

  test("an invalid start input is refused before the first step, naming the field", async ({
    app,
    mockModel,
  }) => {
    const run = app.execute(CompanyCheckWorkflowStart, { company: {} } as never);

    await expect(run).rejects.toBeInstanceOf(ValidationError.DtoInvalid);
    await expect(run).rejects.toThrow("invalid CompanyDto: name");
    expect(mockModel(CompanyCheckAgent).requests).toHaveLength(0);
  });

  test("#270 AC16: { includeRecord: true } adds the execution record; output stays the business result", async ({
    app,
    mockModel,
  }) => {
    mockModel(CompanyCheckAgent).thenReturn(replyWith(CompanyScoreDto, { score: "strong" }));

    const result = await app.execute(
      CompanyCheckWorkflowStart,
      { company: { name: "Acme" } },
      { includeRecord: true },
    );

    expect(result.output).toEqual({ score: "strong" });
    expect(result.record?.path).toEqual(result.path);
    expect(result.record?.scope.map((value) => value.valueId)).toEqual([
      "company-check-workflow-start:1/CompanyDto",
      "company-check-agent:1/CompanyScoreDto",
    ]);
    expect(result.record?.outdatedValues).toEqual([]);
    expect(result.record?.spend.totalUsd).toBe(result.spend.totalUsd);
  });
});
