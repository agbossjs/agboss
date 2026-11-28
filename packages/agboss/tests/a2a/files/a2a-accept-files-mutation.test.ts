/**
 * #1356 (mutation shard `a2a-server`): a message that lost the race for its id — another accept of the
 * same `messageId` saved its task first — keeps no file of its own: the files it kept under its minted task
 * id go with it (#1316), and a message with no file asks the store to forget nothing.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { A2ATaskRepository } from "../../../src/infrastructure/a2a-task.repository.js";
import { FileRepository } from "../../../src/infrastructure/file.repository.js";
import { testWith } from "../../../src/testing/index.js";
import { BearerAuthenticator } from "../fixtures/bearer-authenticator.js";
import {
  FilesA2AExpose,
  FilesApplication,
  StoredFilesApplication,
} from "../fixtures/files.application.js";
import { rpc, text, userMessage } from "../server/rpc.js";
import { OrdersA2AExpose, OrdersApplication } from "../fixtures/task.application.js";
import {
  Clerk,
  ReceiptDto,
  resetRecovery,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import { replyWith } from "../../../src/testing/index.js";
import { fileMessage, PDF, rawPart, TEXT } from "./support.js";

const test = testWith(FilesApplication);
const stored = testWith(StoredFilesApplication);
const orders = testWith(OrdersApplication);
beforeEach(resetRecovery);
const listener = { endpoint: FilesA2AExpose, authenticator: BearerAuthenticator };

describe("two accepts of one message at once", () => {
  for (const [name, run, kept] of [
    ["inline files", test, false],
    ["a file store", stored, true],
  ] as const) {
    run(
      `with files (${name}): the one that lost ${kept ? "forgets the files it kept under its task id" : "has none kept to forget"}`,
      async ({ a2aServer, app }) => {
        await app.ready();
        const forgotten = vi.spyOn(app.resolve(FileRepository), "deleteByOwner");
        const { url } = await a2aServer(listener);
        const send = () =>
          rpc(url, "SendMessage", fileMessage("race-1", [rawPart(PDF, "application/pdf")]));

        const first = await send();
        // the second accept looked before the first saved: it finds no task, mints one and loses the save
        vi.spyOn(app.resolve(A2ATaskRepository), "findByMessage").mockResolvedValueOnce(undefined);
        const second = await send();

        const idOf = (answer: Awaited<ReturnType<typeof send>>) =>
          (answer.body.result as { task: { id: string } }).task.id;
        expect(idOf(first)).toBe(idOf(second));
        expect(forgotten).toHaveBeenCalledTimes(kept ? 1 : 0);
        if (!kept) return;
        const [call] = forgotten.mock.calls;
        expect(call?.[0]).toMatchObject({ tenantId: "default" });
        expect(call?.[0].ownerId).not.toBe(idOf(first));
      },
    );
  }

  orders("with no file: nothing is forgotten", async ({ a2aServer, app, mockModel }) => {
    mockModel(Clerk).thenReturn(replyWith(ReceiptDto, { text: "Done." }));
    await app.ready();
    const forgotten = vi.spyOn(app.resolve(FileRepository), "deleteByOwner");
    const { url } = await a2aServer({
      endpoint: OrdersA2AExpose,
      authenticator: BearerAuthenticator,
    });
    const send = () => rpc(url, "SendMessage", { message: userMessage("race-2", [text("go")]) });

    const first = await send();
    vi.spyOn(app.resolve(A2ATaskRepository), "findByMessage").mockResolvedValueOnce(undefined);
    const second = await send();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(forgotten).not.toHaveBeenCalled();
  });
});
