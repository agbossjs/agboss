import { describe, expect, it } from "vitest";
import { OneOf, Text } from "./dto.js";
import {
  diffFingerprints,
  fingerprintOf,
  renderFingerprint,
  type FingerprintNode,
} from "./fingerprint.js";
import {
  CODER_PROMPT,
  FIXTURE_FILES,
  INHERITED,
  TestRun,
  coderAgent,
  mainRouter,
  promptFolder,
  writeFileTool,
} from "./fixture.js";
import {
  assembleAgent,
  assembleRouter,
  type AgentSpec,
  type RouterSpec,
  type ToolSpec,
} from "./request.js";

class FileWriteWithMode {
  @Text({ prompt: "relative to the repository root" })
  path!: string;

  @Text({ prompt: "the whole new content of the file" })
  content!: string;

  @OneOf({ values: ["replace", "append"], prompt: "how to write", optional: true })
  mode?: "replace" | "append";
}

class FileWriteReworded {
  @Text({ prompt: "relative to the root of the repository" })
  path!: string;

  @Text({ prompt: "the whole new content of the file" })
  content!: string;
}

class FileWriteReordered {
  @Text({ prompt: "the whole new content of the file" })
  content!: string;

  @Text({ prompt: "relative to the repository root" })
  path!: string;
}

const dir = await promptFolder(FIXTURE_FILES);
const agentOf = (spec: AgentSpec): Promise<FingerprintNode> =>
  assembleAgent(spec, INHERITED).then(fingerprintOf);
const routerOf = (spec: RouterSpec): Promise<FingerprintNode> =>
  assembleRouter(spec, INHERITED).then(fingerprintOf);
const coder = coderAgent(dir);
const baseline = await agentOf(coder);
const withWriteFile = (tool: ToolSpec): AgentSpec => ({
  ...coder,
  tools: coder.tools.map((item) => (item.name === "write-file" ? tool : item)),
});
const changesOf = async (spec: AgentSpec): Promise<readonly string[]> =>
  diffFingerprints(baseline, await agentOf(spec)).map(({ path, change }) => `${change} ${path}`);

describe("spike #115 — every change the model would see changes the fingerprint, and says where", () => {
  it("one word in the prompt → prompt", async () => {
    const edited = await promptFolder({
      ...FIXTURE_FILES,
      "coder.prompt.md": CODER_PROMPT.replace("small", "tiny"),
    });

    expect(await changesOf(coderAgent(edited))).toEqual(["changed agent / prompt"]);
  });

  it("one word in a tool's prompt file → that tool's description", async () => {
    const edited = await promptFolder({
      ...FIXTURE_FILES,
      "write-file.prompt.md": "Never write outside the repo.",
    });

    expect(await changesOf(coderAgent(edited))).toEqual([
      "changed agent / tools / write-file / description",
    ]);
  });

  it("a new field in a tool's input DTO → that field, and nothing else", async () => {
    const changes = await changesOf(
      withWriteFile({ ...writeFileTool(dir), input: FileWriteWithMode }),
    );

    expect(changes).toEqual(["added agent / tools / write-file / input schema / mode"]);
  });

  it("a field's prompt → that field", async () => {
    const changes = await changesOf(
      withWriteFile({ ...writeFileTool(dir), input: FileWriteReworded }),
    );

    expect(changes).toEqual(["changed agent / tools / write-file / input schema / path"]);
  });

  it("the order of DTO fields → the schema (the model reads and fills fields in that order)", async () => {
    const changes = await changesOf(
      withWriteFile({ ...writeFileTool(dir), input: FileWriteReordered }),
    );

    expect(changes).toEqual(["changed agent / tools / write-file / input schema / shape"]);
  });

  it("a tool's name → the tool is replaced", async () => {
    const changes = await changesOf(withWriteFile({ ...writeFileTool(dir), name: "save-file" }));

    expect(changes).toEqual([
      "added agent / tools / save-file",
      "removed agent / tools / write-file",
    ]);
  });

  it.each([
    ["the model", { model: "openai/gpt-5-mini" }],
    ["the temperature", { temperature: 0.3 }],
    ["the reasoning effort", { reasoningEffort: "high" as const }],
    ["maxTokens", { maxTokens: 4096 }],
    ["a request field", { requestFields: { seed: 7 } }],
    ["the provider", { provider: "openai" }],
  ])("%s → model + parameters", async (_name, settings) => {
    const changes = await changesOf({ ...coder, settings: { ...coder.settings, ...settings } });

    expect(changes).toEqual(["changed agent / model + parameters"]);
  });

  it("a structured answer → answer schema", async () => {
    expect(await changesOf({ ...coder, answer: TestRun })).toEqual([
      "changed agent / answer schema",
    ]);
  });

  it("a route's prompt → that route; a new route → added", async () => {
    const router = mainRouter(dir);
    const before = await routerOf(router);
    const routes = [
      ...router.routes.map((route) =>
        route.target === "coder" ? { ...route, prompt: "requests to write code" } : route,
      ),
      { target: "reviewer", prompt: "requests to review a change" },
    ];

    const changes = diffFingerprints(before, await routerOf({ ...router, routes }));

    expect(changes).toEqual([
      { path: "router / routes / coder", change: "changed" },
      { path: "router / routes / reviewer", change: "added" },
    ]);
  });

  it("renders the tree with what changed, like `gc suite fingerprint`", async () => {
    const after = await agentOf(withWriteFile({ ...writeFileTool(dir), input: FileWriteWithMode }));

    const text = renderFingerprint(after, baseline);

    expect(text).toMatch(/^agent\s+[0-9a-f]{8}…$/m);
    expect(text).toMatch(/^ {8}mode\s+[0-9a-f]{8}… {2}added$/m);
    expect(text).toMatch(/^ {4}read-repo\s+[0-9a-f]{8}…$/m);
  });
});
