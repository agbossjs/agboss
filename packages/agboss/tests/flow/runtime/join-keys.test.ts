/**
 * #268 S92 / S93 — the components' join keys: a DTO enters a hash by its JSON Schema, a component's
 * `schemaHash` by what it reads and writes, its `promptHash` by the text its model is told; the same
 * input gives the same hash, a changed field or prompt another.
 */
import { describe, expect, it } from "vitest";
import { Integer, Text } from "../../../src/dto/index.js";
import { historyOf, listOf, oneOf, optional } from "../../../src/flow/dto-wrappers.js";
import { applicationOf } from "../../../src/application/assemble.js";
import {
  componentRecordsOf,
  describedShapeOf,
  dtoSchemaHashOf,
  schemaHashOfIo,
} from "../../../src/flow/runtime/join-keys.js";
import { ComponentKind } from "../../../src/flow/runtime/records.js";
import { ApplicationsApplication } from "../../app/fixtures/run-events.workflow.js";

class NoteDto {
  @Text({ prompt: "the note" })
  text!: string;
}

class SameNoteDto {
  @Text({ prompt: "the note" })
  text!: string;
}

class CountedNoteDto {
  @Text({ prompt: "the note" })
  text!: string;

  @Integer({ prompt: "how many" })
  count!: number;
}

const HASH = /^[0-9a-f]{64}$/;

describe("#268 S93: a DTO's schemaHash is its JSON Schema's", () => {
  it("is stable, the same for the same fields, another for a field added", () => {
    expect(dtoSchemaHashOf(NoteDto)).toMatch(HASH);
    expect(dtoSchemaHashOf(NoteDto)).toBe(dtoSchemaHashOf(NoteDto));
    expect(dtoSchemaHashOf(SameNoteDto)).toBe(dtoSchemaHashOf(NoteDto));
    expect(dtoSchemaHashOf(CountedNoteDto)).not.toBe(dtoSchemaHashOf(NoteDto));
  });

  it("describes wrappers and field maps by their DTOs", () => {
    const note = { dto: "NoteDto", schemaHash: dtoSchemaHashOf(NoteDto) };
    const counted = { dto: "CountedNoteDto", schemaHash: dtoSchemaHashOf(CountedNoteDto) };

    expect(describedShapeOf(listOf(NoteDto))).toEqual({ listOf: note });
    expect(describedShapeOf(optional(NoteDto))).toEqual({ optional: note });
    expect(describedShapeOf(oneOf(NoteDto, CountedNoteDto))).toEqual({ oneOf: [note, counted] });
    expect(describedShapeOf(historyOf(NoteDto, { limit: 2 }))).toEqual({
      historyOf: note,
      limit: 2,
    });
    expect(describedShapeOf(historyOf(NoteDto))).toEqual({ historyOf: note });
    expect(describedShapeOf({ draft: NoteDto })).toEqual({ fields: { draft: note } });
  });

  it("a component's schemaHash changes with what it reads or writes, none without either", () => {
    const reads = schemaHashOfIo({ input: { draft: NoteDto } });

    expect(reads).toMatch(HASH);
    expect(schemaHashOfIo({ input: { draft: NoteDto } })).toBe(reads);
    expect(schemaHashOfIo({ input: { draft: CountedNoteDto } })).not.toBe(reads);
    expect(schemaHashOfIo({ input: { draft: NoteDto }, output: NoteDto })).not.toBe(reads);
    expect(schemaHashOfIo({})).toBeUndefined();
  });
});

describe("#268 S93: every node's record", () => {
  it("names its kind; a model component has a promptHash, a start and an action none", async () => {
    const [workflow] = (await applicationOf(ApplicationsApplication)).workflows;
    if (workflow === undefined) throw new TypeError("the fixture lists one workflow");

    const records = componentRecordsOf(workflow);

    expect(records.get("clerk-agent")).toEqual({
      name: "clerk-agent",
      kind: ComponentKind.Agent,
      promptHash: expect.stringMatching(HASH),
      schemaHash: expect.stringMatching(HASH),
    });
    expect(records.get("ask-workflow-start")).toMatchObject({
      kind: ComponentKind.WorkflowStart,
      promptHash: undefined,
      schemaHash: expect.stringMatching(HASH),
    });
    expect(records.get("file-action")).toEqual({
      name: "file-action",
      kind: ComponentKind.Action,
      promptHash: undefined,
      schemaHash: undefined,
    });
    const otherPrompt = componentRecordsOf({ ...workflow, prompts: { "clerk-agent": "Other." } });
    expect(otherPrompt.get("clerk-agent")?.promptHash).not.toBe(
      records.get("clerk-agent")?.promptHash,
    );
  });
});
