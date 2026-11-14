import type { ServerResponse } from "node:http";
import type { Clock } from "../../infrastructure/clock.js";
import { seconds } from "../../units/index.js";

/**
 * Server-sent events on a socket that may be slow or idle (#1008). A write the socket did not take
 * waits for `drain` before the next event is pulled — the run never waits, only this subscriber's
 * own loop —, an idle stream says `: keep-alive` so a proxy with an idle timeout does not cut it,
 * and a reader that takes nothing for `SSE_DRAIN_TIMEOUT` is cut.
 */

/**
 * How often an idle stream writes a comment, on the application's clock: under the 30-60 s idle
 * timeouts of the common proxies (nginx's default is 60 s).
 */
export const SSE_KEEP_ALIVE = seconds(15);

/** How long one write may wait for the socket to drain before the reader is cut. */
export const SSE_DRAIN_TIMEOUT = seconds(60);

/** The SSE comment line a keep-alive is: a client ignores it. */
export const KEEP_ALIVE_COMMENT = ": keep-alive\n\n";

/** `false` when the connection is gone (or was cut for not reading): write no more. */
export async function writeSse(res: ServerResponse, chunk: string, clock: Clock): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(chunk)) return true;
  const stop = new AbortController();
  const gone = new Promise<boolean>((resolve) => {
    const done = (): void => {
      resolve(!res.destroyed);
    };
    res.once("drain", done);
    res.once("close", done);
    res.once("error", done);
    stop.signal.addEventListener(
      "abort",
      () => {
        res.off("drain", done);
        res.off("close", done);
        res.off("error", done);
      },
      { once: true },
    );
  });
  const timeout = clock.sleep(SSE_DRAIN_TIMEOUT, stop.signal).then(
    () => false,
    () => true,
  );
  const drained = await Promise.race([gone, timeout]);
  stop.abort();
  if (!drained) res.destroy();
  return drained;
}

/**
 * The stream's next event: while it is not there, a keep-alive comment every `SSE_KEEP_ALIVE`.
 * `undefined` when the connection went while it waited.
 */
export async function nextWithKeepAlive<T>(
  res: ServerResponse,
  pending: Promise<T>,
  clock: Clock,
): Promise<T | undefined> {
  for (;;) {
    const tick = new AbortController();
    const idle = clock.sleep(SSE_KEEP_ALIVE, tick.signal).then(
      () => undefined,
      () => undefined,
    );
    const winner = await Promise.race([pending.then((value) => ({ value })), idle]);
    tick.abort();
    if (winner !== undefined) return winner.value;
    if (!(await writeSse(res, KEEP_ALIVE_COMMENT, clock))) return undefined;
  }
}
