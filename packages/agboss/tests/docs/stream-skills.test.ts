/** #1050 AC4: no skill or README example writes `event.delta` without handling `discarded`. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repo } from "./docs-check.js";

const SKILLS = join(repo, "packages/agboss/skills");

/** Every markdown file under `dir`. */
function markdownOf(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(entry.parentPath, entry.name));
}

const FILES = [
  join(repo, "README.md"),
  join(repo, "packages/agboss/README.md"),
  ...markdownOf(SKILLS),
];

/** The fenced code blocks of a markdown text. */
const blocksOf = (text: string): string[] =>
  [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1] ?? "");

/** The blocks of the files that read a delta of the stream. */
const streamingBlocks = FILES.flatMap((file) =>
  blocksOf(readFileSync(file, "utf8"))
    .filter((block) => /\bevent\.delta\b/.test(block))
    .map((block) => ({ file, block })),
);

describe("#1050: examples that read the stream's text handle its retraction", () => {
  it("finds the examples (a rename of the pattern must not empty the check)", () => {
    expect(streamingBlocks.length).toBeGreaterThanOrEqual(2);
  });

  it.each(streamingBlocks)("an example in $file handles `discarded`", ({ block }) => {
    expect(block).toMatch(/discarded/);
    expect(block).not.toMatch(/process\.stdout\.write\(event\.delta\)/);
  });
});

describe("#1050: the skills' streaming reference", () => {
  const text = readFileSync(
    join(SKILLS, "agboss/references/03-components-di-and-lifecycle.md"),
    "utf8",
  ).replace(/\s+/g, " ");

  it("states the event kinds, the provisional text, the hold-back, the PII reveal and the listener code", () => {
    for (const part of [
      "textDelta",
      "discarded",
      "toolCall",
      "judge-rejected",
      "provisional",
      "blocking output check",
      "revealed",
      "only the agent's own answering call streams",
      "stream.listener-failed",
    ])
      expect(text, part).toContain(part);
  });
});

describe("#1050 AC3: the READMEs and the error catalog name `stream.listener-failed`", () => {
  it.each([
    "README.md",
    "packages/agboss/README.md",
    "packages/agboss/skills/agboss/references/11-cli-studio-and-error-catalog.md",
  ])("%s", (file) => {
    expect(readFileSync(join(repo, file), "utf8")).toContain("stream.listener-failed");
  });
});
