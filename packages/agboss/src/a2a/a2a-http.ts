import { MAX_DEADLINE, timerProblemOf } from "../units/timer-limits.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { executionControlOf } from "../app/execution-control.js";
import type { Class } from "../components/injection.js";
import { componentOf, ComponentError } from "../components/metadata.js";
import { A2ATaskRepository } from "../infrastructure/a2a-task.repository.js";
import { Clock, IdGenerator, lazyLoad } from "../infrastructure/clock.js";
import { frameworkLogOf, Logger } from "../infrastructure/logger.js";
import { kilobytes, type Bytes, type Milliseconds } from "../units/index.js";
import type { A2AApp } from "./a2a-caller.js";
import {
  authenticatorOf,
  notifyHost,
  writeRejection,
  type ListenerAuthenticator,
} from "./a2a-caller-gate.js";
import { exportsOf } from "./a2a-exports.js";
import { meshSettingsOf, type MeshSettings } from "../mesh/mesh-settings.js";
import type { A2AHttpBinding } from "./server/a2a-jsonrpc-http.js";
import type { ServedSkill } from "./server/a2a-skills.js";
import type { A2ADirectParts } from "./server/a2a-server-parts.js";
import type { A2AExposeOptions } from "./a2a-expose.decorator.js";
import { A2ADirectMessageRepository } from "../infrastructure/a2a-direct-message.repository.js";
import { interfaceUrlOf } from "./a2a-public-url.js";
import { serverFilesOf } from "./files/a2a-server-files.js";

/** `a2aHttpListener(app, { expose, authenticator, publicUrl, base?, provider?, onError?, maxBodySize?, maxTaskDuration? })` (#387, #808, #1316). */
export interface A2AHttpListenerOptions {
  /**
   * What it serves (#398 PR 3): an `@A2AExpose` listed in `@Application({ exposes })` — its
   * exported starts are the agent's skills.
   */
  readonly expose: Class;
  /**
   * Who calls (an `@HttpAuthenticator` listed in `@Application({ services })`): the listener takes
   * its instance from the application's container when it is created and asks it on every request.
   * Its `schemes` are the card's `securitySchemes`.
   */
  readonly authenticator: Class;
  /** Who runs the agent: the card's `provider`. */
  readonly provider?: { readonly organization: string; readonly url: string };
  /**
   * Told of an error the listener or the authenticator hit (an authenticator that threw, a request
   * that failed past its own answers) with the request: for the host's own logging; its text never
   * goes on the wire. An error `onError` throws is ignored.
   */
  readonly onError?: (error: unknown, req: IncomingMessage) => void;
  /**
   * Where callers reach the listener, an absolute URL without the `base` (`https://billing.example`):
   * the card's interface URL is `publicUrl` + `base`. An environment text field in practice.
   */
  readonly publicUrl: string;
  /** The listener's path (`"/a2a"` → `POST /a2a`, the card at `/a2a/.well-known/agent-card.json`); default none. */
  readonly base?: string;
  /**
   * The largest request body read: over it → `413`, nothing run. By default `kilobytes(1024)`, or
   * more when a skill takes files (#859): room for its `maxTotalFileSize` as base64 and 256 KB more.
   */
  readonly maxBodySize?: Bytes;
  /** Every task's execution deadline (`DeadlineExceededError` past it): a task outlives its request; at most 24 days (`[a2a.timeout-invalid]`, #1141). */
  readonly maxTaskDuration?: Milliseconds;
}

const HTTP_UNAVAILABLE = 503;
const LISTENER_UNAVAILABLE = { code: "a2a.listener-failed", error: "the agent is not available" };

const nameOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/** The default `maxBodySize`: 1 MB. */
const MAX_BODY_SIZE = kilobytes(1024);

/**
 * The listener's `maxBodySize` (#859): as given, else 1 MB — or, when a skill takes more files, its
 * largest `maxTotalFileSize` as base64 (4 bytes for 3) and 256 KB for the rest of the message.
 */
export function maxBodySizeOf(
  given: Bytes | undefined,
  skills: readonly Pick<ServedSkill, "inputFiles" | "fileLimits">[],
): Bytes {
  if (given !== undefined) return given;
  const largest = Math.max(
    0,
    ...skills.flatMap((skill) =>
      skill.inputFiles.length === 0 ? [] : [skill.fileLimits.maxTotalFileSize],
    ),
  );
  return Math.max(MAX_BODY_SIZE, Math.ceil((largest * 4) / 3) + kilobytes(256)) as Bytes;
}

/** `maxTaskDuration` bounds a timer: above their maximum, `[a2a.timeout-invalid]` (#1141). */
function checkedListenerTimers(options: A2AHttpListenerOptions): void {
  const problems = [
    options.maxTaskDuration === undefined
      ? undefined
      : timerProblemOf("maxTaskDuration", options.maxTaskDuration, MAX_DEADLINE),
  ].filter((problem) => problem !== undefined);
  if (problems.length > 0)
    throw new ComponentError({
      message: `[a2a.timeout-invalid] a2aHttpListener's ${problems.join("; ")}`,
    });
}

/** The server's modules, loaded with the first request (the root import stays lean). */
const serverModules = () =>
  Promise.all([
    lazyLoad(import("./server/a2a-skills.js")),
    lazyLoad(import("./server/a2a-card.js")),
    lazyLoad(import("./server/a2a-request-handler.js")),
    lazyLoad(import("./server/a2a-local-runs.js")),
  ]);

/** What an app `createApp` or `testWith` built has: its mesh settings and its trees' control. */
function builtAppOf(app: A2AApp) {
  const mesh = meshSettingsOf(app);
  const control = executionControlOf(app);
  if (mesh === undefined || control === undefined)
    throw new ComponentError({
      message: "[a2a.app-required] a2aHttpListener serves an app createApp or testWith built",
    });
  return { mesh, control };
}

/** The options of an `@A2AExpose` (`exportsOf` checked it is one). */
function exposeOptionsOf(expose: Class): A2AExposeOptions {
  const meta = componentOf(expose);
  if (meta?.kind !== "a2a-expose")
    throw new ComponentError({ message: "[a2a.not-an-expose] not an @A2AExpose" });
  return meta.meta;
}

/** What the listener's direct-reply skills work with (#860): the replies and the default skill. */
const directPartsOf = (
  app: A2AApp,
  skills: readonly ServedSkill[],
  defaultSkill: Class | undefined,
): A2ADirectParts => ({
  messages: app.resolve(A2ADirectMessageRepository),
  defaultSkill: skills.find((skill) => skill.start === defaultSkill),
});

/** What the card says besides the expose and the skills: the application, the URL, the retention, who runs it. */
function cardSourceOf(
  mesh: MeshSettings,
  options: A2AHttpListenerOptions,
  checked: { readonly authenticator: ListenerAuthenticator; readonly url: string },
) {
  return {
    application: mesh.application,
    url: checked.url,
    idempotencyRetention: mesh.a2aTaskRetention,
    messageIdempotencyRetention: mesh.a2aMessageRetention,
    schemes: checked.authenticator.meta.schemes,
    ...(options.provider === undefined ? {} : { provider: options.provider }),
  };
}

/** Builds what the listener serves with, on its first request: the card, the handler, the stores. */
async function bindingOf(
  app: A2AApp,
  options: A2AHttpListenerOptions,
  checked: {
    readonly authenticator: ListenerAuthenticator;
    readonly exports: readonly Class[];
    readonly url: string;
  },
): Promise<A2AHttpBinding> {
  const [{ servedSkillsOf }, { agentCardOf }, { A2AServerRequestHandler }, { LocalRuns }] =
    await serverModules();
  const { mesh, control } = builtAppOf(app);
  const expose = exposeOptionsOf(options.expose);
  const sources = { contracts: await mesh.contracts(), workflows: mesh.workflows, expose };
  const skills = servedSkillsOf(checked.exports, sources);
  const clock = app.resolve(Clock);
  const card = agentCardOf({
    ...cardSourceOf(mesh, options, checked),
    expose,
    skills,
    madeAt: clock.now(),
  });
  const log = frameworkLogOf(app.resolve(Logger), clock);
  const parts = {
    app,
    tasks: app.resolve(A2ATaskRepository),
    control,
    clock,
    ids: app.resolve(IdGenerator),
    skills,
    runs: new LocalRuns(log),
    log,
    maxTaskDuration: options.maxTaskDuration,
    mesh,
    files: serverFilesOf(app, options),
    direct: directPartsOf(app, skills, expose.defaultSkill),
  };
  return {
    card,
    handler: new A2AServerRequestHandler(parts, card.card),
    authenticator: checked.authenticator.instance,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    mesh,
    log: parts.log,
    base: options.base ?? "",
    maxBodySize: maxBodySizeOf(options.maxBodySize, skills),
  };
}

/**
 * Serves an application's `@A2AExpose` as an A2A v1.0 agent (#387, #808), for
 * `http.createServer(a2aHttpListener(app, { expose, authenticator, publicUrl, base }))`: its Agent
 * Card at `<base>/.well-known/agent-card.json` and the JSON-RPC binding at `POST <base>` —
 * `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`
 * (push methods `-32003`). Every request's caller is authenticated by the `authenticator` the
 * application's container created (not listed → this call throws), after its body is read and
 * parsed for its operation and task — nothing of it acted on before: a refused one is a real `401` /
 * `403` (a resolver that throws: `500`), and nothing runs. Each task is one root execution under the
 * task's id, kept in the application's `A2ATaskRepository`: a message resent with the same
 * `messageId` finds its task, a task outlives its connection — a caller that disconnects never
 * cancels it —, and `CancelTask` cancels that task alone.
 */
export function a2aHttpListener(
  app: A2AApp,
  options: A2AHttpListenerOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  checkedListenerTimers(options);
  const authenticator = authenticatorOf(app, options.authenticator);
  const exports = exportsOf(app, options.expose);
  const url = interfaceUrlOf(options.publicUrl, options.base ?? "");
  const log = frameworkLogOf(app.resolve(Logger), app.resolve(Clock));
  let binding: Promise<A2AHttpBinding> | undefined;
  const http = () => lazyLoad(import("./server/a2a-jsonrpc-http.js"));
  const bound = (): Promise<A2AHttpBinding> => {
    binding ??= bindingOf(app, options, { authenticator, exports, url }).catch((error: unknown) => {
      binding = undefined; // built again by the next request
      throw error;
    });
    return binding;
  };
  return (req, res) => {
    const served = Promise.all([bound(), http()]).then(([ready, { serveA2AHttp }]) =>
      serveA2AHttp(ready, req, res),
    );
    served.catch((error: unknown) => {
      // a failure past the binding's own answers (its build, a broken socket): logged by its class
      // (a framework error by its own fixed text), never an error's text on the wire
      const what = error instanceof ComponentError ? error.message : nameOf(error);
      log.error("a2a.listener-failed", `the A2A listener failed to serve a request: ${what}`);
      notifyHost(options.onError, error, req);
      if (res.headersSent) res.destroy();
      else writeRejection(res, HTTP_UNAVAILABLE, LISTENER_UNAVAILABLE);
    });
  };
}
