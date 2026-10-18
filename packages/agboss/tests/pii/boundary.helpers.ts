import { createApp } from "../../src/application/create-app.js";
import type { App } from "../../src/app/types.js";
import { extractText } from "../../src/graph/multimodal.js";
import type { ModelRequest } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { PII_KEY_VARIABLE, PiiApplication } from "./pii.fixture.js";

/** The PII application on scripted models, its key from the test's process variables. */
export async function piiApp(book: ScriptBook = new ScriptBook()): Promise<{
  readonly app: App;
  readonly book: ScriptBook;
}> {
  const app = await createApp(PiiApplication, {
    processEnv: { [PII_KEY_VARIABLE]: "test-key" },
    gateway: createScriptedGateway(book),
  });
  return { app, book };
}

/** Everything a chat request carried, as one text: instructions, input, every message. */
export const requestText = (request: ModelRequest): string =>
  request.kind === "chat"
    ? [
        request.system,
        extractText(request.input),
        ...request.messages.map((line) => extractText(line.text)),
      ].join("\n")
    : extractText(request.input);

/** The tokens of one kind in a text (`<email:7f3a91>`). */
export const tokensIn = (text: string, label: string): string[] => [
  ...new Set(text.match(new RegExp(`<${label}:[0-9a-f]{6,}>`, "g")) ?? []),
];
