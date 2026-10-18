import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ListOfText, OneOf, Text } from "./dto.js";
import type { AgentSpec, ModelSettings, RouterSpec, ToolSpec } from "./request.js";

/** Spike #115 fixtures: the `coder` agent and `main` router of the #112 example, trimmed. */

export const CODER_PROMPT = [
  "# Coder",
  "",
  "You change code in the repository.",
  "Read a file before you write it.",
  "",
  "- keep changes small",
  "- run the tests after writing",
].join("\n");

/**
 * Pinned fingerprint of `coderAgent`: equal on every machine, Node version, locale and time zone.
 * It moves only with the request — or when zod / LangChain change the wire form of a schema.
 */
export const CODER_FINGERPRINT = "cf2c68054ab4faa47d146c679a78960c5591a923be998f23737a6cfef8548f30";

export const INHERITED: ModelSettings = {
  provider: "openrouter",
  model: "moonshotai/kimi-k2.6",
  temperature: 0.2,
  maxTokens: 8192,
};

export class FileRead {
  @Text({ prompt: "a file or folder, relative to the repository root" })
  path!: string;
}

export class FileWrite {
  @Text({ prompt: "relative to the repository root" })
  path!: string;

  @Text({ prompt: "the whole new content of the file" })
  content!: string;
}

export class TestRun {
  @ListOfText({ prompt: "test files to run; all when empty", optional: true })
  files?: string[];

  @OneOf({ values: ["unit", "integration"], prompt: "which project", default: "unit" })
  project!: "unit" | "integration";
}

/** Writes prompt files into a fresh directory — prompt bytes are exact (no prettier, no git). */
export async function promptFolder(files: Readonly<Record<string, string>>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spike-115-"));
  await Promise.all(
    Object.entries(files).map(([name, text]) => writeFile(join(dir, name), text, "utf8")),
  );
  return dir;
}

export const readRepoTool = (location: string): ToolSpec => ({
  name: "read-repo",
  description: "Reads files and folders of the repository",
  prompt: "Read a file, or list a folder, in the repository (path relative to its root)",
  input: FileRead,
  location,
});

export const writeFileTool = (location: string): ToolSpec => ({
  name: "write-file",
  description: "Writes files into the repository (with approval)",
  prompt: "Write a whole file in the repository (path relative to its root)",
  promptUrls: ["./write-file.prompt.md"],
  input: FileWrite,
  location,
});

export const runTestsTool = (location: string): ToolSpec => ({
  name: "run-tests",
  description: "Runs the test suite",
  prompt: "Run the tests and report failures",
  input: TestRun,
  location,
});

export const coderAgent = (location: string): AgentSpec => ({
  description: "Writes code changes",
  promptUrls: ["./coder.prompt.md"],
  location,
  settings: { temperature: 0.1, reasoningEffort: "medium" },
  tools: [readRepoTool(location), writeFileTool(location), runTestsTool(location)],
});

export const mainRouter = (location: string): RouterSpec => ({
  description: "Chooses who handles the message",
  promptUrls: ["./main.prompt.md"],
  location,
  settings: { model: "jev" },
  routes: [
    { target: "explainer", prompt: "questions about how the code works" },
    { target: "coder", prompt: "requests to change the code" },
    { target: "clarify", prompt: "the request is unclear" },
  ],
});

/** The prompt files of the fixture, LF line endings. */
export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  "coder.prompt.md": `${CODER_PROMPT}\n`,
  "write-file.prompt.md": "Never write outside the repository.\n",
  "main.prompt.md": "Route by what the user wants done, not by the words used.\n",
};
