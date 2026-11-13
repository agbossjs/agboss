/** #1004 AC5, #1006 AC5: the READMEs say what `onStream` carries and what it never carries. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repo } from "./docs-check.js";

const READMES = ["README.md", "packages/agboss/README.md"];
const HEADING = "#### What `onStream` carries";

/** The section's text: from its heading to the next heading. */
function sectionOf(file: string): string {
  const text = readFileSync(join(repo, file), "utf8");
  const start = text.indexOf(HEADING);
  expect(start, `${file} has the section`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + HEADING.length);
  const next = rest.search(/\n#{1,4} /);
  return (next === -1 ? rest : rest.slice(0, next)).replace(/\s+/g, " ");
}

describe.each(READMES)("#1004 AC5: %s", (file) => {
  it("names the answer and the tool calls as what the stream carries", () => {
    const section = sectionOf(file);
    expect(section).toContain("textDelta");
    expect(section).toContain("toolCall");
    expect(section).toContain("answering model call");
  });

  it("names every internal kind as never carried", () => {
    const section = sectionOf(file);
    for (const kind of [
      "routers",
      "judges",
      "guardrails",
      "arbiters",
      "PII",
      "compaction",
      "rerankers",
      "reply interpreters",
      "launch deciders",
      "eval judges",
    ]) {
      expect(section, kind).toContain(kind);
    }
    expect(section).toContain("never carries");
    expect(section).toContain("output");
  });
});

describe.each(READMES)("#1006 AC5: %s", (file) => {
  it("says streamed text is provisional, when it is retracted and what is held back", () => {
    const text = readFileSync(join(repo, file), "utf8").replace(/\s+/g, " ");
    expect(text).toContain("Streamed text is **provisional**");
    for (const reason of [
      "judge-rejected",
      "tool-turn",
      "invalid-answer",
      "stream-broken",
      "failed",
    ]) {
      expect(text, reason).toContain(reason);
    }
    expect(text).toContain("blocking output check");
    expect(text).toContain("cannot be switched off");
    expect(text).toContain("append: false");
  });
});
