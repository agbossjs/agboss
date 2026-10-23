import { applicationOf } from "../../../src/application/assemble.js";
import { buildApplication } from "../../../src/application/create-app.js";
import type { ExecutionOutput } from "../../../src/app/types.js";
import type { Class } from "../../../src/components/injection.js";
import { SequentialIdGenerator } from "../../../src/testing/id-generator.js";
import { McpStubs, stubbedMcpConnect } from "../../../src/testing/mcp-stubs.js";
import { ScriptBook } from "../../../src/testing/script-book.js";
import { createScriptedGateway } from "../../../src/testing/scripted-gateway.js";
import { Cassette } from "../../../src/testing/vcr-cassette.js";
import { vcrGateway } from "../../../src/testing/vcr.js";
import { cassetteHashesOf, type CassetteHashes } from "../../../src/testing/vcr-hashes.js";
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

/** How a recording opens its cassette: from scratch by default, `Cassette.recordingStale` too. */
export type CassetteOpener = (file: string, hashes: CassetteHashes) => Cassette;

/** Records a run of any workflow from `start` into `file`, the scripted models standing in. */
export async function recordRun(
  { application, start }: { readonly application: Class; readonly start: Class },
  file: string,
  text: string,
  script: (book: ScriptBook) => void,
  open: CassetteOpener = (at, hashes) => Cassette.recording(at, hashes),
): Promise<ExecutionOutput> {
  const book = new ScriptBook();
  script(book);
  const assembled = await applicationOf(application);
  const cassette = open(file, cassetteHashesOf(assembled.workflows));
  const { app } = await buildApplication(
    assembled,
    {
      processEnv: {},
      gateway: vcrGateway(cassette, () => createScriptedGateway(book)),
      connectMcp: stubbedMcpConnect(new McpStubs(book), new Map(), new Set()),
    },
    { idGenerator: new SequentialIdGenerator() },
  );
  try {
    return await execute(app, start, { text });
  } finally {
    await app.close();
  }
}
