import { usd } from "../../src/units/index.js";
/** #1269: the files of a tool's result — read, guarded, counted and stored — called with fake deps. */
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { FileDto } from "../../src/dto/standard/file.js";
import type { BudgetCheck } from "../../src/budgets/budget-check.js";
import { GuardrailSide } from "../../src/components/policy-decorators.js";
import { Nested, Text } from "../../src/dto/index.js";
import { schemaOf } from "../../src/dto/schema.js";
import { CostSource } from "../../src/finops/cost-source.js";
import type { UsageRecord } from "../../src/finops/usage.js";
import type { AgentLoopDeps, AgentDefinition } from "../../src/graph/agent-loop/deps.js";
import type { ClosedResult } from "../../src/graph/agent-loop/tool-pii.js";
import { PreparedFrom, type ToolTask } from "../../src/graph/agent-loop/state.js";
import type { GuardrailOutcome } from "../../src/core/observability.js";
import { resolvedFilesOf } from "../../src/files/file-settings.js";
import { FileSource, FileView, ModelFiles } from "../../src/files/model-files.js";
import { taskFilesOf, toolFilesOf, withFiles } from "../../src/files/tool-files.js";
import { NO_FILES, type FileRuntime } from "../../src/files/visit-files.js";
import type { RuntimeGuardrail } from "../../src/guardrails/runtime.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import {} from "../../src/pii/actions.js";
import { PiiKind } from "../../src/pii/kinds.js";
import { type PiiPolicyMeta } from "../../src/pii/pii-policy.decorator.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { runtimePolicyOf } from "../../src/pii/runtime-policy.js";
import type { AnyTool, ToolOutput } from "../../src/tools/index.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { kilobytes, megabytes, seconds } from "../../src/units/index.js";
import { PDF_BYTES, inline, sha256Of } from "./reader.factory.js";
import { NO_REDACTION } from "./runtime-parts.js";

class ScanQueryDto {
  @Text({ prompt: "which scan" })
  name!: string;
}

class ScanResultDto {
  @Nested(FileDto, { prompt: "the scan" })
  file!: FileDto;
}

const scanTool: AnyTool = {
  name: "scan-tool",
  description: "scans",
  timeout: seconds(1),
  input: schemaOf(ScanQueryDto),
  output: schemaOf(ScanResultDto),
  invoke: () => Promise.reject(new Error("not run")),
};

const opaqueTool: AnyTool = { ...scanTool, name: "opaque-tool", output: z.object({}) };

const usageOf = (caller: string): UsageRecord => ({
  provider: "test-provider",
  caller,
  model: "m",
  costUsd: usd(0),
  costSource: CostSource.Tool,
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const callersOf = (usage: readonly UsageRecord[]): string[] => usage.map((record) => record.caller);

function runtimeOf(
  over: { views?: FileView[]; guard?: boolean; sources?: FileSource[] } = {},
  transcribed: string[] = [],
): FileRuntime {
  const base = resolvedFilesOf({
    agent: ModelFiles.of({}).options,
    defaults: undefined,
    filePolicy: undefined,
    hasPiiPolicy: false,
  });
  return {
    agent: "a-agent",
    settings: {
      ...base,
      sources: over.sources ?? [FileSource.ToolResults],
      views: over.views ?? [FileView.Original],
      guardToolResultFiles: over.guard ?? true,
    },
    maxResultSize: kilobytes(8),
    ...NO_REDACTION,
    transcriberKey: () => "t",
    transcribe: () => {
      transcribed.push("called");
      return Promise.resolve({ text: "the scan", usage: usageOf("transcriber") });
    },
    context: () => ({
      store: new InMemoryFileRepository(new InMemoryDatabase()),
      tenantId: "t",
      ownerId: "o",
      signal: new AbortController().signal,
      clock: new VirtualClock(),
      transport: () => Promise.reject(new Error("no network")),
      allowedOrigins: [],
      fetchTimeout: seconds(1),
      maxFileSize: megabytes(1),
    }),
  };
}

interface BudgetCall {
  readonly state: unknown;
  readonly path: readonly string[];
}

function budgetsOf(log: BudgetCall[] = [], tallied: (readonly UsageRecord[])[] = []): BudgetCheck {
  return {
    check: (state, path) => {
      log.push({ state, path });
    },
    tally: (records) => {
      tallied.push(records);
      return records.map((record) => ({ ...record, caller: `tallied:${record.caller}` }));
    },
    exhausted: new AbortController().signal,
  };
}

interface FakeDeps {
  readonly agent: Pick<AgentDefinition, "name" | "maxResultSize">;
  readonly budgets: BudgetCheck;
  readonly fileRuntime?: FileRuntime | undefined;
  readonly pii?: PiiPolicySet;
  readonly guardrails?: readonly RuntimeGuardrail[];
}

const depsOf = (fake: Partial<FakeDeps> = {}): AgentLoopDeps => {
  const deps: FakeDeps = {
    agent: { name: "the-agent", maxResultSize: kilobytes(8) },
    budgets: budgetsOf(),
    fileRuntime: runtimeOf(),
    ...fake,
  };
  return deps as AgentLoopDeps;
};

const okOf = (value: unknown): ToolOutput<unknown> => ({ kind: "ok", value });
const PDF = inline(PDF_BYTES, "application/pdf", "a.pdf");

const taskOf = (over: Partial<ToolTask> = {}): ToolTask => ({
  callId: "c1",
  tool: "scan-tool",
  args: {},
  runId: "r1",
  prepared: { kind: "ready", args: {}, shown: {}, from: PreparedFrom.Model },
  ...over,
});

const run = (over: Partial<Parameters<typeof toolFilesOf>[3]> = {}) => ({
  tally: NO_FILES,
  cache: {},
  beforeModelCall: () => undefined,
  ...over,
});

describe("toolFilesOf", () => {
  it("reads nothing where the agent does not take tool results' files", async () => {
    const off = depsOf({ fileRuntime: runtimeOf({ sources: [FileSource.Input] }) });

    expect(await toolFilesOf(off, scanTool, okOf({ file: PDF }), run())).toBeUndefined();
    expect(
      await toolFilesOf(depsOf({ fileRuntime: undefined }), scanTool, okOf({ file: PDF }), run()),
    ).toBeUndefined();
  });

  it("reads nothing of a call that gave no result or an error", async () => {
    const failed: ToolOutput<unknown> = { kind: "error", message: "no" };
    const crafted = { kind: "error", message: "no", value: { file: PDF } } as const;

    expect(await toolFilesOf(depsOf(), scanTool, undefined, run())).toBeUndefined();
    expect(await toolFilesOf(depsOf(), scanTool, failed, run())).toBeUndefined();
    expect(await toolFilesOf(depsOf(), scanTool, crafted, run())).toBeUndefined();
  });

  it("reads nothing of a tool whose output is no DTO, and of a result with no file", async () => {
    expect(await toolFilesOf(depsOf(), opaqueTool, okOf({ file: PDF }), run())).toBeUndefined();
    expect(await toolFilesOf(depsOf(), scanTool, okOf({ file: "junk" }), run())).toBeUndefined();
  });

  it("shows a file under the tool's name, numbered after the files the visit already holds", async () => {
    const tally = { count: 2, bytes: 0 };

    const built = await toolFilesOf(depsOf(), scanTool, okOf({ file: PDF }), run({ tally }));

    expect(built?.sources).toStrictEqual([
      { descriptor: PDF, field: "scan-tool.file", producer: "tool scan-tool" },
    ]);
    expect(built?.pieces[0]).toStrictEqual({
      kind: "text",
      text: `### scan-tool.file (from tool scan-tool, file 3: a.pdf, application/pdf, ${String(PDF_BYTES.byteLength)} B, original)`,
    });
    expect(built?.digests).toEqual([sha256Of(PDF_BYTES)]);
    expect(built?.tally.count).toBe(3);
  });
});

describe("taskFilesOf: the read", () => {
  it("is no files and no spend for a call without files", async () => {
    expect(await taskFilesOf(depsOf(), scanTool, taskOf(), undefined)).toStrictEqual({ usage: [] });
    expect(await taskFilesOf(depsOf(), scanTool, taskOf(), okOf({}))).toStrictEqual({ usage: [] });
  });

  it("stores references and digests with what the call added to the visit's counts", async () => {
    const fileTally = { count: 2, bytes: 100 };
    const alone = await taskFilesOf(depsOf(), scanTool, taskOf(), okOf({ file: PDF }));

    const files = await taskFilesOf(depsOf(), scanTool, taskOf({ fileTally }), okOf({ file: PDF }));

    expect(files.files).toStrictEqual({
      sources: [{ descriptor: PDF, field: "scan-tool.file", producer: "tool scan-tool" }],
      digests: [sha256Of(PDF_BYTES)],
      count: 1,
      bytes: alone.files?.bytes,
    });
    expect(files.files?.bytes).toBeGreaterThan(0);
    expect(files.files?.bytes).toBeLessThan(1000);
  });

  it("counts from nothing where the task has no tally", async () => {
    const files = await taskFilesOf(depsOf(), scanTool, taskOf(), okOf({ file: PDF }));

    expect(files.files?.count).toBe(1);
    expect(files.files?.bytes).toBeGreaterThan(PDF_BYTES.byteLength);
  });

  it("works with no PII policies at all, and keeps a transcription unmasked where the set is empty", async () => {
    const deps = depsOf({
      fileRuntime: runtimeOf({ views: [FileView.Transcription] }),
      pii: new PiiPolicySet([], "key"),
    });

    const files = await taskFilesOf(deps, scanTool, taskOf(), okOf({ file: PDF }));
    const bare = await taskFilesOf(
      depsOf({ fileRuntime: runtimeOf({ views: [FileView.Transcription] }) }),
      scanTool,
      taskOf(),
      okOf({ file: PDF }),
    );

    expect(Object.values(files.transcripts ?? {})).toEqual(["the scan"]);
    expect(files.tokens).toEqual({});
    expect(Object.values(bare.transcripts ?? {})).toEqual(["the scan"]);
    expect(callersOf(files.usage)).toEqual(["transcriber"]);
  });

  it("checks the budgets with the task's own before a model call, and only where it has them", async () => {
    const log: BudgetCall[] = [];
    const transcribed: string[] = [];
    const views = { views: [FileView.Transcription] };
    const deps = depsOf({
      budgets: budgetsOf(log),
      fileRuntime: runtimeOf(views, transcribed),
    });
    const spent = [usageOf("before")];
    const budget = { usage: spent, path: ["root", "agent"], loop: [] };

    await taskFilesOf(deps, scanTool, taskOf({ budget }), okOf({ file: PDF }));
    expect(log).toStrictEqual([{ state: spent, path: ["root", "agent"] }]);
    expect(transcribed).toEqual(["called"]);

    log.length = 0;
    await taskFilesOf(deps, scanTool, taskOf(), okOf({ file: PDF }));
    expect(log).toEqual([]);
  });
});

/** A guardrail that records what it is asked and decides as it is told. */
function guardrailOf(
  asked: unknown[],
  outcome: GuardrailOutcome = { isBlocked: false, probability: 0 },
): RuntimeGuardrail {
  return {
    guardrail: {
      type: Error,
      name: "the-guard",
      description: "d",
      side: GuardrailSide.Input,
      kind: "code",
    },
    decide: (checked, spent) => {
      asked.push(checked);
      spent.push(usageOf("guard"));
      return Promise.resolve(outcome);
    },
    refusal: () => Promise.resolve("not these files"),
  };
}

describe("taskFilesOf: the input guardrails on the files", () => {
  const views = { views: [FileView.Transcription] };

  it("shows them the files in the views, the element, the side and no text; decisions and spend follow", async () => {
    const asked: unknown[] = [];
    const deps = depsOf({
      fileRuntime: runtimeOf(views),
      guardrails: [guardrailOf(asked)],
    });

    const files = await taskFilesOf(deps, scanTool, taskOf(), okOf({ file: PDF }));

    expect(asked).toMatchObject([
      { text: "", component: { name: "the-agent" }, side: "input", files: [{ pieces: [{}] }] },
    ]);
    expect(callersOf(files.usage)).toEqual(["transcriber", "guard"]);
    expect(files.decisions).toMatchObject([{ side: "input", isBlocked: false, probability: 0 }]);
    expect(files.refused).toBeUndefined();
    expect(files.files?.count).toBe(1);
  });

  it("refuses the call when a guardrail blocks, with the guardrail's words and no stored files", async () => {
    const deps = depsOf({
      fileRuntime: runtimeOf(views),
      guardrails: [guardrailOf([], { isBlocked: true, probability: 1 })],
    });

    const files = await taskFilesOf(deps, scanTool, taskOf(), okOf({ file: PDF }));

    expect(files.refused?.content).toBe("Tool error: the call was refused: not these files");
    expect(files.refused?.error.name).toBe("GuardrailBlockedError");
    expect(files.files).toBeUndefined();
    expect(callersOf(files.usage)).toEqual(["transcriber", "guard"]);
    expect(files.decisions).toMatchObject([{ isBlocked: true, probability: 1 }]);
    expect(Object.values(files.transcripts ?? {})).toEqual(["the scan"]);
  });

  it("asks nothing where there are no guardrails, whatever the setting", async () => {
    const none = await taskFilesOf(
      depsOf({ fileRuntime: runtimeOf(views) }),
      scanTool,
      taskOf(),
      okOf({ file: PDF }),
    );
    const empty = await taskFilesOf(
      depsOf({ fileRuntime: runtimeOf(views), guardrails: [] }),
      scanTool,
      taskOf(),
      okOf({ file: PDF }),
    );

    for (const files of [none, empty]) {
      expect(callersOf(files.usage)).toEqual(["transcriber"]);
      expect(files).not.toHaveProperty("decisions");
      expect(files).not.toHaveProperty("refused");
    }
  });

  it("asks nothing where the tool results' files are not guarded", async () => {
    const asked: unknown[] = [];
    const deps = depsOf({
      fileRuntime: runtimeOf({ ...views, guard: false }),
      guardrails: [guardrailOf(asked)],
    });

    const files = await taskFilesOf(deps, scanTool, taskOf(), okOf({ file: PDF }));

    expect(asked).toEqual([]);
    expect(files).not.toHaveProperty("decisions");
  });

  it("works with an empty PII set as with none", async () => {
    const asked: unknown[] = [];
    const guarded = { fileRuntime: runtimeOf(views), guardrails: [guardrailOf(asked)] };

    await taskFilesOf(
      depsOf({ ...guarded, pii: new PiiPolicySet([], "k") }),
      scanTool,
      taskOf(),
      okOf({ file: PDF }),
    );

    expect(asked).toHaveLength(1);
  });
});

describe("withFiles", () => {
  const closed = (): ClosedResult => ({
    content: "the result",
    piiTokens: {},
    piiMasked: {},
    usage: [usageOf("tool")],
    isTruncated: false,
  });

  it("tallies the tool's spend and the files' together, in that order, and keeps the tallied records", async () => {
    const tallied: (readonly UsageRecord[])[] = [];
    const deps = depsOf({
      budgets: budgetsOf([], tallied),
      fileRuntime: runtimeOf({ views: [FileView.Transcription] }),
    });

    const result = await withFiles(deps, scanTool, taskOf(), {
      closed: closed(),
      output: okOf({ file: PDF }),
    });

    expect(tallied.map(callersOf)).toEqual([["tool", "transcriber"]]);
    expect(callersOf(result.closed.usage)).toEqual(["tallied:tool", "tallied:transcriber"]);
    expect(result.closed.content).toBe("the result");
    expect(result.closed).not.toHaveProperty("refusal");
    expect(result.files?.count).toBe(1);
    expect(Object.values(result.transcripts ?? {})).toEqual(["the scan"]);
  });

  it("closes a refused call with the refusal as the tool's result", async () => {
    const deps = depsOf({
      fileRuntime: runtimeOf({ views: [FileView.Transcription] }),
      guardrails: [guardrailOf([], { isBlocked: true, probability: 1 })],
    });

    const result = await withFiles(deps, scanTool, taskOf(), {
      closed: closed(),
      output: okOf({ file: PDF }),
    });

    expect(result.closed.content).toBe("Tool error: the call was refused: not these files");
    expect(result.closed.refusal?.name).toBe("GuardrailBlockedError");
    expect(result).not.toHaveProperty("refused");
    expect(result.files).toBeUndefined();
  });

  it("refuses the call whose transcription a block rule of the PII policies refuses, with the refusal", async () => {
    const meta: PiiPolicyMeta = {
      name: "blocking-pii-policy",
      description: "blocks cards",
      rules: [PiiKind.CardNumber.block("No cards.")],
      deps: [],
    };
    const blocking = new PiiPolicySet(
      [runtimePolicyOf({ meta, instance: {}, key: "k" })],
      "field-key",
    );
    const runtime = {
      ...runtimeOf({ views: [FileView.Transcription] }),
      transcribe: () => Promise.resolve({ text: "card 4242 4242 4242 4242" }),
    };

    const files = await taskFilesOf(
      depsOf({ fileRuntime: runtime, pii: blocking }),
      scanTool,
      taskOf(),
      okOf({ file: PDF }),
    );

    expect(files.refused?.error.name).toBe("PiiRefusedError");
    expect(files.refused?.content).toContain("No cards.");
    expect(files.files).toBeUndefined();
  });

  it("leaves a call without files as it was, its spend tallied", async () => {
    const result = await withFiles(depsOf(), scanTool, taskOf(), { closed: closed() });

    expect(callersOf(result.closed.usage)).toEqual(["tallied:tool"]);
    expect(result.usage).toEqual([]);
  });
});
