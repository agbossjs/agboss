/**
 * #261 PR 2 (S28): the infrastructure an application consumes — `CostLedgerRepository`,
 * `ExecutionRecordRepository`, `PausedExecutionRepository`, `BaseCheckpointSaver` — each with an
 * in-memory default: nothing is written to the home folder, nothing outlives the instance.
 */
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BaseCheckpointSaver } from "@langchain/langgraph";
import { applicationOf } from "../../src/application/assemble.js";
import { buildApplication, createApp } from "../../src/application/create-app.js";
import { CostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { ExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { PausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { UnknownThreadError } from "../../src/run/thread.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { InMemoryExecutionTreeRepository } from "../../src/infrastructure/execution-tree.repository.js";
import { InMemoryRateLimitRepository } from "../../src/infrastructure/rate-limit.repository.js";
import { replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { execute } from "../helpers/flow.js";
import {
  DesksApplication,
  OrdersWorkflowStart,
  RecordingCostLedgerRepository,
} from "./fixtures/desks.application.js";

const home = process.env.HOME;

afterEach(() => {
  process.env.HOME = home;
});

const scripted = (): ScriptBook => {
  const book = new ScriptBook();
  book.scriptOf("agent:orders-agent").thenReturnAlways(replyWith("ok"));
  return book;
};

describe("#261 S28: the built-in infrastructure is in memory", () => {
  it("every contract resolves: the listed ledger, the in-memory defaults for the rest", async () => {
    const { infrastructure, app } = await buildApplication(await applicationOf(DesksApplication), {
      processEnv: {},
      gateway: createScriptedGateway(scripted()),
    });

    expect(infrastructure.costLedger).toBeInstanceOf(RecordingCostLedgerRepository);
    expect(infrastructure.costLedger).toBeInstanceOf(CostLedgerRepository);
    expect(infrastructure.records).toBeInstanceOf(ExecutionRecordRepository);
    expect(infrastructure.pausedExecutions).toBeInstanceOf(PausedExecutionRepository);
    expect(infrastructure.checkpointer).toBeInstanceOf(BaseCheckpointSaver);
    // #265: the shared contracts, in memory too
    expect(infrastructure.executionLeases).toBeInstanceOf(InMemoryExecutionLeaseRepository);
    expect(infrastructure.executionTrees).toBeInstanceOf(InMemoryExecutionTreeRepository);
    expect(infrastructure.rateLimits).toBeInstanceOf(InMemoryRateLimitRepository);
    await app.close();
  });

  it("nothing is written to the home folder: records and spend stay in the instance", async () => {
    const folder = mkdtempSync(join(tmpdir(), "agboss-home-"));
    process.env.HOME = folder;
    const options = { processEnv: { HOME: folder }, gateway: createScriptedGateway(scripted()) };
    const first = await createApp(DesksApplication, options);
    const { threadId: thread } = await execute(first, OrdersWorkflowStart, {
      text: "where is order 7?",
    });
    await first.close();
    const second = await createApp(DesksApplication, options);

    // the second instance has its own records: the first one's thread is unknown to it
    await expect(second.cancel(thread)).rejects.toBeInstanceOf(UnknownThreadError);
    expect(readdirSync(folder)).toEqual([]);
    await second.close();
  });
});
