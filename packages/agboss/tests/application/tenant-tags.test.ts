/**
 * #261 AC6: a `tenantId` on everything the framework stores and sends — the execution records, the
 * paused executions, the thread, the standard LangGraph fields of a run (`metadata`, `tags`) and
 * the trace exporter's — so one organization's data and traces are found by its id.
 */
import { answerOf } from "../helpers/flow.js";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import {
  ExecutionRecordRepository,
  ExecutionRecordStatus,
} from "../../src/infrastructure/execution-record.repository.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { streamConfig } from "../../src/run/stream-config.js";
import type { AgentExecutionDeps } from "../../src/run/types.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import {
  BedRequestWorkflowStart,
  BedsDto,
  BookBedTool,
  ClinicApplication,
} from "../flow/fixtures/clinic.fixture.js";

const haifa = { tenantId: "haifa-clinic", units: [] };
const levi = { clinician: { clinicianId: "c-12" }, unitId: "icu" };

/** The clinic over scripted models: the bed agent books a bed (a pause), then answers. */
async function clinicApp(): Promise<Awaited<ReturnType<typeof createApp>>> {
  const book = new ScriptBook();
  book
    .scriptOf("agent:bed-agent")
    .thenReturn(callTool(BookBedTool, { ward: "icu" }), replyWith(BedsDto, { text: "booked" }));
  return createApp(ClinicApplication, { processEnv: {}, gateway: createScriptedGateway(book) });
}

describe("#261 AC6: every stored record carries tenantId", () => {
  it("the paused execution and the execution record of a tenant's thread", async () => {
    const app = await clinicApp();

    const paused = await app.execute(
      BedRequestWorkflowStart,
      { text: "book" },
      { tenant: haifa, execution: levi },
    );
    const stored = await app
      .resolve(PausedExecutionRepository)
      .findByTenantIdAndThreadId("haifa-clinic", paused.threadId);
    await app.resume(answerOf(paused, { approved: true }), { tenantId: "haifa-clinic" });
    const records = app.resolve(ExecutionRecordRepository);
    const [record] = await records.findByStatus(ExecutionRecordStatus.Answered, 10);

    expect(stored?.run).toMatchObject({ tenantId: "haifa-clinic", threadId: paused.threadId });
    expect(record).toMatchObject({ tenantId: "haifa-clinic", threadId: paused.threadId });
    expect(await records.hasThread("bed-request-workflow", "haifa-clinic", paused.threadId)).toBe(
      true,
    );
    expect(await records.hasThread("bed-request-workflow", "default", paused.threadId)).toBe(false);
    await app.close();
  });
});

describe("#261 AC6: the standard fields of LangGraph and of the trace exporter carry the tenant", () => {
  it("a run's metadata and tags: tenantId, executionId, rootExecutionId and the workflow", () => {
    const deps = {
      config: { name: "bed-request-workflow", version: "1.0.0" },
    } as AgentExecutionDeps<string>;

    const config = streamConfig(deps, { threadId: "t-1", tenantId: "acme", runId: "run-1" });

    expect(config.metadata).toEqual({
      tenantId: "acme",
      executionId: "run-1",
      rootExecutionId: "run-1",
      threadId: "t-1",
      workflowName: "bed-request-workflow",
      workflowVersion: "1.0.0",
    });
    expect(config.tags).toEqual(["tenant:acme", "bed-request-workflow"]);
  });
});
