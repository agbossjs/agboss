import { relative, resolve } from "node:path";
import { requiredText, type CommandContext, type CommandOutcome } from "../../cli/context.js";
import { usageError } from "../../cli/errors.js";
import { stopSignal } from "../../cli/stop-signal.js";
import { startLocalUi } from "../../eval/ui/ui-server.js";
import { meshOf } from "../mesh.js";
import { readHubInputs } from "../read-inputs.js";
import { respondToHub } from "./hub-routes.js";

/**
 * `agboss hub ui <path…> [--port N]` (#401 PR 6, S2 Q6): the Hub served on 127.0.0.1 behind a token
 * it prints, on `agboss eval ui`'s own server (`startLocalUi`), read-only, until Ctrl+C. The paths
 * are read once before it listens (a bad file fails at once, exit 3) and again on every request.
 */

const COMMAND = "hub ui";

/** `--port N`: 0 (a free port) to 65535. */
function portOf(context: CommandContext): number {
  const given = requiredText(context.values, "port");
  const port = Number(given);
  if (Number.isInteger(port) && port >= 0 && port <= 65_535) return port;
  throw usageError(COMMAND, "usage.option-value", `--port must be 0–65535, got "${given}"`);
}

export async function hubUiCommand(context: CommandContext): Promise<CommandOutcome> {
  const paths = context.positionals.slice(1);
  if (paths.length === 0)
    throw usageError(COMMAND, "usage.missing-argument", "expected agboss hub ui <path…>");
  const port = portOf(context);
  const mesh = meshOf(readHubInputs(context.io.cwd, paths));
  const cwd = context.io.cwd;
  const ui = await startLocalUi({
    name: "agboss hub ui",
    port,
    respond: (request, served) => respondToHub(request, { ...served, cwd, paths }),
  });
  context.say(`hub ui: ${ui.url}   (Ctrl+C to stop)`);
  const shown = paths.map((path) => relative(cwd, resolve(cwd, path)) || ".").join(", ");
  context.say(`inputs: ${shown} · ${String(mesh.applications.length)} applications`);
  const { signal, release } = stopSignal();
  try {
    await new Promise<void>((done) => {
      signal.addEventListener("abort", () => {
        done();
      });
    });
  } finally {
    release();
    await ui.close();
  }
  return { result: { paths, port: ui.port } };
}
