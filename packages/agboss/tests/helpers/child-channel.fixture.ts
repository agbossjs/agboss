/** The child of `child-channel.test.ts` (#1128): `noisy` logs around its result, `barrier` waits for `go`. */
import { nextFromParent, report } from "./child-channel.js";

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
}
