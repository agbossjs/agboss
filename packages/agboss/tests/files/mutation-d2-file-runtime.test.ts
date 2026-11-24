/** #1269: what an agent's loop reads its files with: the execution's read context, its thread owners, its transcriber and redactor. */
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { appFileSlotsOf } from "../../src/a2a/files/a2a-file-pool.js";
import { callerKeyOf, tenantKeyOf } from "../../src/a2a/files/a2a-file-slots.js";
import { FileRepository } from "../../src/infrastructure/file.repository.js";
import { DEFAULT_FILE_FETCH_TIMEOUT } from "../../src/a2a/files/a2a-file-options.js";
import { runInFrame } from "../../src/flow/context/frame.js";
import { fileRuntimeOf } from "../../src/files/file-runtime.js";
import {
  FileRedactor,
  ModelImageRedactor,
  type RedactionResult,
} from "../../src/files/file-redactor.js";
import { FileTranscriber, ModelFileTranscriber } from "../../src/files/file-transcriber.js";
import { resolvedFilesOf } from "../../src/files/file-settings.js";
import { ModelFiles } from "../../src/files/model-files.js";
import { ExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { systemClock } from "../../src/infrastructure/clock.js";
import { rememberContextMeshSettings, type MeshSettings } from "../../src/mesh/mesh-settings.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { hours, usd } from "../../src/units/index.js";
import { testFrame } from "../helpers/frame.js";
import { sha256Of } from "./reader.factory.js";

const settings = resolvedFilesOf({
  agent: ModelFiles.of({ maxFileSize: 4096 as never }).options,
  defaults: undefined,
  skills: [],
  a2aFiles: undefined,
  hasPiiPolicy: false,
});
const file = {
  mediaType: "application/pdf",
  bytes: Buffer.from("ABC"),
  sha256: sha256Of(Buffer.from("ABC")),
};

type Token = abstract new (...args: never[]) => unknown;

/** Deps whose container holds the given instances; the agent's own and everything else absent. */
function depsOf(
  instances: ReadonlyMap<Token, unknown>,
  extra: {
    clock?: VirtualClock;
    transcribers?: Map<string, unknown>;
    redactors?: Map<string, unknown>;
  } = {},
) {
  // the application's file store: one of its own for every deps, as an application has one
  const store = {};
  return {
    container: {
      get: (token: Token) => (token === FileRepository ? store : instances.get(token)),
    },
    registry: {
      fileTranscribers: extra.transcribers ?? new Map(),
      fileRedactors: extra.redactors ?? new Map(),
    },
    ...(extra.clock === undefined ? {} : { clock: extra.clock }),
  } as never;
}

const agentOf = { name: "reader", files: settings, maxResultSize: 1024 } as never;
const runtimeOf = (deps: never) => {
  const runtime = fileRuntimeOf(deps, agentOf);
  if (runtime === undefined) throw new Error("no runtime");
  return runtime;
};
const inFrame = <T>(work: () => Promise<T>): Promise<T> => runInFrame(testFrame(), work);

class OwnTranscriber extends FileTranscriber {
  seen: unknown[] = [];
  constructor(private readonly answer: { text: string; cost?: ReturnType<typeof usd> }) {
    super();
  }
  transcribe(...args: unknown[]) {
    this.seen.push(args[1]);
    return Promise.resolve(this.answer);
  }
}

class OwnRedactor extends FileRedactor {
  seen: unknown[] = [];
  supports(mediaType: string): boolean {
    return mediaType === "image/png";
  }
  redact(...args: unknown[]) {
    this.seen.push(args[1]);
    const result: RedactionResult = { file, found: [], cost: usd(0.02) };
    return Promise.resolve(result);
  }
}

describe("#1269: fileRuntimeOf", () => {
  it("none without settings", () => {
    expect(fileRuntimeOf(depsOf(new Map()), { name: "a" } as never)).toBeUndefined();
  });

  it("names the transcriber and the redactor with their models", () => {
    const runtime = runtimeOf(
      depsOf(
        new Map<Token, unknown>([
          [FileTranscriber, new OwnTranscriber({ text: "" })],
          [FileRedactor, new OwnRedactor()],
        ]),
      ),
    );

    expect(runtime.transcriberKey()).toBe(`OwnTranscriber:${settings.transcriptionModel}`);
    expect(runtime.redactorKey()).toBe(`OwnRedactor:${settings.redactionModel}`);
  });

  it("outside an execution a read fails: a file belongs to its execution's task", async () => {
    const runtime = runtimeOf(depsOf(new Map()));

    expect(() => runtime.context()).toThrow(
      new TypeError("a model's files are read inside an execution"),
    );
    await expect(runtime.threadOwners()).rejects.toThrow(
      new TypeError("a model's files are read inside an execution"),
    );
  });
});

describe("#1269: the read context", () => {
  it("an application with no file origins: none, the system clock, the size in bytes", async () => {
    const runtime = runtimeOf(depsOf(new Map()));
    const context = await inFrame(() => Promise.resolve(runtime.context()));

    expect(context.allowedOrigins).toEqual([]);
    expect(context.clock).toBe(systemClock);
    expect(context.maxFileSize).toBe(4096);
    expect(context.fetchTimeout).toBe(DEFAULT_FILE_FETCH_TIMEOUT);
    expect(context.tenantId).toBe(testFrame().execution.tenant.tenantId);
    expect(context.ownerId).toBe(testFrame().execution.executionId);
  });

  it("a download takes the application's fetch slots, under its tenant's and its thread owner's keys (#1312)", async () => {
    const deps = depsOf(new Map());
    const store = (deps as { container: { get: (token: Token) => object } }).container.get(
      FileRepository,
    );
    const context = await inFrame(() => Promise.resolve(runtimeOf(deps).context()));
    const { execution } = testFrame();

    expect(context.slots).toBe(appFileSlotsOf(store));
    expect(context.caller).toEqual({
      tenant: tenantKeyOf(execution.tenant.tenantId),
      owner: callerKeyOf(execution.tenant.tenantId, execution.ownerId),
    });
  });

  it("the deps' clock and the application's file origins are the context's", async () => {
    const frame = testFrame();
    const meshSettings: MeshSettings = {
      application: "app",
      maxMeshHops: 8,
      keys: { peers: new Map() },
      clock: new VirtualClock(),
      idempotencyRetention: hours(1),
      a2aTaskRetention: hours(1),
      a2aFileRetention: hours(1),
      a2aMessageRetention: hours(1),
      a2aFiles: { allowedFileOrigins: ["https://files.example"] },
      workflows: [],
      exposes: [],
      contracts: () => Promise.reject(new Error("none")),
    };
    rememberContextMeshSettings(frame.execution.tenant.application, meshSettings);
    const clock = new VirtualClock();
    const runtime = runtimeOf(depsOf(new Map(), { clock }));
    const context = await runInFrame(frame, () => Promise.resolve(runtime.context()));

    expect(context.clock).toBe(clock);
    expect(context.allowedOrigins).toEqual(["https://files.example"]);
  });

  it("the https transport is loaded at the first download: an address never fetched from is refused", async () => {
    const runtime = runtimeOf(depsOf(new Map()));
    const context = await inFrame(() => Promise.resolve(runtime.context()));

    await expect(
      context.transport(new URL("https://127.0.0.1/a.pdf"), new AbortController().signal),
    ).rejects.toMatchObject({ name: "FileAddressDeniedError" });
  });
});

describe("#1269: the thread's owners", () => {
  it("the runs of the thread's turns; a turn with no run (before #238) owns nothing", async () => {
    const asked: unknown[] = [];
    const records = {
      lastTurns: (...args: unknown[]) => {
        asked.push(args);
        return Promise.resolve([{ runId: "run-1" }, { runId: null }, { runId: "run-2" }]);
      },
    };
    const runtime = runtimeOf(
      depsOf(new Map<Token, unknown>([[ExecutionRecordRepository, records]])),
    );
    const { execution } = testFrame();

    await expect(inFrame(() => runtime.threadOwners())).resolves.toEqual(["run-1", "run-2"]);
    expect(asked).toEqual([[execution.tenant.tenantId, execution.threadId, 1000]]);
  });
});

describe("#1269: a project's own transcriber", () => {
  it("is given the file and the signal and tenant; a price is billed as a tool cost under files:transcriber", async () => {
    const own = new OwnTranscriber({ text: "T", cost: usd(0.01) });
    const runtime = runtimeOf(depsOf(new Map<Token, unknown>([[FileTranscriber, own]])));
    const frame = testFrame();
    const { execution } = frame;

    const result = await runInFrame(frame, () => runtime.transcribe(file));

    expect(own.seen).toEqual([{ signal: execution.signal, tenantId: execution.tenant.tenantId }]);
    expect(result.text).toBe("T");
    expect(result.usage).toMatchObject({
      caller: "files:transcriber",
      model: "transcriber",
      costUsd: 0.01,
      costSource: "tool",
    });
  });

  it("with no price its result is as it gave it", async () => {
    const answer = { text: "T" };
    const runtime = runtimeOf(
      depsOf(new Map<Token, unknown>([[FileTranscriber, new OwnTranscriber(answer)]])),
    );

    await expect(inFrame(() => runtime.transcribe(file))).resolves.toBe(answer);
  });

  it("a usage it reports itself is kept, not replaced by its price", async () => {
    const usage = { caller: "mine", model: "m", costUsd: 5 } as never;
    const answer = { text: "T", cost: usd(0.01), usage };
    const runtime = runtimeOf(
      depsOf(new Map<Token, unknown>([[FileTranscriber, new OwnTranscriber(answer)]])),
    );

    await expect(inFrame(() => runtime.transcribe(file))).resolves.toBe(answer);
  });
});

describe("#1269: the built-in transcriber", () => {
  const model = {
    invoke: (_messages: readonly BaseMessage[]) =>
      Promise.resolve(
        new AIMessage({
          content: "READ",
          usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      ),
  };
  const binding = { model, settings: { model: "v", price: { inputPerMTok: 1, outputPerMTok: 1 } } };

  it("runs on the agent's bound model", async () => {
    const runtime = runtimeOf(
      depsOf(new Map<Token, unknown>([[FileTranscriber, new ModelFileTranscriber()]]), {
        transcribers: new Map([["reader", binding]]),
      }),
    );

    const result = await inFrame(() => runtime.transcribe(file));

    expect(result.text).toBe("READ");
    expect(result.usage?.caller).toBe("files:transcriber");
  });

  it("with no model bound it fails, naming the agent", async () => {
    const runtime = runtimeOf(
      depsOf(new Map<Token, unknown>([[FileTranscriber, new ModelFileTranscriber()]])),
    );

    await expect(inFrame(() => runtime.transcribe(file))).rejects.toThrow(
      new TypeError("reader: no transcription model is bound"),
    );
  });
});

describe("#1269: the redactor", () => {
  const plan = { targets: [], values: ["v1"], regions: [] } as never;

  it("a project's own redactor: its price is billed as a tool cost under files:redactor", async () => {
    const own = new OwnRedactor();
    const runtime = runtimeOf(depsOf(new Map<Token, unknown>([[FileRedactor, own]])));

    const result = await inFrame(() => runtime.redact(file, plan));

    expect(result.usage).toMatchObject({
      caller: "files:redactor",
      model: "redactor",
      costUsd: 0.02,
      costSource: "tool",
    });
    expect(own.seen).toHaveLength(1);
    expect(own.seen[0]).toMatchObject({
      values: [],
      tenantId: testFrame().execution.tenant.tenantId,
    });
    expect(runtime.supportsRedaction("image/png")).toBe(true);
    expect(runtime.supportsRedaction("image/gif")).toBe(false);
  });

  it("the built-in with no model bound fails, naming the agent", async () => {
    const runtime = runtimeOf(
      depsOf(new Map<Token, unknown>([[FileRedactor, new ModelImageRedactor()]])),
    );

    await expect(inFrame(() => runtime.redact(file, plan))).rejects.toThrow(
      new TypeError("reader: no redaction model is bound"),
    );
  });
});
