import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { ImportTable } from "../../../src/flow/types/imports.js";
import { ClassLocator } from "../../../src/flow/types/locate.js";
import { tablesOf, type AnalysedWorkflow } from "../../../src/flow/types/tables.js";
import { UndoPathWorkflow, UndoWorkflow } from "../runtime/fixtures/undo.workflow.js";

/**
 * #340 — an undo action no path reaches (a failed join's, run by the framework) is still typed:
 * `InputOf<X>` from its declared fields, `OutputOf<X>` from its output; on a path it keeps the
 * path's own entry.
 */

const analysed = (workflow: abstract new () => unknown): AnalysedWorkflow => {
  const { analysis } = checkWorkflow(workflow);
  if (analysis === undefined) throw new Error("the fixture does not check");
  return { analysis, errors: [] };
};

const names = (): ImportTable =>
  new ImportTable(new ClassLocator([]), "/project/.agboss/types.d.ts");

describe("#340: off-path undo actions in the generated tables", () => {
  it("an undo only the framework runs gets its declared fields", () => {
    const tables = tablesOf([analysed(UndoWorkflow)], names());

    expect(tables.inputs.get("release-room-action")).toBe("{ room: Produced<RoomDto, unknown> }");
    expect(tables.outputs.get("release-room-action")).toBe("NoOutput");
  });

  it("an undo a path reaches keeps the path's entry", () => {
    const tables = tablesOf([analysed(UndoWorkflow), analysed(UndoPathWorkflow)], names());

    expect(tables.inputs.get("release-room-action")).toBe(
      "{ room: Produced<RoomDto, typeof ReserveRoomAction> }",
    );
  });
});
