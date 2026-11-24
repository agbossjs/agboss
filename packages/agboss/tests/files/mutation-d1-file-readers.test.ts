/**
 * #1269 (mutation shard files-pii): the models that read an agent's files besides its own — which
 * agents answer with files, what a guardrail's or a judge's reader needs (each need once, strict when
 * any agent sets its types) and which agents give it files.
 */
import { describe, expect, it } from "vitest";
import { FileDto } from "../../src/dto/standard/file.js";
import { GuardrailSide } from "../../src/components/policy-decorators.js";
import type { AgentsConfigOf } from "../../src/config/types.js";
import { Nested, Text } from "../../src/dto/index.js";
import {
  answersWithFiles,
  guardrailReadersOf,
  judgeReadersOf,
} from "../../src/files/file-readers.js";
import { resolvedFilesOf, type ResolvedModelFiles } from "../../src/files/file-settings.js";
import { FileSource, FileView, ModelFiles } from "../../src/files/model-files.js";
import { NodeKind } from "../../src/flow/ast.js";
import { oneOf } from "../../src/flow/dto-wrappers.js";
import type { RuntimeGraph } from "../../src/flow/runtime/graph-model.js";
import type { ElementGuardrails } from "../../src/guardrails/assembly.js";
import type { LoadedGuardrail } from "../../src/guardrails/loaded.js";
import { DecidedBy } from "../../src/flow/decorators/router.js";

class ScanDto {
  @Nested(FileDto, { prompt: "the scan" })
  scan!: FileDto;
}

class NoteDto {
  @Text({ prompt: "a note" })
  note!: string;
}

type Graph = Pick<RuntimeGraph, "nodes">;

/** A graph of one declared node: what `answersWithFiles` reads of it. */
const graphOf = (name: string, declaration: object): Graph => ({
  nodes: new Map([[name, { declaration }]]) as never,
});

const agentWith = (output: unknown): object => ({ kind: NodeKind.Agent, options: { output } });

describe("answersWithFiles", () => {
  it("an agent whose output is a file DTO, a list of them or a variant with one, answers with files", () => {
    expect(answersWithFiles(graphOf("a", agentWith(ScanDto)), "a")).toBe(true);
    expect(answersWithFiles(graphOf("a", agentWith(oneOf(NoteDto, ScanDto))), "a")).toBe(true);
    expect(answersWithFiles(graphOf("a", agentWith(oneOf(ScanDto, NoteDto))), "a")).toBe(true);
  });

  it("an agent with no output, a text output or a node of another kind does not", () => {
    expect(answersWithFiles(graphOf("a", agentWith(undefined)), "a")).toBe(false);
    expect(answersWithFiles(graphOf("a", agentWith(NoteDto)), "a")).toBe(false);
    expect(answersWithFiles(graphOf("a", agentWith(oneOf(NoteDto, NoteDto))), "a")).toBe(false);
    expect(answersWithFiles(graphOf("a", { kind: NodeKind.Action, options: {} }), "a")).toBe(false);
    expect(answersWithFiles(graphOf("a", agentWith(ScanDto)), "other")).toBe(false);
  });
});

const filesOf = (options: Parameters<typeof ModelFiles.of>[0]): ResolvedModelFiles =>
  resolvedFilesOf({
    agent: ModelFiles.of(options).options,
    defaults: undefined,
    skills: [],
    a2aFiles: undefined,
    hasPiiPolicy: false,
  });

const configOf = (
  agents: Readonly<Record<string, { files?: ResolvedModelFiles; judges?: string[] }>>,
): AgentsConfigOf<string> => ({
  name: "w",
  version: "1",
  defaults: { models: { temperature: 0, maxTokens: 100 }, uncompactedTurns: 1 },
  agents: Object.fromEntries(
    Object.entries(agents).map(([name, settings]) => [
      name,
      { model: "m/x", description: "d", ...settings },
    ]),
  ),
});

class Checker {
  check(): boolean {
    return true;
  }
}
const guardrailOf = (name: string): LoadedGuardrail => ({
  type: Checker,
  name,
  description: "d",
  side: GuardrailSide.Input,
  decidedBy: DecidedBy.Code,
});

const guards = (input: string[], output: string[] = []): ElementGuardrails => ({
  input: input.map(guardrailOf),
  output: output.map(guardrailOf),
});

const EMPTY: Graph = { nodes: new Map() };
const IMAGES = filesOf({
  allowedMediaTypes: ["image/png", "application/pdf"],
  views: [FileView.Original, FileView.Transcription],
});
const IMAGES_NEEDS = [
  { kind: "image", mediaType: "image/png", view: FileView.Original },
  { kind: "file", mediaType: "application/pdf", view: FileView.Original },
  { kind: "text", mediaType: "image/png", view: FileView.Transcription },
];

describe("guardrailReadersOf", () => {
  it("a guardrail reads what the agent it guards reads, as a list of needs and the agents", () => {
    const config = configOf({ reader: { files: IMAGES } });

    const readers = guardrailReadersOf(config, new Map([["reader", guards(["g"])]]), EMPTY);

    expect(readers.get("g")).toEqual({
      needs: IMAGES_NEEDS,
      isNeedStrict: true,
      agents: ["reader"],
    });
  });

  it("one guardrail on several agents reads each kind once, over every agent, in order", () => {
    const config = configOf({ one: { files: IMAGES }, two: { files: IMAGES } });
    const byElement = new Map([
      ["one", guards(["g"])],
      ["two", guards(["g"])],
    ]);

    const reader = guardrailReadersOf(config, byElement, EMPTY).get("g");

    expect(reader?.needs).toEqual(IMAGES_NEEDS);
    expect(reader?.agents).toEqual(["one", "two"]);
  });

  it("agents with other needs add theirs: a need is one by its kind, type and view", () => {
    const text = filesOf({ allowedMediaTypes: ["text/plain"], views: [FileView.Original] });
    const config = configOf({ one: { files: IMAGES }, two: { files: text } });
    const byElement = new Map([
      ["one", guards(["g"])],
      ["two", guards(["g"])],
    ]);

    const reader = guardrailReadersOf(config, byElement, EMPTY).get("g");

    expect(reader?.needs).toEqual([
      ...IMAGES_NEEDS,
      { kind: "text", mediaType: "text/plain", view: FileView.Original },
    ]);
  });

  it("the reader is strict when any of its agents set its types, not only when all did", () => {
    const defaulted = filesOf({ views: [FileView.Original] });
    const config = configOf({ explicit: { files: IMAGES }, loose: { files: defaulted } });
    const byElement = new Map([
      ["loose", guards(["g"])],
      ["explicit", guards(["g"])],
    ]);

    expect(guardrailReadersOf(config, byElement, EMPTY).get("g")?.isNeedStrict).toBe(true);
    expect(defaulted.isTypesExplicit).toBe(false);
  });

  it("an agent with no files, or none guarded, adds no reader and breaks nothing", () => {
    const config = configOf({ bare: {}, free: { files: IMAGES }, guarded: { files: IMAGES } });
    const byElement = new Map([
      ["bare", guards(["g"])],
      ["guarded", guards(["h"])],
    ]);

    const readers = guardrailReadersOf(config, byElement, EMPTY);

    expect([...readers.keys()]).toEqual(["h"]);
  });

  it("input guardrails read the input's files, or the tool results' while those are guarded", () => {
    const fromTools = filesOf({
      sources: [FileSource.ToolResults],
      allowedMediaTypes: ["image/png"],
    });
    const unguarded = filesOf({
      sources: [FileSource.ToolResults],
      allowedMediaTypes: ["image/png"],
      guardToolResultFiles: false,
    });
    const history = filesOf({ sources: [FileSource.History], allowedMediaTypes: ["image/png"] });
    const config = configOf({
      tools: { files: fromTools },
      silent: { files: unguarded },
      past: { files: history },
    });
    const byElement = new Map([
      ["tools", guards(["a"])],
      ["silent", guards(["b"])],
      ["past", guards(["c"])],
    ]);

    expect([...guardrailReadersOf(config, byElement, EMPTY).keys()]).toEqual(["a"]);
  });

  it("output guardrails read only for an agent whose answer holds files", () => {
    const config = configOf({ answering: { files: IMAGES }, texting: { files: IMAGES } });
    const graph: Graph = {
      nodes: new Map([
        ["answering", { declaration: agentWith(ScanDto) }],
        ["texting", { declaration: agentWith(NoteDto) }],
      ]) as never,
    };
    const byElement = new Map([
      ["answering", guards([], ["out-a"])],
      ["texting", guards([], ["out-t"])],
    ]);

    const readers = guardrailReadersOf(config, byElement, graph);

    expect([...readers.keys()]).toEqual(["out-a"]);
  });
});

describe("judgeReadersOf", () => {
  it("a judge reads what its agents read, each need once", () => {
    const config = configOf({
      one: { files: IMAGES, judges: ["j"] },
      two: { files: IMAGES, judges: ["j", "k"] },
    });

    const readers = judgeReadersOf(config);

    expect(readers.get("j")).toEqual({
      needs: IMAGES_NEEDS,
      isNeedStrict: true,
      agents: ["one", "two"],
    });
    expect(readers.get("k")?.agents).toEqual(["two"]);
  });

  it("agents without files or without judges name no judge", () => {
    const config = configOf({
      bare: { judges: ["lost"] },
      free: { files: IMAGES },
    });

    expect([...judgeReadersOf(config).keys()]).toEqual([]);
  });
});
