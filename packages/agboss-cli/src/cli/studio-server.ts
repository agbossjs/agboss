import type { ChildProcess } from "node:child_process";
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { spawnServer } from "@langchain/langgraph-api";
import { parse, populate } from "dotenv";
import { listenForServer } from "./studio-ipc.js";

/**
 * The LangGraph dev server of `agboss studio` (#791): what `langgraphjs dev --config <file> --port N`
 * of `@langchain/langgraph-cli` did, on `@langchain/langgraph-api` alone — `langgraph-cli` also
 * carries the template download of `langgraphjs new` (`create-langgraph`, `extract-zip`, which has
 * advisories and no fixed release) that Studio never needs. Run as a child of `agboss studio`:
 * `node studio-server.js --config .agboss/langgraph.json --port N`.
 *
 * As `langgraphjs dev`: the config's `env` file read into the server's environment, the server
 * started by `spawnServer` on `localhost` (10 jobs per worker, reloaded by tsx on a source change),
 * restarted when the config or its env file changes, `.langgraph_api` added to the config folder's
 * `.gitignore`, and LangGraph Studio opened in the browser once the server is up (not when
 * `BROWSER=none`). Unlike it: no usage analytics are sent, and a server that exits on its own ends
 * this process with its code.
 */

/** The Studio host when the LangSmith endpoint gives none (`langgraphjs dev`'s default). */
export const DEFAULT_STUDIO_URL = "https://smith.langchain.com";

/** How long a stopped server may take to exit before it is killed. */
const STOP_GRACE_MS = 10_000;

/** The written config, as far as this process reads it. */
export interface StudioServerConfig {
  readonly graphs: Readonly<Record<string, string>>;
  readonly env?: string | Readonly<Record<string, string>>;
  readonly [key: string]: unknown;
}

/** `--config <file> --port N`: the config, absolute, and the port. */
export interface StudioServerOptions {
  readonly config: string;
  readonly port: string;
}

export function studioServerOptionsOf(argv: readonly string[]): StudioServerOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: { config: { type: "string" }, port: { type: "string", default: "2024" } },
    strict: true,
  });
  if (values.config === undefined) throw new Error("studio-server: --config <file> is required");
  return { config: resolve(values.config), port: values.port };
}

/** The config's own variables — its `env` file (relative to the config) or object — over `base`. */
export function serverEnvOf(
  config: StudioServerConfig,
  folder: string,
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...base };
  if (typeof config.env === "string") {
    const file = resolve(folder, config.env);
    let text: string | undefined;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      process.stderr.write(
        `studio-server: env file "${config.env}" not found, continuing without it\n`,
      );
    }
    if (text !== undefined) populate(env, parse(text));
  } else if (config.env !== undefined) populate(env, { ...config.env });
  return env;
}

/** The files whose change restarts the server: the config and its env file. */
export const watchedFilesOf = (path: string, config: StudioServerConfig): readonly string[] =>
  typeof config.env === "string" ? [path, resolve(dirname(path), config.env)] : [path];

/**
 * The module `specifier` as `@langchain/langgraph-api` resolves it: `langsmith` and `open` are its
 * dependencies, so they are found wherever npm put them.
 */
async function importFromLangGraphApi<T>(specifier: string): Promise<T> {
  const require = createRequire(import.meta.url);
  const api = createRequire(require.resolve("@langchain/langgraph-api/package.json"));
  return (await import(pathToFileURL(api.resolve(specifier)).href)) as T;
}

/** The Studio host: the one LangSmith derives from `LANGSMITH_ENDPOINT` / `LANGCHAIN_ENDPOINT`. */
async function studioUrlOf(env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { Client } = await importFromLangGraphApi<{
      Client: new (config: { apiUrl?: string }) => { getHostUrl(): string };
    }>("langsmith");
    // an empty variable is no endpoint, as for langgraphjs dev
    const apiUrl = [env.LANGSMITH_ENDPOINT, env.LANGCHAIN_ENDPOINT].find(
      (url) => url !== undefined && url !== "",
    );
    const host = new Client({ apiUrl }).getHostUrl();
    return host === "" ? DEFAULT_STUDIO_URL : host;
  } catch {
    return DEFAULT_STUDIO_URL;
  }
}

/** `.langgraph_api` (the server's local state) in the config folder's `.gitignore`. */
async function ignoreServerState(folder: string): Promise<void> {
  const path = join(folder, ".gitignore");
  const text = await readFile(path, "utf8").catch(() => "");
  if (!text.includes(".langgraph_api"))
    await appendFile(path, "\n# LangGraph API\n.langgraph_api\n");
}

/** Studio in the browser at `hostUrl`, with the server's query string (`?baseUrl=…`). */
function openStudio(hostUrl: string, queryParams: string): void {
  const query = new URLSearchParams(queryParams).toString();
  void importFromLangGraphApi<{ default: (target: string) => Promise<unknown> }>("open")
    .then(async (open) => open.default(`${hostUrl}/studio${query === "" ? "" : `?${query}`}`))
    .catch(() => undefined);
}

/** The server of one `--config`: started, restarted on a change, stopped with this process. */
class StudioServer {
  private child: ChildProcess | undefined;
  private hostUrl = DEFAULT_STUDIO_URL;
  private isStopping = false;
  private hasOpened = false;
  private isBrowserOff = process.env.BROWSER === "none";
  private watched: readonly string[] = [];
  /** Launches one after another: two quick changes never start two servers. */
  private launches: Promise<void> = Promise.resolve();

  constructor(private readonly options: StudioServerOptions) {}

  private get folder(): string {
    return dirname(this.options.config);
  }

  async start(): Promise<void> {
    await listenForServer((message) => {
      const queryParams = (message as { queryParams?: unknown }).queryParams;
      if (typeof queryParams !== "string" || this.isBrowserOff || this.hasOpened) return;
      this.hasOpened = true;
      openStudio(this.hostUrl, queryParams);
    });
    await ignoreServerState(this.folder);
    process.on("SIGINT", this.stop);
    process.on("SIGTERM", this.stop);
    process.once("exit", () => this.child?.kill());
    await this.relaunch();
  }

  private relaunch(): Promise<void> {
    this.launches = this.launches.then(async () => this.launch());
    return this.launches;
  }

  private watch(config: StudioServerConfig): void {
    for (const file of this.watched) unwatchFile(file);
    this.watched = watchedFilesOf(this.options.config, config);
    for (const file of this.watched)
      watchFile(file, { interval: 500 }, (now, before) => {
        if (now.mtimeMs === before.mtimeMs || this.isStopping) return;
        process.stderr.write(`studio-server: ${file} changed, restarting the server\n`);
        void this.relaunch().catch((error: unknown) => {
          process.stderr.write(`studio-server: the restart failed: ${messageOf(error)}\n`);
        });
      });
  }

  private async launch(): Promise<void> {
    const config = JSON.parse(await readFile(this.options.config, "utf8")) as StudioServerConfig;
    const env = serverEnvOf(config, this.folder, process.env);
    this.watch(config);
    this.hostUrl = await studioUrlOf(env);
    this.isBrowserOff = process.env.BROWSER === "none" || env.BROWSER === "none";
    const previous = this.child;
    this.child = undefined;
    if (previous !== undefined) await stopped(previous);
    if (this.isStopping) return;
    const started = await spawnServer(
      { host: "localhost", port: this.options.port, nJobsPerWorker: "10", reload: true },
      { config, env, hostUrl: this.hostUrl },
      { pid: process.pid, projectCwd: this.folder },
    );
    this.child = started;
    started.once("exit", (code, signal) => {
      // replaced by a restart, or stopped with this process: not the end
      if (this.child !== started || this.isStopping) return;
      process.exit(code ?? (signal === null ? 0 : 1));
    });
  }

  private readonly stop = (signal: NodeJS.Signals): void => {
    if (this.isStopping) return;
    this.isStopping = true;
    for (const file of this.watched) unwatchFile(file);
    const running = this.child;
    if (running === undefined) process.exit(0);
    running.kill(signal);
    void stopped(running).then(() => process.exit(0));
  };
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Runs the server until this process is stopped (exit 0) or the server exits on its own. */
export async function runStudioServer(argv: readonly string[]): Promise<void> {
  await new StudioServer(studioServerOptionsOf(argv)).start();
}

/** Resolves once `server` has exited; killed when it takes longer than the grace period. */
function stopped(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return Promise.resolve();
  return new Promise<void>((done) => {
    const timer = setTimeout(() => server.kill("SIGKILL"), STOP_GRACE_MS);
    server.once("exit", () => {
      clearTimeout(timer);
      done();
    });
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runStudioServer(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`studio-server: the server did not start: ${messageOf(error)}\n`);
    process.exit(1);
  });
}
