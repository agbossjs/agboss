import { describe, expect, it } from "vitest";
import { MODEL_MAX } from "../../../src/config/types.js";
import { Text } from "./dto.js";
import { fingerprintOf, type FingerprintNode } from "./fingerprint.js";
import {
  CODER_FINGERPRINT,
  CODER_PROMPT,
  FIXTURE_FILES,
  INHERITED,
  coderAgent,
  mainRouter,
  promptFolder,
  writeFileTool,
} from "./fixture.js";
import { BOM } from "./prompt-text.js";
import { assembleAgent, assembleRouter, type AgentSpec, type ModelSettings } from "./request.js";

class FileWriteUnderAnotherName {
  @Text({ prompt: "relative to the repository root" })
  path!: string;

  @Text({ prompt: "the whole new content of the file" })
  content!: string;
}

const dir = await promptFolder(FIXTURE_FILES);
const agent = (spec: AgentSpec, inherited: ModelSettings = INHERITED): Promise<FingerprintNode> =>
  assembleAgent(spec, inherited).then(fingerprintOf);
const baseline = await agent(coderAgent(dir));

describe("spike #115 — the fingerprint does not change when the request does not", () => {
  it("is the pinned value for the fixture agent", () => {
    expect(baseline.hash).toBe(CODER_FINGERPRINT);
  });

  it("does not depend on where the prompt files are (another folder, another machine)", async () => {
    const elsewhere = await promptFolder(FIXTURE_FILES);

    expect((await agent(coderAgent(elsewhere))).hash).toBe(baseline.hash);
  });

  it("ignores CRLF, trailing whitespace, a BOM and final newlines in prompt files", async () => {
    const messy = await promptFolder({
      ...FIXTURE_FILES,
      "coder.prompt.md": `${BOM}${CODER_PROMPT.replace(/\n/g, "  \r\n")}\r\n\r\n`,
      "write-file.prompt.md": "Never write outside the repository.",
    });

    expect((await agent(coderAgent(messy))).hash).toBe(baseline.hash);
  });

  it("ignores the order of options in the decorator", async () => {
    const spec = coderAgent(dir);
    const reordered: AgentSpec = {
      tools: spec.tools,
      settings: { reasoningEffort: "medium", temperature: 0.1 },
      location: spec.location,
      promptUrls: spec.promptUrls,
      description: spec.description,
    };

    expect((await agent(reordered)).hash).toBe(baseline.hash);
  });

  it("ignores the order tools are listed in: they are sent sorted by name", async () => {
    const spec = coderAgent(dir);

    expect((await agent({ ...spec, tools: [...spec.tools].reverse() })).hash).toBe(baseline.hash);
  });

  it("ignores texts for people: the agent's and the tools' description", async () => {
    const spec = coderAgent(dir);
    const tools = spec.tools.map((tool) => ({ ...tool, description: "reworded for the docs" }));

    expect((await agent({ ...spec, description: "reworded", tools })).hash).toBe(baseline.hash);
  });

  it("ignores the name of the DTO class", async () => {
    const spec = coderAgent(dir);
    const renamed = { ...writeFileTool(dir), input: FileWriteUnderAnotherName };
    const tools = spec.tools.map((tool) => (tool.name === "write-file" ? renamed : tool));

    expect((await agent({ ...spec, tools })).hash).toBe(baseline.hash);
  });

  it("hashes resolved settings: an explicit value equal to the inherited one changes nothing", async () => {
    const inherited = { ...INHERITED, temperature: 0.1 };
    const spec = coderAgent(dir);
    const explicit = await agent(spec, inherited);
    const implicit = await agent({ ...spec, settings: { reasoningEffort: "medium" } }, inherited);

    expect(implicit.hash).toBe(explicit.hash);
  });

  it("ignores transport settings the model never sees (timeoutMs)", async () => {
    const spec = coderAgent(dir);

    expect((await agent({ ...spec, settings: { ...spec.settings, timeoutMs: 5_000 } })).hash).toBe(
      baseline.hash,
    );
  });

  it("ignores key order inside requestFields", async () => {
    const spec = coderAgent(dir);
    const one = { ...spec, settings: { ...spec.settings, requestFields: { top_p: 0.9, seed: 7 } } };
    const two = { ...spec, settings: { ...spec.settings, requestFields: { seed: 7, top_p: 0.9 } } };

    expect((await agent(one)).hash).toBe((await agent(two)).hash);
  });

  it("treats MODEL_MAX as sending no max_tokens at all", async () => {
    const spec = coderAgent(dir);
    const noCap: ModelSettings = { ...INHERITED, maxTokens: undefined };

    expect(
      (await agent({ ...spec, settings: { ...spec.settings, maxTokens: MODEL_MAX } })).hash,
    ).toBe((await agent(spec, noCap)).hash);
  });

  it("ignores the order routes are listed in", async () => {
    const spec = mainRouter(dir);
    const reversed = { ...spec, routes: [...spec.routes].reverse() };

    expect(fingerprintOf(await assembleRouter(reversed, INHERITED)).hash).toBe(
      fingerprintOf(await assembleRouter(spec, INHERITED)).hash,
    );
  });
});
