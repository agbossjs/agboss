/**
 * #305 AC1: every name of the skill matrix (`coverage.ts`) appears in its skill file and is exported
 * by an API report — the skill files name only what the installed package has.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SKILL_COVERAGE } from "./coverage.js";

const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));
const SKILL = join(PACKAGE, "skills", "agboss");
const API = join(PACKAGE, "api");

const reports: string = readdirSync(API)
  .filter((file) => file.endsWith(".api.md"))
  .map((file) => readFileSync(join(API, file), "utf8"))
  .join("\n");

const EXPORT = (name: string): RegExp =>
  new RegExp(
    `^export (?:declare )?(?:abstract )?(?:function|class|const|interface|type|enum) ${name}\\b`,
    "mu",
  );

const MENTION = (name: string): RegExp => new RegExp(`(?<![\\w$])${name}(?![\\w$])`, "u");

describe("#305 AC1: the skill matrix", () => {
  it.each(Object.entries(SKILL_COVERAGE))("%s names its matrix entries", (file, names) => {
    const text: string = readFileSync(join(SKILL, file), "utf8");

    const missing: string[] = names.filter((name) => !MENTION(name).test(text));

    expect(missing).toEqual([]);
  });

  it("every matrix name is exported by an API report", () => {
    const names: string[] = [...new Set(Object.values(SKILL_COVERAGE).flat())];

    const unexported: string[] = names.filter((name) => !EXPORT(name).test(reports));

    expect(unexported).toEqual([]);
  });
});
