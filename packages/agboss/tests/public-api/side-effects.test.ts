/**
 * #195: importing the root entry `agboss` has no side effects — no tracing (Langfuse,
 * OpenTelemetry), no MCP SDK, no SQLite, no `.env`, no environment reads by package code and no open
 * handles. Each import runs in a fresh Node process on `dist`, the package as a user installs it.
 * #205: the import stays lean — a module budget, and nothing of the `agboss` CLI (agboss-cli).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const dist = new URL("../../dist/", import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "agboss-side-effects-"));

/** Imports one module, then reports what it loaded, which env variables package code read, handles. */
const PROBE = `import { registerHooks } from "node:module";

const loaded = new Set();
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    loaded.add(resolved.url);
    return resolved;
  },
});

const self = import.meta.url;
/** A read by package code: a frame of a file outside Node itself and outside this probe. */
const byPackageCode = () =>
  (new Error().stack ?? "")
    .split("\\n")
    .slice(2)
    .some((frame) => frame.includes("file://") && !frame.includes(self));

const reads = new Set();
const record = (key) => {
  if (byPackageCode()) reads.add(String(key));
};
process.env = new Proxy(process.env, {
  get: (target, key) => (record(key), Reflect.get(target, key)),
  has: (target, key) => (record(key), Reflect.has(target, key)),
  ownKeys: (target) => (record("*"), Reflect.ownKeys(target)),
});

// stdout / stderr are created on first use: open them first, they are not the package's handles
void [process.stdout, process.stderr];
const before = process.getActiveResourcesInfo();
const api = await import(process.argv[2]);
await new Promise((resolve) => setImmediate(resolve));
const after = process.getActiveResourcesInfo();

process.stdout.write(
  JSON.stringify({ exports: Object.keys(api), loaded: [...loaded], reads: [...reads], before, after }),
);
`;

interface Probe {
  readonly exports: readonly string[];
  readonly loaded: readonly string[];
  readonly reads: readonly string[];
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/** What the root import must never load: tracing, the MCP SDK, SQLite, `.env`, child processes. */
const FORBIDDEN =
  /node_modules\/(@langfuse|@opentelemetry|@modelcontextprotocol|dotenv|langfuse)\/|^node:(sqlite|child_process)$/;

/** What only the CLI or `loadWorkflow` needs: the compiler, tsx, prompts, the OpenAPI parser. */
const CLI_ONLY = /node_modules\/(typescript|tsx|esbuild|@inquirer|@apidevtools)\//;
/** Modules the root import may load (1,149 at #205; the decorators entry loaded 3,769 before). */
const MODULE_BUDGET = 1_400;

function importInFreshProcess(module: string): Probe {
  const probe = join(dir, "probe.mjs");
  writeFileSync(probe, PROBE);
  const run = spawnSync(process.execPath, [probe, module], {
    encoding: "utf8",
    env: { ...process.env, LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", TERN_DB: "x" },
  });
  expect(run.stderr).toBe("");
  return JSON.parse(run.stdout) as Probe;
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the root entry has no side effects (#195)", () => {
  it("loads no tracing, MCP, SQLite or .env, reads no env variable and opens no handle", () => {
    expect(existsSync(new URL("index.js", dist)), "build the package first: npm run build").toBe(
      true,
    );

    const root = importInFreshProcess(fileURLToPath(new URL("index.js", dist)));

    expect(root.exports).toEqual(
      expect.arrayContaining(["createApp", "Agent", "Workflow", "start"]),
    );
    expect(root.loaded.filter((url) => FORBIDDEN.test(url))).toEqual([]);
    expect(root.reads).toEqual([]);
    expect(root.after).toEqual(root.before);
  });

  it("#205 AC1: stays under the module budget and loads nothing of the CLI", () => {
    const root = importInFreshProcess(fileURLToPath(new URL("index.js", dist)));

    expect(root.loaded.length).toBeLessThan(MODULE_BUDGET);
    expect(root.loaded.filter((url) => CLI_ONLY.test(url))).toEqual([]);
    expect(root.loaded.filter((url) => url.endsWith("/dist/internal.js"))).toEqual([]);
  });

  it("the probe sees modules and env reads: agboss/mcp loads the MCP SDK", () => {
    const mcp = importInFreshProcess(fileURLToPath(new URL("mcp/index.js", dist)));
    const reader = join(dir, "reader.mjs");
    writeFileSync(reader, "export const key = process.env.LANGFUSE_PUBLIC_KEY;\n");

    expect(importInFreshProcess(reader).reads).toEqual(["LANGFUSE_PUBLIC_KEY"]);

    expect(mcp.loaded.some((url) => url.includes("node_modules/@modelcontextprotocol/sdk/"))).toBe(
      true,
    );
  });
});
