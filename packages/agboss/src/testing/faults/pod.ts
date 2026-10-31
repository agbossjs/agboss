import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { systemClock } from "../../infrastructure/clock.js";
import { seconds, type Milliseconds } from "../../units/index.js";
import { TIME_ORIGIN_VARIABLE, TIME_SCALE_VARIABLE } from "./fault-clock.js";
import type { OperationEvent } from "./operation-history.js";
import {
  POD_VARIABLES,
  type FromPod,
  type GatewayCall,
  type PodCommand,
  type PodEvent,
} from "./pod-protocol.js";

/**
 * A fault pod as its test drives it (#484): a `node` child running `pod-main`, with an IPC channel.
 * `command` sends a command and resolves with its ack; `next` waits for an event the pod sent (or
 * sent already), bounded — past the deadline it fails, naming what it waited for and what came;
 * the signals are real: `term` (SIGTERM), `kill` (SIGKILL), `stop` / `cont` (SIGSTOP / SIGCONT).
 */

/** How long a pod's wait lasts by default before it fails (real time). */
export const POD_WAIT: Milliseconds = seconds(120);

/** What starts a pod. */
export interface PodLaunch {
  readonly name: string;
  /** The store set's module. */
  readonly stores: string;
  /** The database's address for this pod. */
  readonly databaseUrl: string;
  readonly timeScale: number;
  readonly timeOrigin: number;
  readonly shutdownTimeout?: Milliseconds | undefined;
  readonly maxConcurrentSteps?: number | undefined;
  /** Each store operation the pod reports (the run's history). */
  readonly onOperation: (event: OperationEvent) => void;
  /** Each event the pod sends (its replies too). */
  readonly onEvent: (pod: FaultPod, event: PodEvent) => void;
  /** Each call of the pod to the test's gateway; the test answers it with `answerGateway`. */
  readonly onGateway: (pod: FaultPod, id: number, call: GatewayCall) => void;
}

/** A wait of a pod that ran past its deadline. */
export class FaultWaitError extends Error {
  override name = "FaultWaitError";
}

/** How a pod's process ended. */
export interface PodExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** The pod's entry: the compiled `pod-main.js` next to this file, else its source (tests). */
const podScript = (): string => {
  const compiled = fileURLToPath(new URL("./pod-main.js", import.meta.url));
  return existsSync(compiled) ? compiled : compiled.replace(/\.js$/u, ".ts");
};

/** The pods still running, killed by `killPods`. */
const running = new Set<ChildProcess>();

/** SIGKILLs every pod still running (a test's end, an abort). */
export function killPods(): void {
  for (const child of running) child.kill("SIGKILL");
  running.clear();
}

/** The last characters of a pod's output, for a failure's message. */
const TAIL = 4000;

export class FaultPod {
  readonly events: PodEvent[] = [];
  readonly exited: Promise<PodExit>;
  instanceId = "";
  #output = "";
  #commands = 0;
  readonly #watchers = new Set<() => void>();

  constructor(
    readonly name: string,
    private readonly child: ChildProcess,
    launch: PodLaunch,
  ) {
    this.exited = new Promise((resolve) => {
      child.on("exit", (code, signal) => {
        running.delete(child);
        resolve({ code, signal });
        this.#notify();
      });
    });
    const keep = (chunk: Buffer): void => {
      this.#output = (this.#output + chunk.toString()).slice(-TAIL);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("message", (message: FromPod) => {
      this.#received(message, launch);
    });
  }

  /** Its process id. */
  get pid(): number {
    return this.child.pid ?? -1;
  }

  /** Whether its process has ended. */
  get isRunning(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  #received(message: FromPod, launch: PodLaunch): void {
    if (message.kind === "operation") launch.onOperation(message.event);
    else if (message.kind === "gateway") launch.onGateway(this, message.id, message.call);
    else {
      const event: PodEvent =
        message.kind === "event"
          ? message.event
          : { type: "reply", id: message.id, result: message.result, error: message.error };
      this.events.push(event);
      launch.onEvent(this, event);
    }
    this.#notify();
  }

  #notify(): void {
    for (const watch of [...this.#watchers]) watch();
  }

  /**
   * The first event `matches` accepts, sent already or to come; past `timeout` (real time) — or
   * when the pod's process ends first — a `FaultWaitError` naming `what`.
   */
  async next(
    what: string,
    matches: (event: PodEvent) => boolean,
    timeout: Milliseconds = POD_WAIT,
  ): Promise<PodEvent> {
    const deadline = new AbortController();
    const found = new Promise<PodEvent | undefined>((resolve) => {
      const look = (): void => {
        const event = this.events.find(matches);
        if (event === undefined && this.isRunning && !deadline.signal.aborted) return;
        this.#watchers.delete(look);
        resolve(event);
      };
      this.#watchers.add(look);
      void systemClock.sleep(timeout, deadline.signal).then(() => {
        deadline.abort();
        look();
      });
      look();
    });
    const event = await found;
    deadline.abort();
    if (event !== undefined) return event;
    const why = this.isRunning ? `within ${String(timeout / 1000)} s` : "before its process ended";
    throw new FaultWaitError(
      `pod ${this.name}: no ${what} ${why}; its events: ${JSON.stringify(this.events.slice(-40))}; its output: ${this.#output}`,
    );
  }

  /** Sends `command` and resolves with its ack's result (rejects with its error). */
  async command(command: PodCommand, timeout: Milliseconds = POD_WAIT): Promise<unknown> {
    this.#commands += 1;
    const id = this.#commands;
    this.child.send({ kind: "command", id, command });
    const reply = await this.next(
      `ack of ${command.op}`,
      (e) => e.type === "reply" && e.id === id,
      timeout,
    );
    if (typeof reply.error === "string")
      throw new Error(`pod ${this.name}: ${command.op} failed: ${reply.error}`);
    return reply.result;
  }

  /** Answers the pod's gateway call `id`. */
  answerGateway(id: number, answer: { readonly result?: unknown; readonly error?: string }): void {
    if (this.isRunning) this.child.send({ kind: "gateway-reply", id, ...answer });
  }

  /** SIGTERM: the platform stops the pod; it drains as `app.close()` does. */
  term(): void {
    this.child.kill("SIGTERM");
  }

  /** SIGKILL: no hook runs, its leases are never released. Resolves once its process ended. */
  async kill(): Promise<PodExit> {
    this.child.kill("SIGKILL");
    return this.exited;
  }

  /** SIGSTOP: frozen where it is — no timer, no renewal, no write — until `cont`. */
  stop(): void {
    this.child.kill("SIGSTOP");
  }

  /** SIGCONT: it runs on from where it froze, its timers late. */
  cont(): void {
    this.child.kill("SIGCONT");
  }

  /** Its output's last characters (a failure's message). */
  get output(): string {
    return this.#output;
  }
}

/** The environment of a pod's process. */
const podEnvironment = (launch: PodLaunch): NodeJS.ProcessEnv => ({
  ...process.env,
  [POD_VARIABLES.name]: launch.name,
  [POD_VARIABLES.stores]: launch.stores,
  [POD_VARIABLES.database]: launch.databaseUrl,
  [POD_VARIABLES.shutdownTimeout]: launch.shutdownTimeout?.toString() ?? "",
  [POD_VARIABLES.maxConcurrentSteps]: launch.maxConcurrentSteps?.toString() ?? "",
  [TIME_SCALE_VARIABLE]: String(launch.timeScale),
  [TIME_ORIGIN_VARIABLE]: String(launch.timeOrigin),
});

/** Starts a pod and waits until it is ready. */
export async function launchPod(launch: PodLaunch): Promise<FaultPod> {
  // tsx, a dependency of the core: the pod imports a store set written in TypeScript
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const child = spawn(process.execPath, ["--import", loader, podScript()], {
    env: podEnvironment(launch),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  running.add(child);
  const pod = new FaultPod(launch.name, child, launch);
  const ready = await pod.next("ready", (event) => event.type === "ready");
  pod.instanceId = String(ready.instanceId);
  return pod;
}
