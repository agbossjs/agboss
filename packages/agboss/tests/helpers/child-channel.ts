/**
 * The child side of the channel a test's child process answers its parent on (#1128): the result
 * goes through Node IPC (`process.send`), never stdout. stdout and stderr stay free for logs — a
 * framework logger warning in the child (a deprecation, a slow-start notice) is one more line
 * there, and a parent that parsed all of stdout as its result broke on it.
 *
 * The parent side is `startNode` / `runNodeReporting` in `process.ts`.
 */

/** Sends `value` to the parent; resolves once Node has handed it to the channel. */
export function report(value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.send === undefined) {
      reject(new Error("report(): this process was not started with an IPC channel"));
      return;
    }
    process.send(value, (error: Error | null) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

/** The next message the parent sends (a barrier: "go"). Only waiting keeps the channel referenced. */
export function nextFromParent(): Promise<unknown> {
  return new Promise((resolve) => {
    process.once("message", resolve);
  });
}

/**
 * After the child's result: says `{ lingering: true }` and exits if a TCP socket is still open
 * `afterMs` later, so a test sees a leaked connection. The timer is unref'd, so it only fires while
 * something keeps the loop alive; and what it looks at is the socket itself, not the time the
 * child took to wind down (#1225: a cold `tsx` compile or a starved process kept the loop alive past
 * a fixed 1.5 s without any socket open, and the test failed on the machine's speed).
 */
export function reportIfSocketLingers(afterMs = 1500): void {
  setTimeout(() => {
    const sockets = process
      .getActiveResourcesInfo()
      .filter((name) => name === "TCPSocketWrap" || name === "TLSWrap");
    if (sockets.length > 0) void report({ lingering: true }).then(() => process.exit(0));
  }, afterMs).unref();
}
