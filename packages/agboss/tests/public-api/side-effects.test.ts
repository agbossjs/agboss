/**
 * #195: importing the root entry `agboss` has no side effects — no tracing (Langfuse,
 * OpenTelemetry), no MCP SDK, no SQLite, no `.env`, no environment reads by package code and no open
 * handles. Each import runs in a fresh Node process on `dist`, the package as a user installs it.
 * #205: the import stays lean — a module budget, and nothing of the `agboss` CLI (agboss-cli).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runNode } from "../helpers/process.js";

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
/**
 * Modules the root import may load (1,149 at #205; the decorators entry loaded 3,769 before; 1,500
 * at #340 for its public names; 1,505 at #807 for the A2A task store's contract, its in-memory
 * default and the execution-control seams — the SQLite store is in `@agboss/core/a2a`, the
 * projection and the tree reads load on first use); 1,510 at #795 for the outbound-call contract's
 * module; 1,511 at #824 for the assembly rule that keeps an application's A2A tasks where its
 * instances share them, `[a2a.task-store-not-shared]`; 1,523 at #825, after #809, for the business
 * keys' fingerprints and idempotency keys, the keys the framework made, the paged listing, the
 * reconciliation's verdicts, the key fields' and the store descriptors' rules (each its own module
 * under the line limits). #834: the application's retention group, the environment fields'
 * helpers, createApp's own options and how a refused value is shown (each its own module under the
 * line limits); 1,532 at #817: a usage record's ledger state, the cost categories and a restored
 * state's usage, modules of their own; 1,533 at #847: the SQLite audit log in
 * its own module, beside its lease store (the line limits); 1,534 at #853: a lost pass's records on
 * the visit path and the cost sources, modules of their own (its recovery-side reader loads on
 * first use); 1,543 at #859: the A2A files' contract with its inline default, the `A2AFiles`
 * service, the file DTOs, options and errors, the storage tier's assembly rule and the client's file
 * parts, modules of their own (the service's work, the url fetch, the media checks and the client's
 * download load on first use); 1,544 with #889's audit log beside it; 1,546 at #890:
 * `FencedEffects`, the fenced effect's app-facing service (a core service the container makes, so
 * never loaded lazily; the store's module is at its line limit), and a workflow's container options
 * (`app/workflow-lifecycle.ts`: a workflow on its own runs it on its infrastructure's store), modules
 * of their own.; 1,549 at #860: the direct A2A
 * messages' store contract and its in-memory default (a built-in contract's default is resolved at
 * the root, as every store's) and the direct-reply skills' assembly rule — the server's reply path,
 * the SQLite store, the sweep and the client's retention load on first use.
 */
const MODULE_BUDGET = 1_549;

async function importInFreshProcess(module: string): Promise<Probe> {
  const probe = join(dir, "probe.mjs");
  writeFileSync(probe, PROBE);
  const run = await runNode([probe, module], {
    env: { ...process.env, LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk", TERN_DB: "x" },
  });
  expect(run.stderr).toBe("");
  return JSON.parse(run.stdout) as Probe;
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the root entry has no side effects (#195)", () => {
  it("loads no tracing, MCP, SQLite or .env, reads no env variable and opens no handle", async () => {
    expect(existsSync(new URL("index.js", dist)), "build the package first: npm run build").toBe(
      true,
    );

    const root = await importInFreshProcess(fileURLToPath(new URL("index.js", dist)));

    expect(root.exports).toEqual(
      expect.arrayContaining(["createApp", "Agent", "Workflow", "start"]),
    );
    expect(root.loaded.filter((url) => FORBIDDEN.test(url))).toEqual([]);
    expect(root.reads).toEqual([]);
    expect(root.after).toEqual(root.before);
  });

  it("#205 AC1: stays under the module budget and loads nothing of the CLI", async () => {
    const root = await importInFreshProcess(fileURLToPath(new URL("index.js", dist)));

    expect(root.loaded.length).toBeLessThan(MODULE_BUDGET);
    expect(root.loaded.filter((url) => CLI_ONLY.test(url))).toEqual([]);
    expect(root.loaded.filter((url) => url.endsWith("/dist/internal.js"))).toEqual([]);
  });

  it("the probe sees modules and env reads: agboss/mcp loads the MCP SDK", async () => {
    const mcp = await importInFreshProcess(fileURLToPath(new URL("mcp/index.js", dist)));
    const reader = join(dir, "reader.mjs");
    writeFileSync(reader, "export const key = process.env.LANGFUSE_PUBLIC_KEY;\n");

    expect((await importInFreshProcess(reader)).reads).toEqual(["LANGFUSE_PUBLIC_KEY"]);

    expect(mcp.loaded.some((url) => url.includes("node_modules/@modelcontextprotocol/sdk/"))).toBe(
      true,
    );
  });
});
