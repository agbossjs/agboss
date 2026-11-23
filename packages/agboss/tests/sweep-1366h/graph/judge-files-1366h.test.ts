/**
 * #1366: the judges' file reading — no files seen (or no file runtime) is the empty reading and no
 * transcription is started; a reading starts from a zero tally of files and bytes.
 */
import { describe, expect, it, vi } from "vitest";

const { filePiecesOf } = vi.hoisted(() => ({ filePiecesOf: vi.fn() }));
vi.mock("../../../src/files/visit-files.js", async (original) => ({
  ...(await original<typeof import("../../../src/files/visit-files.js")>()),
  filePiecesOf,
}));
vi.mock("../../../src/graph/agent-loop/model-pii.js", () => ({ loopPoliciesOf: () => undefined }));

const { judgedFilesOf, EMPTY_SEEN } = await import("../../../src/graph/agent-loop/judge-files.js");

const seen = [{ source: { url: "https://files.example/a" }, digest: "d1" }];
const state = (list: unknown[]) => ({
  seen: list,
  usage: [],
  from: { usage: 0 },
  flowPath: ["flow"],
  fileTranscripts: {},
  piiTokens: {},
});
const deps = { fileRuntime: {}, budgets: { check: vi.fn() } };

describe("#1366: judgedFilesOf", () => {
  it("nothing seen: the empty reading, nothing transcribed", async () => {
    filePiecesOf.mockClear();
    const got = await judgedFilesOf(state([]) as never, deps as never);
    expect(got).toStrictEqual({ files: [], pieces: [], usage: [] });
    expect(got).toStrictEqual(EMPTY_SEEN);
    expect(filePiecesOf).not.toHaveBeenCalled();
  });

  it("no file runtime: the empty reading even with files seen", async () => {
    filePiecesOf.mockClear();
    const got = await judgedFilesOf(state(seen) as never, { budgets: deps.budgets } as never);
    expect(got).toStrictEqual({ files: [], pieces: [], usage: [] });
    expect(filePiecesOf).not.toHaveBeenCalled();
  });

  it("files seen: the reading starts from a zero tally", async () => {
    filePiecesOf.mockClear();
    filePiecesOf.mockResolvedValue({ viewed: [], pieces: [], usage: [] });
    await judgedFilesOf(state(seen) as never, deps as never);
    expect(filePiecesOf).toHaveBeenCalledOnce();
    expect(filePiecesOf.mock.calls[0]?.[0].tally).toStrictEqual({ count: 0, bytes: 0 });
  });
});
