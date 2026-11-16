/**
 * The child of `child-channel.test.ts` (#1128): `noisy` logs around its result, `barrier` waits for `go`;
 * (#1225) `leaks` keeps a TCP server open after its result and `slow` only a pending timer: the first is
 * reported as lingering, the second is not.
 */
import { connect, createServer } from "node:net";
import { nextFromParent, report, reportIfSocketLingers } from "./child-channel.js";

const mode = process.argv[2];
if (mode === "noisy") {
  process.stdout.write('{"level":"warn","msg":"slow start"}\n');
  process.stderr.write("(node) DeprecationWarning: deprecated\n");
  await report({ answer: 42 });
  process.stdout.write("{half a line");
} else if (mode === "barrier") {
  await report("ready");
  await nextFromParent();
  await report("went");
} else if (mode === "leaks" || mode === "slow") {
  await report({ answer: 1 });
  if (mode === "leaks") {
    // a connected pair: the client end is the open TCP socket
    const server = createServer((peer) => peer.on("error", () => undefined)).listen(
      0,
      "127.0.0.1",
      () => {
        const { port } = server.address() as { port: number };
        connect(port, "127.0.0.1").on("error", () => undefined);
      },
    );
  } else setTimeout(() => undefined, 1500);
  reportIfSocketLingers(300);
}
