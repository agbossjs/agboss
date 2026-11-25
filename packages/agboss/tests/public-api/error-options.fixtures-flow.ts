/** #906 AC1, part two: the step, limit, router, mesh and rag errors' options. */
import * as root from "../../src/index.js";
import * as rag from "../../src/rag/index.js";
import { BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import { ComponentKind, bareRecordOf } from "../../src/flow/runtime/records.js";
import { seconds, usd } from "../../src/units/index.js";
import { fx } from "./error-options.fx.js";

const workflow = { name: "refund-workflow", version: "1", startedVersion: "1", configHash: "a" };
const entry = { application: "orders", start: "orders-workflow-start" };
const chain = [{ ...entry, executionId: "root-1" }];
const lost = { path: ["refund-agent"], spentUsd: usd(0.5) };
const paid = { usage: [] };

export const flowFixtures: Readonly<Record<string, object>> = Object.fromEntries([]);
