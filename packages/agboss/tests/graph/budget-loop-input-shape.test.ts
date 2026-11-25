import { usd } from "../../src/units/index.js";
/**
 * #1366 (budget-loop shard) — what the input step adds to the loop when it has nothing to read, and the text of the
 * decisions an agent is told about, each on its own over fakes: no files, no guardrails and no mask leave the lists empty
 * (nothing of a file is marked as seen or masked), a file whose digest is empty is not marked as seen, and the settled
 * decisions are worded and clipped as the agent reads them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { filePiecesOf } from "../../src/files/visit-files.js";
import { fileMaskOf } from "../../src/files/file-mask.js";
import { guardedFilesOf } from "../../src/files/guarded-files.js";
import { formatDecisionsForAgent, makeInputNode } from "../../src/graph/agent-loop/input-node.js";
import { loopPoliciesOf } from "../../src/graph/agent-loop/model-pii.js";
import { gatherKnowledge } from "../../src/graph/nodes/knowledge.js";
import { runGuardrails } from "../../src/guardrails/runtime.js";

vi.mock("../../src/graph/nodes/knowledge.js", () => ({ gatherKnowledge: vi.fn() }));
vi.mock("../../src/graph/agent-loop/model-pii.js", () => ({ loopPoliciesOf: vi.fn() }));
vi.mock("../../src/files/guarded-files.js", () => ({ guardedFilesOf: vi.fn() }));
vi.mock("../../src/files/file-mask.js", () => ({ fileMaskOf: vi.fn() }));
vi.mock("../../src/guardrails/runtime.js", () => ({ runGuardrails: vi.fn() }));
vi.mock("../../src/pii/model-boundary.js", () => ({
  maskedModelText: vi.fn(),
  modelReadingMaskOf: vi.fn(() => undefined),
  withModelReading: vi.fn((_reading: unknown, work: () => unknown) => work()),
}));
vi.mock("../../src/files/visit-files.js", async (original) => ({
  ...(await original<typeof import("../../src/files/visit-files.js")>()),
  filePiecesOf: vi.fn(),
}));

const record = (costUsd: number): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller: "x",
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const stateOf = (changes: Record<string, unknown> = {}) =>
  ({
    runId: "run-1",
    usage: [],
    from: { usage: 0 },
    flowPath: ["a"],
    inputMessage: "hello",
    summaries: [],
    history: [],
    approvals: [],
    piiTokens: {},
    inputFiles: [],
    fileTally: { count: 0, bytes: 0 },
    fileTranscripts: {},
    ...changes,
  }) as never;

const nodeOf = (changes: Record<string, unknown> = {}) =>
  makeInputNode({
    agent: { name: "alpha", knowledge: [], maxResultSize: 77 },
    budgets: { tally: (records: readonly UsageRecord[]) => records, check: vi.fn() },
    fileRuntime: undefined,
    guardrails: undefined,
    observer: "observer",
    ...changes,
  } as never);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(gatherKnowledge).mockResolvedValue({ block: "", records: [] });
  vi.mocked(loopPoliciesOf).mockReturnValue(undefined);
});

describe("#1366: an input with nothing to read adds nothing", () => {
  const file = { fileId: "f1" };

  it("no file runtime, no guardrails, no mask: empty lists, no file marked as seen, nothing masked", async () => {
    const out = await nodeOf()(stateOf({ inputFiles: [file] }), undefined);

    expect(out).toMatchObject({
      usage: [],
      piiTokens: {},
      piiMasked: {},
      guardrailDecisions: [],
      fileTally: { count: 0, bytes: 0 },
      fileTranscripts: {},
      seen: [],
    });
    expect(filePiecesOf).not.toHaveBeenCalled();
  });

  it("guardrails over an input with no files check no file's view, and nothing of a file is masked", async () => {
    vi.mocked(fileMaskOf).mockReturnValue({
      maskCacheKeyOf: (text: string) => `file:${text}`,
    } as never);
    vi.mocked(guardedFilesOf).mockResolvedValue({ files: [], usage: [] });
    vi.mocked(runGuardrails).mockResolvedValue({ usage: [], decisions: [] });

    const out = await nodeOf({ guardrails: ["g"] })(stateOf({ inputFiles: [file] }), undefined);

    expect(guardedFilesOf).toHaveBeenCalledWith([], 77, expect.anything());
    expect(out.piiMasked).toEqual({});
    expect(out.seen).toEqual([]);
  });

  it("with no mask, the files' masked texts are kept under no key", async () => {
    vi.mocked(fileMaskOf).mockReturnValue(undefined);
    vi.mocked(filePiecesOf).mockResolvedValue({
      pieces: [],
      viewed: [],
      tokens: {},
      maskedTexts: ["x"],
      usage: [],
      digests: [],
      transcripts: {},
      tally: { count: 0, bytes: 0 },
    });

    const out = await nodeOf({ fileRuntime: {} })(stateOf({ inputFiles: [file] }), undefined);

    expect(out.piiMasked).toEqual({});
  });

  it("a file whose digest is empty or missing is not marked as seen", async () => {
    vi.mocked(filePiecesOf).mockResolvedValue({
      pieces: [],
      viewed: [],
      tokens: {},
      maskedTexts: [],
      usage: [],
      digests: ["d1", "", undefined as never],
      transcripts: {},
      tally: { count: 0, bytes: 0 },
    });
    const files = [file, { fileId: "f2" }, { fileId: "f3" }, { fileId: "f4" }];

    const out = await nodeOf({ fileRuntime: {} })(stateOf({ inputFiles: files }), undefined);

    expect(out.seen).toEqual([{ source: file, digest: "d1" }]);
  });
});

describe("#1366: the decisions an agent is told about", () => {
  const decided = (changes: Record<string, unknown>) => ({
    agent: "shortlist",
    tool: "write",
    args: { path: "/s.md" },
    approved: true,
    by: "dana",
    result: "done",
    ...changes,
  });
  const HEAD =
    "Your tool calls decided in this execution (already settled — do not repeat them):\n";

  it("is worded exactly: the call, who decided, and the result", () => {
    const text = formatDecisionsForAgent(
      [decided({}), decided({ approved: false, by: "ci", result: "no" })] as never,
      "shortlist",
    );

    expect(text).toBe(
      `${HEAD}- write {"path":"/s.md"}: approved by dana and DONE — result: done\n- write {"path":"/s.md"}: rejected by ci, NOT done — no`,
    );
  });

  it("a decision with no result has an empty one", () => {
    const text = formatDecisionsForAgent(
      [decided({ result: undefined }), decided({ approved: false, result: undefined })] as never,
      "shortlist",
    );

    expect(text).toBe(
      `${HEAD}- write {"path":"/s.md"}: approved by dana and DONE — result: \n- write {"path":"/s.md"}: rejected by dana, NOT done — `,
    );
  });

  it("clips the arguments at 200 characters and the result at 300, and only past them", () => {
    const exact = decided({ args: "a".repeat(198), result: "r".repeat(300) });
    const over = decided({ args: "a".repeat(199), result: "r".repeat(301) });

    const [first, second] = formatDecisionsForAgent([exact, over] as never, "shortlist")
      .slice(HEAD.length)
      .split("\n");

    expect(first).toBe(
      `- write "${"a".repeat(198)}": approved by dana and DONE — result: ${"r".repeat(300)}`,
    );
    expect(second).toBe(
      `- write "${"a".repeat(199)}…: approved by dana and DONE — result: ${"r".repeat(300)}…`,
    );
  });
});
