/**
 * #120 PR 4 — prompts are normalised at load and the normalised text is sent (and fingerprinted):
 * no BOM, line breaks as `\n`, no blank lines at the edges, Unicode NFC; indentation, spaces and
 * tabs inside a line and blank lines between paragraphs kept; `promptUrls` parts joined with one
 * blank line. Guardrails' and compactions' prompts load through the same loader.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalisePromptText, PromptLoader } from "../../src/components/prompt-render.js";

const dir = mkdtempSync(join(tmpdir(), "agboss-120-prompts-"));
const source = join(dir, "owner.ts");
writeFileSync(join(dir, "first.prompt.md"), "﻿\r\n\r\nFirst part,\r\n  indented.\r\n\r\n");
writeFileSync(join(dir, "second.prompt.md"), "\n\tSecond part.\n\n\nStill second.\n");
writeFileSync(join(dir, "blank.prompt.md"), "\n  \n\t\n");

const load = (prompt: string | undefined, promptUrls: readonly string[] = []): Promise<string> =>
  new PromptLoader().load({
    label: '@Guardrail "test-guardrail"',
    options: { ...(prompt === undefined ? {} : { prompt }), promptUrls },
    source,
  });

describe("#120 PR 4: prompts are normalised at load", () => {
  it("removes the BOM, CRLF and the blank lines at the edges; keeps what is inside", () => {
    expect(normalisePromptText("﻿\r\n \n  Keep\tthis  line\r\n\r\n\r\nand this.\n\t\n")).toBe(
      "  Keep\tthis  line\n\n\nand this.",
    );
  });

  it("is Unicode NFC: a decomposed accent is composed", () => {
    expect(normalisePromptText("Café")).toBe("Café");
  });

  it("a blank prompt is empty", () => {
    expect(normalisePromptText("\n \t\r\n")).toBe("");
  });

  it("the inline prompt and the files are each normalised and joined with one blank line", async () => {
    const text = await load("\n  Inline first.\n", ["first.prompt.md", "second.prompt.md"]);

    expect(text).toBe(
      "  Inline first.\n\nFirst part,\n  indented.\n\n\tSecond part.\n\n\nStill second.",
    );
  });

  it("a blank file adds no blank line", async () => {
    expect(await load("Only this.", ["blank.prompt.md"])).toBe("Only this.");
  });
});
