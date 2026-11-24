import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasPrompt,
  inline,
  isInlinePrompt,
  isPromptFilePath,
  promptPiecesOf,
} from "../../src/components/prompt-source.js";
import type { PromptOptions } from "../../src/components/prompt-options.js";
import { PromptLoader } from "../../src/components/prompt-render.js";
import { fakeDeps } from "../helpers.js";
import { workflowOf } from "../../src/testing/workflow-of.js";
import { executionVersions } from "../../src/run/versions.js";
import { workflowWith, type FlowPrompts } from "./prompts/flows.js";

const asPath = (file: string) => file as `/${string}`;

/** #1347: `PromptSource`, `inline()` and the loader's reading of files. */

describe("#1347a: inline()", () => {
  it("a call keeps the text as given", () => {
    expect(inline("  Classify it.\n  Twice.").text).toBe("  Classify it.\n  Twice.");
    expect(isInlinePrompt(inline("x"))).toBe(true);
    expect(isInlinePrompt({ text: "x" })).toBe(false);
    expect(isInlinePrompt("x")).toBe(false);
  });

  it("a tagged template drops the indentation the lines have in common", () => {
    const prompt = inline`
      Block hostile replies.
        Allow polite refusals.

      Be brief.
    `;

    expect(prompt.text).toBe("\nBlock hostile replies.\n  Allow polite refusals.\n\nBe brief.\n");
  });

  it("a tagged template takes string and number values", () => {
    const board = "LinkedIn";
    expect(inline`  Scout ${board}, top ${3}.`.text).toBe("Scout LinkedIn, top 3.");
  });
});

describe("#1347a: a prompt as pieces", () => {
  it("tells a file from text, in the order written", () => {
    expect(promptPiecesOf(["./a.md", inline("b"), "../c.md", "/d.md"])).toEqual([
      { kind: "file", path: "./a.md" },
      { kind: "text", text: "b" },
      { kind: "file", path: "../c.md" },
      { kind: "file", path: "/d.md" },
    ]);
    expect(promptPiecesOf(undefined)).toEqual([]);
    expect(promptPiecesOf("./a.md")).toEqual([{ kind: "file", path: "./a.md" }]);
  });

  it("a bare string that is no path is its own piece, for the loader to refuse", () => {
    expect(promptPiecesOf("plain text" as never)).toEqual([{ kind: "bare", text: "plain text" }]);
  });

  it("a text with a line break that starts with a slash is text", () => {
    expect(isPromptFilePath("/a.md")).toBe(true);
    expect(isPromptFilePath("/a.md\nmore")).toBe(false);
    expect(isPromptFilePath("a.md")).toBe(false);
  });

  it("says whether a prompt says anything", () => {
    expect(hasPrompt(undefined)).toBe(false);
    expect(hasPrompt(inline(""))).toBe(false);
    expect(hasPrompt("./a.md")).toBe(true);
    expect(hasPrompt(inline("x"))).toBe(true);
  });
});

describe("#1347a: the loader reads parts in order", () => {
  const owner = (options: PromptOptions) => ({
    label: '@Agent "scout-agent"',
    options,
    source: undefined,
  });

  it("an inline prompt needs no declaring file", async () => {
    const loader = new PromptLoader();
    const text = await loader.load(
      owner({
        prompt: inline`
      You scout.
    `,
      }),
    );
    loader.throwIfAny();
    expect(text).toBe("You scout.");
  });

  it("a file path without a declaring file is a problem, not a throw", async () => {
    const loader = new PromptLoader();
    await loader.load(owner({ prompt: "./a.prompt.md" }));
    expect(() => {
      loader.throwIfAny();
    }).toThrow(
      '[prompt.missing-file] @Agent "scout-agent": cannot resolve prompt — the declaring file is unknown',
    );
  });
});

describe("#1347: the hash is that of the joined text: [inline(x), file] renders as inline(x + blank line + the file)", () => {
  async function versionOf(prompts: FlowPrompts): Promise<string> {
    const bundle = await workflowOf(workflowWith(prompts).workflow);
    return executionVersions({
      ...(await fakeDeps({})),
      prompts: bundle.prompts,
      routers: bundle.routers,
    }).promptVersion;
  }

  it("the same texts, the same version, whichever way they are written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prompt-source-"));
    const file = join(dir, "tone.prompt.md");
    await writeFile(file, "Speak plainly about {{boards}}.\n");

    const old = await versionOf({
      agent: { prompt: inline("You scout.\n\nSpeak plainly about {{boards}}.") },
    });
    const next = await versionOf({ agent: { prompt: [inline("You scout."), asPath(file)] } });

    expect(next).toBe(old);
  });

  it("the order of the parts is the order of the text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prompt-source-"));
    const file = join(dir, "tone.prompt.md");
    await writeFile(file, "Speak plainly.\n");

    const fileFirst = await versionOf({ agent: { prompt: [asPath(file), inline("You scout.")] } });
    const inlineFirst = await versionOf({
      agent: { prompt: [inline("You scout."), asPath(file)] },
    });

    expect(fileFirst).not.toBe(inlineFirst);
  });
});
