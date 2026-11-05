import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext, OptionValues } from "../../src/cli/context.js";
import { exportNameOf } from "../../src/cli/studio-config.js";
import { listenForServer, pipePathOf } from "../../src/cli/studio-ipc.js";
import {
  DEFAULT_STUDIO_URL,
  serverEnvOf,
  studioServerOptionsOf,
  watchedFilesOf,
} from "../../src/cli/studio-server.js";
import { portOf, prepareStudio, studioServerOf, studioServerScript } from "../../src/cli/studio.js";
import { agboss, fixture } from "./agboss.js";

/**
 * #268 AC7: `agboss studio` — no `studio.ts` / `langgraph.json` in the project; the config written
 * into `.agboss/`, every workflow of the application served, a child drawn inside its parent.
 */

const STUDIO = fixture("cli/studio/studio.workflow.ts");
const cliRoot = fileURLToPath(new URL("../..", import.meta.url));
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

  it("#666 / #671: a project reached through a symlink still loads its application in the module", async () => {
    const root = project();
    const real = join(root, "deep", "er", "project");
    mkdirSync(real, { recursive: true });
    const linked = join(root, "linked");
    symlinkSync(real, linked, "dir");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-placeholder");

    const studio = await prepareStudio(contextOf(linked, {}));

    // Node resolves a relative import from the importer's real path (no --preserve-symlinks)
    const [, specifier] = /from "(\.\.\/[^"]*studio\.workflow\.js)"/.exec(
      readFileSync(studio.entry, "utf8"),
    ) ?? ["", ""];
    const resolved = resolve(dirname(realpathSync(studio.entry)), specifier);
    expect(realpathSync(resolved.replace(/\.js$/, ".ts"))).toBe(realpathSync(STUDIO));
    expect(await drawn(studio.entry, "studioOneWorkflow")).toEqual(
      expect.arrayContaining(["studio-item-workflow:check-item-action"]),
    );
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

describe("#268 AC7, #791: the LangGraph dev server on the written config", () => {
  it("runs this Node on studio-server (on @langchain/langgraph-api), with --config and --port", async () => {
    const cwd = project();
    const context = contextOf(cwd, { port: "2077" });
    const studio = await prepareStudio(context);

    const line = studioServerOf(studio, portOf(context));

    expect(line.command).toBe(process.execPath);
    // from source: tsx registered for the .ts script
    const [flag, loader, script, ...args] = line.args;
    expect([flag, loader]).toEqual(["--import", "tsx"]);
    expect(script).toBe(fileURLToPath(new URL("../../src/cli/studio-server.ts", import.meta.url)));
    expect(existsSync(script ?? "")).toBe(true);
    expect(args).toEqual(["--config", join(cwd, ".agboss/langgraph.json"), "--port", "2077"]);
  });

  it("the built package runs the built script, with no loader", () => {
    const built = pathToFileURL(join(cliRoot, "dist/cli/studio.js")).href;

    expect(studioServerScript(built)).toBe(join(cliRoot, "dist/cli/studio-server.js"));
  });

  it("studio-server reads --config (made absolute) and --port (2024 by default)", () => {
    expect(studioServerOptionsOf(["--config", "x/langgraph.json", "--port", "2077"])).toEqual({
      config: resolve("x/langgraph.json"),
      port: "2077",
    });
    expect(studioServerOptionsOf(["--config", "/p/langgraph.json"]).port).toBe("2024");
    expect(() => studioServerOptionsOf(["--port", "1"])).toThrow("--config <file> is required");
  });

  it("the config's env file is read under the process's variables, which win", () => {
    const folder = project();
    writeFileSync(join(folder, ".env"), "FROM_FILE=file\nBOTH=file\n");
    const config = { graphs: {}, env: "./.env" };

    const env = serverEnvOf(config, folder, { BOTH: "process" });

    expect(env).toEqual({ FROM_FILE: "file", BOTH: "process" });
    expect(watchedFilesOf(join(folder, "langgraph.json"), config)).toEqual([
      join(folder, "langgraph.json"),
      join(folder, ".env"),
    ]);
  });

  it("a missing env file and an env object: the server starts on what there is", () => {
    const folder = project();

    expect(serverEnvOf({ graphs: {}, env: "./.env" }, folder, { A: "1" })).toEqual({ A: "1" });
    expect(serverEnvOf({ graphs: {}, env: { B: "2" } }, folder, { A: "1" })).toEqual({
      A: "1",
      B: "2",
    });
    expect(serverEnvOf({ graphs: {} }, folder, { A: "1" })).toEqual({ A: "1" });
    expect(watchedFilesOf("/p/langgraph.json", { graphs: {} })).toEqual(["/p/langgraph.json"]);
  });

  it("the pipe the server reports on is langgraph-api's: <tmp>/tsx-<uid>/<pid>.pipe", () => {
    const path = pipePathOf(1234);

    expect(path).toBe(join(tmpdir(), `tsx-${String(process.geteuid?.())}`, "1234.pipe"));
    expect(DEFAULT_STUDIO_URL).toBe("https://smith.langchain.com");
  });

  it("a message on that pipe reaches the listener, one per length-prefixed frame", async () => {
    const messages: unknown[] = [];
    const server = await listenForServer((message) => messages.push(message));
    const frame = (value: unknown): Buffer => {
      const body = Buffer.from(JSON.stringify(value));
      const length = Buffer.alloc(4);
      length.writeInt32BE(body.length, 0);
      return Buffer.concat([length, body]);
    };
    const socket = createConnection(pipePathOf(process.pid));
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    // a message split across writes, a frame that is no JSON (ignored), then a second message
    const first = frame({ queryParams: "baseUrl=http://localhost:2024" });
    socket.write(first.subarray(0, 6));
    socket.write(
      Buffer.concat([
        first.subarray(6),
        frame("x").subarray(0, 4),
        Buffer.from("{{{"),
        frame({ n: 2 }),
      ]),
    );
    try {
      await vi.waitFor(() => {
        expect(messages).toHaveLength(2);
      });
    } finally {
      socket.destroy();
      server.close();
    }

    expect(messages).toEqual([{ queryParams: "baseUrl=http://localhost:2024" }, { n: 2 }]);
  });

  it.each([
    ["send-offer-workflow", "sendOfferWorkflow"],
    ["vendor-check-workflow", "vendorCheckWorkflow"],
    ["v2-workflow", "v2Workflow"],
    ["2fa-workflow", "_2faWorkflow"],
  ])("the graph of %s is the export %s", (workflow, exported) => {
    expect(exportNameOf(workflow)).toBe(exported);
  });
});
