import { describe, expect, it } from "vitest";
import { Metadata } from "../../../src/flow/metadata.js";
import { readInput, type ScopeView } from "../../../src/flow/runtime/scope.js";
import type { ScopeValueRecord } from "../../../src/flow/runtime/records.js";

/**
 * #1274a: where a value came from is read with the static `Metadata` facade, from a module-private
 * WeakMap — never off the value. The values a node reads are recorded when the scope is read.
 */

class WriterAgent {
  readonly fixture = true;
}
class EditorAgent {
  readonly fixture = true;
}
class NoteDto {
  text = "";
}

const record = (
  producer: string,
  visit: number,
  slot: string,
  value: unknown,
  builtFrom: readonly string[] = [],
): ScopeValueRecord => ({
  valueId: `${producer}:${String(visit)}/${slot}`,
  slot,
  producer,
  value,
  builtFrom,
});

const graph = {
  nodes: new Map([
    ["writer-agent", { component: WriterAgent }],
    ["editor-agent", { component: EditorAgent }],
  ]),
  dtos: new Map(),
} as never;

describe("#1274a: Metadata over a value", () => {
  it("a plain value has none; with() copies it, keeps its prototype and states where it came from", () => {
    const note = Object.assign(new NoteDto(), { text: "a" });

    const tracked = Metadata.with(note, { createdBy: WriterAgent, visitNumber: 2 });

    expect(Metadata.has(note)).toBe(false);
    expect(Metadata.of(note)).toBeUndefined();
    expect(tracked).not.toBe(note);
    expect(tracked).toBeInstanceOf(NoteDto);
    expect(Metadata.has(tracked)).toBe(true);
    expect(Metadata.createdBy(tracked)).toBe(WriterAgent);
    expect(Metadata.of(tracked)).toMatchObject({ visitNumber: 2, slot: "value", parents: [] });
  });

  it("the value carries no property for it: keys, JSON and structuredClone are the data", () => {
    const tracked = Metadata.with({ text: "a" }, { createdBy: WriterAgent });

    expect(Reflect.ownKeys(tracked)).toEqual(["text"]);
    expect(JSON.stringify(tracked)).toBe('{"text":"a"}');
    expect(structuredClone(tracked)).toEqual({ text: "a" });
    expect(Metadata.has(structuredClone(tracked))).toBe(false);
  });

  it("ancestors lists what it was built from, nearest first, each once", () => {
    const first = Metadata.with({ n: 1 }, { createdBy: WriterAgent, valueId: "w:1/a" });
    const second = Metadata.with(
      { n: 2 },
      { createdBy: EditorAgent, valueId: "e:1/b", parents: [first] },
    );
    const third = Metadata.with(
      { n: 3 },
      { createdBy: EditorAgent, valueId: "e:2/b", parents: [second, first] },
    );

    expect(Metadata.ancestors(third).map((each) => each.valueId)).toEqual(["e:1/b", "w:1/a"]);
    expect(Metadata.ancestors({ n: 0 })).toEqual([]);
  });

  it("an array keeps its shape", () => {
    expect(Metadata.with([1, 2], { createdBy: WriterAgent })).toEqual([1, 2]);
  });
});

describe("#1274a: the scope records what a node reads", () => {
  const draft = record("writer-agent", 1, "NoteDto", { text: "draft" });
  const edit = record("editor-agent", 3, "NoteDto", { text: "edit" }, [draft.valueId]);
  const field = (slot: string, name: string, extra = {}) => ({
    name,
    slot,
    isList: false,
    ...extra,
  });

  it("a field's value tells its creator, visit and parents", () => {
    const view: ScopeView = {
      scope: { NoteDto: edit },
      outdatedValues: [
        { ...draft, outdated: { byValueId: edit.valueId, reason: "replaced" } } as never,
      ],
    };

    const { fields } = readInput(graph, { fields: [field("NoteDto", "note")] as never }, view);
    const item = fields.note as object;

    expect(Metadata.createdBy(item)).toBe(EditorAgent);
    expect(Metadata.of(item)).toMatchObject({ valueId: edit.valueId, visitNumber: 3 });
    expect(Metadata.ancestors(item).map((each) => each.createdBy)).toEqual([WriterAgent]);
    expect(item).toEqual({ text: "edit" });
  });

  it("a list's elements know their place and their own producer", () => {
    const list = {
      ...record("writer-agent", 1, "list:NoteDto", [{ text: "a" }, { text: "b" }]),
      elementProducers: ["writer-agent", "editor-agent"],
    };
    const view: ScopeView = { scope: { "list:NoteDto": list }, outdatedValues: [] };

    const { fields } = readInput(
      graph,
      { fields: [field("list:NoteDto", "notes", { isList: true })] as never },
      view,
    );
    const items = fields.notes as object[];

    expect(items.map((each) => Metadata.of(each)?.itemIndex)).toEqual([0, 1]);
    expect(items.map((each) => Metadata.createdBy(each))).toEqual([WriterAgent, EditorAgent]);
  });

  it("one object in two slots is never given two sets of facts", () => {
    const shared = { text: "same" };
    const a = record("writer-agent", 1, "A", shared);
    const b = record("editor-agent", 1, "B", shared);
    const view: ScopeView = { scope: { A: a, B: b }, outdatedValues: [] };

    const { fields } = readInput(
      graph,
      { fields: [field("A", "a"), field("B", "b")] as never },
      view,
    );
    const [first, second] = [fields.a, fields.b] as object[];

    expect(Metadata.createdBy(first ?? {})).toBe(WriterAgent);
    expect(Metadata.createdBy(second ?? {})).toBe(EditorAgent);
    expect(second).toEqual(shared);
  });
});
