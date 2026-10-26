import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext, OptionValues } from "../../src/cli/context.js";
import { exportNameOf } from "../../src/cli/studio-config.js";
import { langGraphDevOf, portOf, prepareStudio } from "../../src/cli/studio.js";
import { agboss, fixture } from "./agboss.js";

/**
 * #268 AC7: `agboss studio` — no `studio.ts` / `langgraph.json` in the project; the config written
 * into `.agboss/`, every workflow of the application served, a child drawn inside its parent.
 */

const STUDIO = fixture("cli/studio/studio.workflow.ts");
const KEY = { OPENROUTER_API_KEY: "sk-placeholder" };

const projects: string[] = [];
const project = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "agboss-studio-"));
  projects.push(directory);
  return directory;
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of projects.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A `studio` call's context, as the CLI builds it (TypeScript already compiled by vitest). */
function contextOf(
  cwd: string,
  values: OptionValues,
  env: NodeJS.ProcessEnv = KEY,
): CommandContext {
  const said: string[] = [];
  return {
    command: "studio",
    values: { application: STUDIO, port: "2024", ...values },
    positionals: [],
    json: false,
    io: {
      stdout: { write: (text: string) => said.push(text) },
      stderr: { write: (text: string) => said.push(text) },
      env,
      cwd,
      registerTypeScript: false,
    },
    say: (line: string) => said.push(line),
    warn: (line: string) => said.push(line),
  };
}

/** The node ids Studio draws for an export of the generated module (`GET …/graph?xray=true`). */
async function drawn(entry: string, exported: string): Promise<readonly string[]> {
  const module = (await import(pathToFileURL(entry).href)) as Record<
    string,
    { getGraphAsync: (config: { xray: boolean }) => Promise<{ nodes: Record<string, unknown> }> }
  >;
  const graph = module[exported];
  if (graph === undefined) throw new Error(`${entry} exports no ${exported}`);
  return Object.keys((await graph.getGraphAsync({ xray: true })).nodes);
}

describe("#268 AC7: the Studio config in .agboss/", () => {
  it("writes .agboss/studio.ts and .agboss/langgraph.json: one graph per workflow, children too", async () => {
    const cwd = project();

    const studio = await prepareStudio(contextOf(cwd, {}));

    expect(studio.workflows).toEqual([
      "studio-items-workflow",
      "studio-item-workflow",
      "studio-one-workflow",
      "split-workflow",
    ]);
    expect(studio.config).toBe(join(cwd, ".agboss/langgraph.json"));
    expect(JSON.parse(readFileSync(studio.config, "utf8"))).toEqual({
      node_version: "22",
      graphs: {
        "studio-items-workflow": "./studio.ts:studioItemsWorkflow",
        "studio-item-workflow": "./studio.ts:studioItemWorkflow",
        "studio-one-workflow": "./studio.ts:studioOneWorkflow",
        "split-workflow": "./studio.ts:splitWorkflow",
      },
    });
    const entry = readFileSync(join(cwd, ".agboss/studio.ts"), "utf8");
    expect(entry).toContain('import { studioOf } from "@agboss/core/internal";');
    expect(entry).toMatch(/import \{ StudioApplication \} from "\.\.\/.*\/studio\.workflow\.js";/);
    expect(entry).toContain("const studio = await studioOf(StudioApplication);");
    expect(entry).toContain(
      'export const studioItemsWorkflow = studio.graph("studio-items-workflow");',
    );
  });

  it("the generated module serves the graphs: children inside their parent, ThisWorkflow a node", async () => {
    const cwd = project();
    vi.stubEnv("OPENROUTER_API_KEY", "sk-placeholder");

    const studio = await prepareStudio(contextOf(cwd, {}));
    const perItem = await drawn(studio.entry, "studioItemsWorkflow");
    const one = await drawn(studio.entry, "studioOneWorkflow");
    const recursive = await drawn(studio.entry, "splitWorkflow");

    expect(perItem).toEqual(expect.arrayContaining(["studio-item-workflow:check-item-action"]));
    expect(one).toEqual(expect.arrayContaining(["studio-item-workflow:check-item-action"]));
    expect(recursive).toContain("this-workflow");
    expect(recursive.filter((id) => id.startsWith("this-workflow:"))).toEqual([]);
  });

  it("--env <name> is written into the module; the project's .env into langgraph.json", async () => {
    const cwd = project();
    writeFileSync(join(cwd, ".env"), "OPENROUTER_API_KEY=sk-placeholder\n");

    const studio = await prepareStudio(
      contextOf(cwd, { env: "prod" }, { PROD_OPENROUTER_API_KEY: "sk-placeholder" }),
    );

    expect(readFileSync(studio.entry, "utf8")).toContain(
      'const studio = await studioOf(StudioApplication, { env: "prod" });',
    );
    expect(JSON.parse(readFileSync(studio.config, "utf8"))).toMatchObject({ env: "../.env" });
  });

  it("a variable the environment needs is missing: exit 3 before any server, nothing written", async () => {
    const cwd = project();

    const call = await agboss(["studio", "--application", STUDIO, "--env", "prod"], cwd);

    expect(call.code).toBe(3);
    expect(call.stderr).toContain("agboss studio: PROD_OPENROUTER_API_KEY is not set");
    expect(existsSync(join(cwd, ".agboss"))).toBe(false);
  });

  it("--port must be a port: exit 2 before anything is loaded", async () => {
    const call = await agboss(["studio", "--application", STUDIO, "--port", "eighty"], project());

    expect(call.code).toBe(2);
    expect(call.stderr).toContain('--port must be 1–65535, got "eighty"');
  });
});

describe("#268 AC7: the LangGraph dev server on the written config", () => {
  it("runs this Node on the langgraphjs script of @langchain/langgraph-cli, with --config and --port", async () => {
    const cwd = project();
    const context = contextOf(cwd, { port: "2077" });
    const studio = await prepareStudio(context);

    const line = langGraphDevOf(studio, portOf(context));

    expect(line.command).toBe(process.execPath);
    const [script, ...args] = line.args;
    expect(script).toMatch(/@langchain\/langgraph-cli\/dist\/cli\/cli\.mjs$/);
    expect(existsSync(script ?? "")).toBe(true);
    expect(args).toEqual([
      "dev",
      "--config",
      join(cwd, ".agboss/langgraph.json"),
      "--port",
      "2077",
    ]);
  });

  it.each([
    ["job-scout-workflow", "jobScoutWorkflow"],
    ["vendor-check-workflow", "vendorCheckWorkflow"],
    ["v2-workflow", "v2Workflow"],
    ["2fa-workflow", "_2faWorkflow"],
  ])("the graph of %s is the export %s", (workflow, exported) => {
    expect(exportNameOf(workflow)).toBe(exported);
  });
});
