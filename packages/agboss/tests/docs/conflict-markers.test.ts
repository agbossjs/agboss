/**
 * No tracked Markdown or TypeScript file carries an unresolved merge-conflict marker: a rebase that
 * kept a hunk of both sides once left them in wiki/Configuration.md, and nothing noticed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { outputOf } from "../helpers/process.js";
import { repo } from "./docs-check.js";

// built from parts, so that this file holds no marker itself
const OPEN = new RegExp(`^${"<".repeat(7)}( |$)`, "m");
const CLOSE = new RegExp(`^${">".repeat(7)}( |$)`, "m");

describe("merge-conflict markers", () => {
  it("no tracked .md or .ts file has an opening or closing marker line", async () => {
    const tracked = (await outputOf("git", ["ls-files", "-z", "*.md", "*.ts"], { cwd: repo }))
      .split("\0")
      .filter((file) => file !== "");
    const marked = tracked.filter((file) => {
      const text = readFileSync(join(repo, file), "utf8");
      return OPEN.test(text) || CLOSE.test(text);
    });
    expect(marked).toEqual([]);
  });
});
