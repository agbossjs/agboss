import { applicationOf } from "../../../src/application/assemble.js";
import { buildApplication } from "../../../src/application/create-app.js";
import type { ExecutionOutput } from "../../../src/app/types.js";
import type { Class } from "../../../src/components/injection.js";
import { McpStubs, stubbedMcpConnect } from "../../../src/testing/mcp-stubs.js";
import { ScriptBook } from "../../../src/testing/script-book.js";
import { createScriptedGateway } from "../../../src/testing/scripted-gateway.js";
import { Cassette } from "../../../src/testing/vcr-cassette.js";
import { vcrGateway } from "../../../src/testing/vcr.js";
import { ChatStart, DeskApplication } from "./desk.workflow.js";
import { execute } from "../../helpers/flow.js";

/**
 * Records a run of Desk into `file` the way `vcr: { mode: RECORD }` does, with the scripted
 * models standing in for the real providers (no key here): what replay must reproduce.
 */
export function recordDesk(
  file: string,
  text: string,
  script: (book: ScriptBook) => void,
): Promise<ExecutionOutput> {
  return recordRun({ application: DeskApplication, start: ChatStart }, file, text, script);
}

/** Records a run of any workflow from `start` into `file`, the scripted models standing in. */
export async function recordRun(
  { application, start }: { readonly application: Class; readonly start: Class },
  file: string,
  text: string,
  script: (book: ScriptBook) => void,
): Promise<ExecutionOutput> {
  const book = new ScriptBook();
  script(book);
  const { app } = await buildApplication(await applicationOf(application), {
    processEnv: {},
    gateway: vcrGateway(Cassette.recording(file), () => createScriptedGateway(book)),
    connectMcp: stubbedMcpConnect(new McpStubs(book), new Map(), new Set()),
    newRunId: () => "run-1",
  });
  try {
    return await execute(app, start, { text });
  } finally {
    await app.close();
  }
}
