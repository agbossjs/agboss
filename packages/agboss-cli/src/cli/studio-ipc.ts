import { mkdir, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";

/**
 * How the LangGraph server tells `studio-server` it is up (#791): the IPC of tsx that
 * `@langchain/langgraph-api`'s entrypoint connects to — a pipe named by the parent's pid, one
 * length-prefixed JSON message (`{ queryParams }`) once the server listens. `langgraphjs dev` opened
 * the same pipe.
 */

/**
 * The pipe the server's entrypoint reports its query string on once it listens (tsx's IPC, which
 * `@langchain/langgraph-api` connects to under `<tmp>/tsx-<uid>/<pid>.pipe`).
 */
export function pipePathOf(processId: number): string {
  const user = process.geteuid === undefined ? userInfo().username : String(process.geteuid());
  const path = join(tmpdir(), `tsx-${user}`, `${String(processId)}.pipe`);
  return process.platform === "win32" ? `\\\\?\\pipe\\${path}` : path;
}

/** Listens on this process's pipe; `onMessage` gets each length-prefixed JSON message. */
export async function listenForServer(onMessage: (message: unknown) => void): Promise<Server> {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length > 4) {
        const length = buffer.readInt32BE(0);
        if (buffer.length < 4 + length) break;
        const text = buffer.subarray(4, 4 + length).toString();
        buffer = buffer.subarray(4 + length);
        try {
          onMessage(JSON.parse(text));
        } catch {
          // not a message of the server's: ignored
        }
      }
    });
  });
  const path = pipePathOf(process.pid);
  await mkdir(dirname(path), { recursive: true });
  // a pipe left by an earlier process of the same pid, ended abnormally
  await rm(path, { force: true });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(path, done);
  });
  server.unref();
  process.once("exit", () => {
    server.close();
    if (process.platform !== "win32") void rm(path, { force: true }).catch(() => undefined);
  });
  return server;
}
