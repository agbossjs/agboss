import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = new URL("../src", import.meta.url).pathname;
const files = (folder: string): string[] => {
  const dir = join(src, folder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? readdirSync(full) : [entry];
  });
};

/** Each folder holds one kind of file, named by its suffix (Angular style); Group A kinds live in `<name>/` subfolders. */
const SUFFIXES: Readonly<Record<string, RegExp>> = {
  agents: /\.(agent\.ts|prompt\.md)$/,
  "workflow-starts": /\.workflow-start\.ts$/,
  routers: /\.(router\.ts|prompt\.md)$/,
  "workflow-finishes": /\.workflow-finish\.ts$/,
  dto: /\.dto\.ts$/,
  tools: /\.(tool(\.test)?|dto)\.ts$/,
  services: /\.service\.ts$/,
  mcp: /\.(mcp-server|mcp-tool|mcp-expose|server|mcp|dto)\.ts$/,
  rag: /\.rag\.ts$/,
  helpers: /\.helper\.ts$/,
  "model-providers": /\.model-provider\.ts$/,
  guardrails: /\.(guardrail\.ts|prompt\.md)$/,
  compactions: /\.(compaction\.ts|prompt\.md)$/,
};

describe("job-scout follows the file conventions (#107)", () => {
  it("AC3: at the top of src/ only the application, the workflow and folders by theme (no Studio entry, #268)", () => {
    // a further workflow (`agboss g workflow <name>`) keeps all its files in src/<name>/ (#197)
    const ownWorkflow = (entry: string): boolean =>
      existsSync(join(src, entry, `${entry}.workflow.ts`));

    expect(
      readdirSync(src)
        .filter((entry) => !ownWorkflow(entry) && entry !== "dto")
        .sort(),
    ).toEqual(
      [
        "agents",
        "compactions",
        "workflow-finishes",
        "config",
        "data",
        "environments",
        "guardrails",
        "helpers",
        "job-scout.application.ts",
        "job-scout.workflow.ts",
        "workflow-starts",
        "mcp",
        "model-providers",
        "rag",
        "routers",
        "scripts",
        "services",
        "tools",
      ].sort(),
    );
  });

  it("AC3: every file in a kind folder carries that kind's suffix", () => {
    for (const [folder, suffix] of Object.entries(SUFFIXES)) {
      for (const file of files(folder)) expect(file, `${folder}/${file}`).toMatch(suffix);
    }
  });

  it("AC3: tools keep only the tool — no module-level helper functions", () => {
    for (const file of files("tools").filter((f) => f.endsWith(".tool.ts"))) {
      const text = readFileSync(join(src, "tools", file), "utf8");
      expect(text, file).not.toMatch(/^(export )?(async )?function /m);
      expect(text, file).not.toMatch(/^(export )?const [a-z]\w* = (async )?\(/m);
    }
  });
});
