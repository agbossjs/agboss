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
