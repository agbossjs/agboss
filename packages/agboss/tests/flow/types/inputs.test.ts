import { describe, expect, it } from "vitest";
import { Text } from "../../../src/dto/index.js";
import type { ResolvedField } from "../../../src/flow/analyse/fields.js";
import { slotOfField } from "../../../src/flow/analyse/scope.js";
import type { ComponentName } from "../../../src/flow/registry.js";
import { ImportTable } from "../../../src/flow/types/imports.js";
import { inputEntry, type NodeInput } from "../../../src/flow/types/inputs.js";
import { ClassLocator } from "../../../src/flow/types/locate.js";

/** The `Inputs` entries that are not a union of shapes (#272 S3, #270). */

class NoteDto {
  @Text({ prompt: "a note" })
  text!: string;
}

const name = "note-agent" as ComponentName;
const field: ResolvedField = {
  name: "note",
  label: "note-agent.note (NoteDto)",
  shape: NoteDto,
  ...slotOfField(NoteDto),
  isPassThrough: false,
};
const names = (): ImportTable =>
  new ImportTable(
    new ClassLocator([{ file: "/project/note.ts", exports: { NoteDto } }]),
    "/project/.agboss/types.d.ts",
  );
const componentOf = (): never => {
  throw new RangeError("no producer is written here");
};
const entry = (input: Partial<NodeInput>): string =>
  inputEntry(
    { name, fields: [field], shapes: [], versionProducers: new Map(), problems: [], ...input },
    names(),
    componentOf,
  ).type;

describe("#270 AC13: Inputs entries", () => {
  it("a node without input fields takes NoInput", () => {
    expect(entry({ fields: [] })).toBe("NoInput");
  });

  it("a node no path reaches says so instead of a type", () => {
    expect(entry({})).toBe(
      '{ readonly __error: "note-agent is reached by no path from a workflow start" }',
    );
  });

  it("a broken data rule is the entry's message (the builder refuses the target with it)", () => {
    expect(entry({ problems: ["[input.missing-on-path] a", "[input.several-on-path] b"] })).toBe(
      '{ readonly __error: "[input.missing-on-path] a; [input.several-on-path] b" }',
    );
  });
});
