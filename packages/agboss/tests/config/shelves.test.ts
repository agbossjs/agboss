/**
 * #1318c: the component shelves of a profile — budgets by name, the model of a router, a guardrail —
 * and what every reader of a budget sees. The declared classes are never changed.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { budgetsOf } from "../../src/application/create-app.js";
import { configJsonSchemaOf } from "../../src/config/config-json-schema.js";
import type { Class } from "../../src/components/injection.js";
import { BudgetScope } from "../../src/index.js";
import { budgetOf } from "../../src/budgets/budget.js";
import { limitsOf as limitsOf2 } from "../../src/budgets/budget-spend.js";
import type { BudgetHandler } from "../../src/budgets/budget.js";
import { budgetsOfExecution } from "../../src/budgets/budget-check.js";
import { standaloneBudgetsOf } from "../../src/application/application-container.js";
import { describedApplicationOf } from "../../src/describe/application.js";
import { ProfileError, ProfileErrorReason } from "../../src/config/profile-error.js";
import { modelGuardrailsOf } from "../../src/guardrails/loaded.js";
import { databaseStorageOf } from "../../src/storage/storage-decorators.js";
import { meshOf } from "../../src/mesh/mesh.decorator.js";
import { hours, minutes, usd } from "../../src/units/index.js";
import { memoryMetaOf } from "../../src/memory/memory.decorator.js";
import {
  ShelfApplication,
  ShelfAttachedBudget,
  ShelfListedBudget,
  ShelfDatabase,
  ShelfMemory,
  ShelfMesh,
  ShelfOtherMemory,
  ShelfSlotBudget,
  ShelfWorkflow,
} from "./fixtures/shelves-app/shelves.application.js";

const assembled = (profile?: string) =>
  applicationOf(ShelfApplication, profile === undefined ? {} : { profile });

const firstOf = (app: Awaited<ReturnType<typeof assembled>>) => {
  const [workflow] = app.workflows;
  if (workflow === undefined) throw new Error("the application has no workflow");
  return workflow;
};

const failure = async (attempt: Promise<unknown>): Promise<ProfileError> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ProfileError) return error;
    throw error;
  }
  throw new Error("expected a ProfileError");
};

const limitsOf = (cls: Parameters<typeof budgetOf>[0]) => {
  const meta = budgetOf(cls);
  return { maxSpend: meta?.maxSpend, maxTokens: meta?.maxTokens };
};

describe("the budgets shelf", () => {
  it("gives a declared budget the profile's limit, every other limit staying as declared", async () => {
    const app = await assembled("tight");
    const byName = new Map(app.budgets.map((cls) => [budgetOf(cls)?.name, limitsOf(cls)]));

    expect(byName.get("shelf-attached-budget")).toEqual({ maxSpend: usd(0.5), maxTokens: 100_000 });
    expect(byName.get("shelf-listed-budget")).toEqual({ maxSpend: undefined, maxTokens: 50 });
  });

  it("never changes the declared class, nor another assembly of it", async () => {
    await assembled("tight");
    const plain = await assembled();

    expect(limitsOf(ShelfAttachedBudget)).toEqual({ maxSpend: usd(5), maxTokens: 100_000 });
    expect(limitsOf(ShelfListedBudget)).toEqual({ maxSpend: undefined, maxTokens: 1_000_000 });
    expect(plain.budgets).toContain(ShelfAttachedBudget);
    expect(plain.budgetOverlays).toBeUndefined();
  });

  it("every path sees the same budget: the listing, the attached ones, the execution's, describe", async () => {
    const app = await assembled("tight");
    const listing = budgetsOf(app);
    const attached = listing.attached?.map((cls) => budgetOf(cls)) ?? [];
    const execution = budgetsOfExecution(listing, ShelfWorkflow);
    const ownBudget = execution.find((one) => one.meta.name === "shelf-attached-budget");

    // the attached budget is the listed one, the same class, once
    expect(
      listing.budgets.filter((cls) => budgetOf(cls)?.name === "shelf-attached-budget"),
    ).toHaveLength(1);
    expect(attached.map((meta) => meta?.maxSpend)).toEqual([usd(0.5)]);
    expect(ownBudget?.meta.maxSpend).toBe(usd(0.5));
    expect(ownBudget?.type).toBe(listing.attached?.[0]);
    expect(execution.find((one) => one.meta.name === "shelf-listed-budget")?.meta.maxTokens).toBe(
      50,
    );
    expect(
      describedApplicationOf(app).executionBudgets.map((one) => [
        one.workflow,
        one.name,
        one.isOwn,
      ]),
    ).toEqual([["shelf-workflow", "shelf-attached-budget", true]]);
  });

  it('a .config.yaml gives limits, a provider by its name and a router through "*", as constants', async () => {
    const app = await assembled("constants");
    const [workflow] = app.workflows;

    expect(app.budgetOverlays?.get("shelf-attached-budget")?.maxSpend).toBe(usd(0.25));
    expect(app.budgetOverlays?.size).toBe(1);
    expect(workflow?.routers[0]).toMatchObject({ model: "other/slow" });
    expect(
      modelGuardrailsOf(workflow?.guardrails).find(
        (one) => one.name === "shelf-injection-guardrail",
      ),
    ).toMatchObject({ model: "other/slow", modelProvider: "shelf-other-models" });
  });

  it("refuses a budget the application does not have, naming it", async () => {
    const error = await failure(assembled("ghost-budget"));

    expect(error.reason).toBe(ProfileErrorReason.Unknown);
    expect(error.message).toMatch(/budgets\.ghost-budget: no such budget/);
    expect(error.message).toContain("shelf-attached-budget");
  });

  it("refuses a budget that reads its limit in code", async () => {
    const error = await failure(assembled("coded-budget"));

    expect(error.reason).toBe(ProfileErrorReason.Invalid);
    expect(error.message).toMatch(/budgets\.test-application-daily-budget: .*limit\(\)/);
  });

  it("refuses an empty limit and a defineEnv-shaped object in YAML", async () => {
    expect((await failure(assembled("no-limit"))).message).toMatch(
      /budgets\.shelf-attached-budget/,
    );
    expect((await failure(assembled("ts-in-yaml"))).message).toMatch(/maxSpend/);
  });
});

describe("the editor schema", () => {
  it("lists the budgets that declare their limits, as numbers", async () => {
    const schema = configJsonSchemaOf(await assembled()) as {
      properties: { budgets: { properties: Record<string, unknown> } };
    };

    expect(Object.keys(schema.properties.budgets.properties).sort()).toEqual([
      "shelf-attached-budget",
      "shelf-listed-budget",
    ]);
  });
});

describe("the component model shelves", () => {
  it("moves a router and a guardrail to the profile's provider and model", async () => {
    const app = await assembled("tight");
    const [workflow] = app.workflows;
    const router = workflow?.routers[0];
    const guardrail = modelGuardrailsOf(workflow?.guardrails).find(
      (one) => one.name === "shelf-injection-guardrail",
    );

    expect(router).toMatchObject({ model: "other/slow", modelProvider: "shelf-other-models" });
    expect(guardrail).toMatchObject({ model: "other/slow", modelProvider: "shelf-other-models" });
  });

  it("leaves them on the application's provider without the profile", async () => {
    const [workflow] = (await assembled()).workflows;

    expect(workflow?.routers[0]).toMatchObject({ model: "base/fast" });
  });

  it("refuses a component no workflow has", async () => {
    const error = await failure(assembled("ghost-judge"));

    expect(error.reason).toBe(ProfileErrorReason.Unknown);
    expect(error.message).toMatch(/judges\.ghost-judge: no such component/);
  });

  it("refuses a router the workflow lacks, naming the workflow", async () => {
    const error = await failure(assembled("ghost-router"));

    expect(error.message).toMatch(/workflows\.shelf-workflow: unknown routers: ghost-router/);
  });

  it("refuses a provider name the workflow cannot reach", async () => {
    const error = await failure(assembled("ghost-provider"));

    expect(error.message).toMatch(/not-a-provider|no such model provider/);
  });
});

describe("a budget on every path", () => {
  const seenOn = (listing: ReturnType<typeof budgetsOf> | undefined) =>
    budgetsOfExecution(
      {
        budgets: listing?.budgets ?? [],
        attached: listing?.attached,
        budgetOverlays: listing?.budgetOverlays,
      },
      ShelfWorkflow,
    ).map((one) => [one.meta.name, one.meta.maxSpend, one.meta.maxTokens]);

  it("a run on its own (eval, replay, compare) counts the limits the profile gives, as the application does", async () => {
    const app = await assembled("tight");
    const standalone = standaloneBudgetsOf(firstOf(app));

    expect(seenOn(standalone)).toEqual(seenOn(budgetsOf(app)));
    expect(seenOn(standalone)).toContainEqual(["shelf-attached-budget", usd(0.5), 100_000]);
    expect(seenOn(standalone)).toContainEqual(["shelf-listed-budget", undefined, 50]);
  });

  it("a run on its own under no profile counts the declared limits", async () => {
    const app = await assembled();

    expect(seenOn(standaloneBudgetsOf(firstOf(app)))).toContainEqual([
      "shelf-attached-budget",
      usd(5),
      100_000,
    ]);
  });
});

describe("the budget class slot of a workflow", () => {
  it("replaces the declared budget on every path: the listing, the attached ones, the execution's, a run on its own, describe", async () => {
    const app = await assembled("slotted");
    const listing = budgetsOf(app);
    const names = (classes: readonly Class[] | undefined) =>
      (classes ?? []).map((cls) => budgetOf(cls)?.name);
    const standalone = standaloneBudgetsOf(firstOf(app));
    const execution = (from: typeof listing | undefined) =>
      budgetsOfExecution(
        {
          budgets: from?.budgets ?? [],
          attached: from?.attached,
          budgetOverlays: from?.budgetOverlays,
        },
        ShelfWorkflow,
      ).find((one) => one.meta.scope === BudgetScope.Execution);

    expect(names(listing.attached)).toEqual(["shelf-slot-budget"]);
    expect(names(listing.budgets)).not.toContain("shelf-attached-budget");
    expect(execution(listing)?.meta).toMatchObject({
      name: "shelf-slot-budget",
      maxSpend: usd(0.1),
    });
    expect(execution(standalone)?.meta).toMatchObject({
      name: "shelf-slot-budget",
      maxSpend: usd(0.1),
    });
    expect(describedApplicationOf(app).executionBudgets).toEqual([
      { workflow: "shelf-workflow", name: "shelf-slot-budget", isOwn: true },
    ]);
    expect(limitsOf(ShelfSlotBudget)).toEqual({ maxSpend: usd(1), maxTokens: undefined });
  });

  it("refuses a class that is no @Budget, naming its path", async () => {
    const error = await failure(assembled("wrong-slot"));

    expect(error.message).toMatch(/workflows\.shelf-workflow\.budget is no @Budget class/);
  });
});

describe("the memories shelf and the memory class slot", () => {
  const seenOf = async (profile?: string) => {
    const workflow = firstOf(await assembled(profile));
    return {
      ttls: (workflow.memories?.memories ?? []).map((memory) => [memory.name, memory.ttl]),
      threadTtl: workflow.memories?.threadTtl,
      readerWindow: workflow.memories?.readers.get("shelf-agent")?.uncompactedTurns,
      defaultWindow: workflow.config.defaults.uncompactedTurns,
      settings: workflow.config.memories,
    };
  };

  it("declared: a day, three turns", async () => {
    expect(await seenOf()).toMatchObject({
      ttls: [["shelf-memory", hours(24)]],
      threadTtl: hours(24),
      readerWindow: 3,
      defaultWindow: 3,
    });
  });

  it("gives every reader of the memory the profile's keep time and window", async () => {
    expect(await seenOf("remember")).toMatchObject({
      ttls: [["shelf-memory", hours(2)]],
      threadTtl: hours(2),
      readerWindow: 1,
      defaultWindow: 1,
    });
  });

  it("never changes the declared class, nor another assembly of it", async () => {
    await assembled("remember");

    expect(memoryMetaOf(ShelfMemory)).toMatchObject({ ttl: hours(24), uncompactedTurns: 3 });
    expect((await seenOf()).threadTtl).toBe(hours(24));
  });

  it("a profile's memory class replaces the workflow's, its own overlay applying", async () => {
    expect(await seenOf("memory-slot")).toMatchObject({
      ttls: [["shelf-other-memory", hours(168)]],
      threadTtl: hours(168),
      readerWindow: 2,
      defaultWindow: 2,
    });
    expect(memoryMetaOf(ShelfOtherMemory)?.uncompactedTurns).toBe(7);
  });

  it("refuses a memory no workflow reads, a class that is no @Memory and a bad value", async () => {
    expect((await failure(assembled("ghost-memory"))).message).toMatch(
      /memories\.ghost-memory: no such memory in use/,
    );
    expect((await failure(assembled("wrong-memory-slot"))).message).toMatch(
      /workflows\.shelf-workflow\.memory is no @Memory class/,
    );
    expect((await failure(assembled("bad-memory"))).message).toMatch(/memories\.shelf-memory\.ttl/);
  });

  it("lists the memories in the editor schema", async () => {
    const schema = configJsonSchemaOf(await assembled()) as {
      properties: { memories: { properties: Record<string, unknown> } };
    };

    expect(Object.keys(schema.properties.memories.properties)).toEqual(["shelf-memory"]);
  });
});

describe("the databaseStorages and mesh shelves", () => {
  it("declared: a day of audit log and ledger entries, ten minutes of mesh answers, five hops", async () => {
    const app = await assembled();

    expect(app.auditLogRetention).toBe(hours(24));
    expect(app.ledgerEntryRetention).toBe(hours(24));
    expect(app.meshAnswerRetention).toBe(minutes(10));
    expect(app.maxMeshHops).toBe(5);
  });

  it("gives every reader the profile's keep times and mesh limits", async () => {
    const app = await assembled("keep");

    expect(app.auditLogRetention).toBe(hours(1));
    expect(app.ledgerEntryRetention).toBe(hours(2));
    expect(app.meshAnswerRetention).toBe(minutes(30));
    expect(app.maxMeshHops).toBe(3);
    expect(app.mesh).toMatchObject({ name: "shelf-mesh", deduplicationTtl: minutes(30) });
  });

  it("never changes the declared classes, nor another assembly of them", async () => {
    await assembled("keep");

    expect(databaseStorageOf(ShelfDatabase)).toMatchObject({ auditLogTtl: hours(24) });
    expect(meshOf(ShelfMesh)).toMatchObject({ deduplicationTtl: minutes(10), maxHops: 5 });
    expect((await assembled()).maxMeshHops).toBe(5);
  });

  it("refuses a storage and a mesh the application does not have", async () => {
    expect((await failure(assembled("ghost-storage"))).message).toMatch(
      /databaseStorages\.ghost-database-storage: no such @DatabaseStorage/,
    );
    expect((await failure(assembled("ghost-mesh"))).message).toMatch(
      /mesh\.ghost-mesh: no such @Mesh/,
    );
  });
});
