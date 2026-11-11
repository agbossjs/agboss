// #811 — serves the conformance application for the official A2A TCK on 127.0.0.1: the real
// `a2aHttpListener` behind a loopback adapter that names each message's TCK scenario in a header
// (`TCK_SCENARIO_HEADER`, from its messageId — the TCK's in-band signal), the body passed on as it
// came, but a `message-response` send's, which names the direct-reply skill (#860). Run: `npx tsx tests/a2a-tck/tck-serve.ts [port]`; it prints `tck-sut ready <url>`.
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { a2aHttpListener } from "../../src/a2a/a2a-http.js";
import { A2A_SKILLS_EXTENSION } from "../../src/a2a/a2a-extension-uris.js";
import { createApp } from "../../src/application/create-app.js";
import type { App } from "../../src/app/types.js";
import {
  TCK_SCENARIO_HEADER,
  TckA2AExpose,
  TckApplication,
  TckCallerResolver,
} from "./tck.application.js";

/**
 * The scenario a TCK messageId names: `tck-<scenario>-<session>` (the session 8 hex digits, the
 * TCK's `tck_id`; `-<n>` after it with `tck-defects.patch`, one id per message), `test-resubscribe-…`
 * for its long task; `undefined` for any other.
 */
export function scenarioOfMessageId(messageId: string): string | undefined {
  const tck = /^tck-(.+?)-[0-9a-f]{8}(?:-\d+)?$/.exec(messageId);
  if (tck?.[1] !== undefined) return tck[1];
  return messageId.startsWith("test-resubscribe") ? "resubscribe" : undefined;
}

/** The scenario a direct-reply skill answers (#860, DM-MSG-001), and that skill. */
export const MESSAGE_SCENARIO = "message-response";
const MESSAGE_SKILL = "tck-message-workflow-start";

/**
 * The body as the listener gets it: a `message-response` send names the direct-reply skill in its
 * message's metadata (`A2A_SKILLS_EXTENSION`), which the TCK does not; any other body as it came.
 */
export function routedBody(body: Buffer): Buffer {
  if (scenarioOfBody(body) !== MESSAGE_SCENARIO) return body;
  const parsed = JSON.parse(body.toString("utf8")) as {
    params: { message: { metadata?: Record<string, unknown> } };
  };
  const { message } = parsed.params;
  message.metadata = { ...message.metadata, [A2A_SKILLS_EXTENSION]: { skill: MESSAGE_SKILL } };
  return Buffer.from(JSON.stringify(parsed), "utf8");
}

/** The scenario of a JSON-RPC send's body; `undefined` for anything else. */
export function scenarioOfBody(body: Buffer): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    const params: unknown = Reflect.get(Object(parsed), "params");
    const message: unknown = Reflect.get(Object(params), "message");
    const messageId: unknown = Reflect.get(Object(message), "messageId");
    return typeof messageId === "string" ? scenarioOfMessageId(messageId) : undefined;
  } catch {
    return undefined; // not JSON: the listener answers it
  }
}

const bodyOf = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });

const listening = (server: Server, port: number): Promise<number> =>
  new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : port);
    });
  });

/** Hop-by-hop headers, never passed on (the adapter sends the whole body with its length). */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "te"]);

/** A request the adapter could not pass on: said on stderr, `502` when nothing was answered yet. */
function dropped(req: IncomingMessage, res: ServerResponse, error: unknown): void {
  process.stderr.write(
    `tck-sut: ${String(req.method)} ${String(req.url)} dropped: ${String(error)}\n`,
  );
  if (res.headersSent) res.destroy();
  else res.writeHead(502).end();
}

/**
 * Passes one request on to the listener: its headers but the hop-by-hop ones and any scenario a
 * caller claims, the scenario its messageId names, its body as it came; the answer streamed back.
 */
function forward(port: number, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(
      ([name]) => name !== TCK_SCENARIO_HEADER && !HOP_BY_HOP.has(name),
    ),
  );
  const scenario = req.method === "POST" ? scenarioOfBody(body) : undefined;
  const out = request(
    {
      host: "127.0.0.1",
      port,
      method: req.method,
      path: req.url,
      headers: {
        ...headers,
        "content-length": String(body.length),
        ...(scenario === undefined ? {} : { [TCK_SCENARIO_HEADER]: scenario }),
      },
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  out.on("error", (error) => {
    dropped(req, res, error);
  });
  res.on("close", () => out.destroy());
  out.end(body);
}

/** A served conformance agent: its URL and how to stop it. */
export interface TckSut {
  readonly url: string;
  readonly app: App;
  readonly close: () => Promise<void>;
}

/** Serves the conformance application on `127.0.0.1:<port>` (`0`: any free port). */
export async function serveTckSut(port = 0): Promise<TckSut> {
  const app = await createApp(TckApplication, { env: "test" });
  const front = createServer();
  const url = `http://127.0.0.1:${String(await listening(front, port))}`;
  const listener = a2aHttpListener(app, {
    expose: TckA2AExpose,
    callerResolver: TckCallerResolver,
    publicUrl: url,
  });
  const inner = createServer(listener);
  const innerPort = await listening(inner, 0);
  front.on("request", (req, res) => {
    bodyOf(req)
      .then((body) => {
        forward(innerPort, req, res, req.method === "POST" ? routedBody(body) : body);
      })
      .catch((error: unknown) => {
        dropped(req, res, error);
      });
  });
  const close = async (): Promise<void> => {
    for (const server of [front, inner]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    await app.close();
  };
  return { url, app, close };
}

const isMain = process.argv[1]?.endsWith("tck-serve.ts") === true;
if (isMain) {
  const sut = await serveTckSut(Number(process.argv[2] ?? "9999"));
  process.stdout.write(`tck-sut ready ${sut.url}\n`);
  const stop = (): void => {
    sut.close().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(`tck-sut: could not close: ${String(error)}\n`);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
