/**
 * #1318c: `workflows.<name>.placement` of a profile — where a child workflow runs — read through the one
 * carrier of the components' options by the runtime graph, the launch registry, the isolated-worker rules
 * and the assembly warnings; a declared `@Workflow({ placement })` is never changed.
 */
import { describe, expect, it } from "vitest";
import { applicationOf, type AssembledApplication } from "../../src/application/assemble.js";
import { assemblyWarningsOf } from "../../src/application/start-log.js";
import { SystemClock } from "../../src/infrastructure/clock.js";
import { ProfileError, ProfileErrorReason } from "../../src/config/profile-error.js";
import { NodeKind } from "../../src/flow/ast.js";
import { ChildPlacement } from "../../src/flow/child-placement.js";
import {
  placementOfWorkflow,
  treeLaunchesQueued,
} from "../../src/flow/analyse/child-placements.js";
import { TreeSlotRegistry } from "../../src/flow/runtime/launch/launch-registry.js";
import { declarationOf } from "../../src/flow/decorators/declaration.js";
import { SharedTreeSlots } from "../../src/flow/runtime/launch/shared-tree-slots.js";
import {
  PlacedChildWorkflow,
  PlacedParentWorkflow,
  PlacementApplication,
} from "./fixtures/placement-app/placement.application.js";

const placed = (profile?: string) =>
  applicationOf(PlacementApplication, profile === undefined ? {} : { profile });

const failure = async (attempt: Promise<unknown>): Promise<ProfileError> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ProfileError) return error;
    throw error;
  }
  throw new Error("expected a ProfileError");
};

/** The placement the parent's runtime graph gives the child node. */
const graphPlacementOf = (app: AssembledApplication): ChildPlacement | undefined =>
  [...(app.workflows[0]?.graph.nodes.values() ?? [])].find((node) => node.placement !== undefined)
    ?.placement;

/** Whether the launch registry keeps the parent tree's slots where every instance counts them. */
const keepsSharedSlots = (app: AssembledApplication): boolean => {
  const registry = new TreeSlotRegistry(undefined, undefined, {
    rateLimits: {} as never,
    clock: { now: () => new Date(0) } as never,
    defaultPlacement: app.childPlacement,
    placements: app.componentOptions.placements,
  });
  const root = {
    executionId: "e-1",
    workflow: { type: PlacedParentWorkflow },
    tenant: { tenantId: "t" },
  };
  return registry.slotsOf(root, 1, new SystemClock()) instanceof SharedTreeSlots;
};

describe("workflows.<name>.placement: one placement on every path", () => {
  it("declared: the child asks for any worker on every path", async () => {
    const app = await placed();

    expect(app.componentOptions.placements.size).toBe(0);
    expect(graphPlacementOf(app)).toBe(ChildPlacement.AnyWorker);
    expect(
      treeLaunchesQueued(PlacedParentWorkflow, undefined, app.componentOptions.placements),
    ).toBe(true);
    expect(keepsSharedSlots(app)).toBe(true);
    expect(assemblyWarningsOf(app).map((one) => one.code)).toContain(
      "application.in-memory-child-queue",
    );
  });

  it("the profile's current-process: the graph, the launch registry and the warnings all drop the queue", async () => {
    const app = await placed("current");

    expect(app.componentOptions.placements.get(PlacedChildWorkflow)).toBe(
      ChildPlacement.CurrentProcess,
    );
    expect(graphPlacementOf(app)).toBeUndefined();
    expect(
      placementOfWorkflow(PlacedChildWorkflow, undefined, app.componentOptions.placements),
    ).toBe(ChildPlacement.CurrentProcess);
    expect(
      treeLaunchesQueued(PlacedParentWorkflow, undefined, app.componentOptions.placements),
    ).toBe(false);
    expect(keepsSharedSlots(app)).toBe(false);
    expect(assemblyWarningsOf(app).map((one) => one.code)).not.toContain(
      "application.in-memory-child-queue",
    );
  });

  it("the profile's other-worker replaces the declared any-worker in the graph and the registry", async () => {
    const app = await placed("other-worker");

    expect(graphPlacementOf(app)).toBe(ChildPlacement.OtherWorker);
    expect(keepsSharedSlots(app)).toBe(true);
  });

  it("an isolated child asks the application for the entry a fork loads: the rule reads the profile", async () => {
    await expect(placed("isolated")).rejects.toThrow(
      /application\.isolated-worker-invalid[\s\S]*RemoteItemWorkflow/u,
    );
  });

  it('"*" places every workflow', async () => {
    const app = await placed("every");

    expect(app.componentOptions.placements.get(PlacedChildWorkflow)).toBe(
      ChildPlacement.OtherWorker,
    );
    expect(graphPlacementOf(app)).toBe(ChildPlacement.OtherWorker);
  });

  it("never changes the declared workflow, nor another assembly of it", async () => {
    await placed("current");
    const plain = await placed();
    const declaration = declarationOf(PlacedChildWorkflow);

    expect(
      declaration?.kind === NodeKind.Workflow ? declaration.options.placement : undefined,
    ).toBe(ChildPlacement.AnyWorker);
    expect(graphPlacementOf(plain)).toBe(ChildPlacement.AnyWorker);
    expect(plain.componentOptions.placements.size).toBe(0);
  });

  it("a placement that is none, or a workflow the application lacks, is refused", async () => {
    expect((await failure(placed("bad-placement"))).reason).toBe(ProfileErrorReason.Invalid);
    expect((await failure(placed("ghost"))).reason).toBe(ProfileErrorReason.Unknown);
  });
});
