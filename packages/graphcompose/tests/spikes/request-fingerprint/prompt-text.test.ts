import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { CODER_PROMPT, promptFolder } from "./fixture.js";
import { BOM, joinPromptParts, loadPrompt, normalizePrompt } from "./prompt-text.js";

const LF = `${CODER_PROMPT}\n`;

describe("spike #115 — prompt text normalisation (applied at load; sent and hashed alike)", () => {
  it.each([
    ["CRLF line endings", LF.replace(/\n/g, "\r\n")],
    ["old Mac CR line endings", LF.replace(/\n/g, "\r")],
    ["trailing spaces and tabs", LF.replace(/\n/g, "  \t\n")],
    ["no final newline", CODER_PROMPT],
    ["extra blank lines at both ends", `\n\n${CODER_PROMPT}\n\n\n`],
    ["a UTF-8 BOM", `${BOM}${LF}`],
  ])("treats %s as the same prompt", (_name, variant) => {
    expect(normalizePrompt(variant)).toBe(normalizePrompt(LF));
  });

  it("treats decomposed (NFD) and composed (NFC) accents as the same prompt", () => {
    expect(normalizePrompt("café")).toBe(normalizePrompt("café"));
  });

  it.each([
    ["indentation", LF.replace("- keep", "  - keep")],
    ["a double space inside a line", LF.replace("small", " small")],
    ["a tab instead of spaces", LF.replace("- keep", "-\tkeep")],
    ["a blank line removed between paragraphs", LF.replace("# Coder\n\n", "# Coder\n")],
    ["one word", LF.replace("small", "tiny")],
  ])("keeps %s: the model sees it", (_name, variant) => {
    expect(normalizePrompt(variant)).not.toBe(normalizePrompt(LF));
  });

  it("joins inline prompt and promptUrls parts with one blank line, skipping empty parts", () => {
    expect(joinPromptParts(["first  \r\n", "", "\nsecond"])).toBe("first\n\nsecond");
  });

  it("reads promptUrls relative to the component, in the given order", async () => {
    const dir = await promptFolder({ "a.md": "A\r\n", "b.md": "B\n" });

    const prompt = await loadPrompt(
      pathToFileURL(join(dir, "agent.ts")).href,
      ["./b.md", "./a.md"],
      "inline",
    );

    expect(prompt).toBe("inline\n\nB\n\nA");
  });
});
