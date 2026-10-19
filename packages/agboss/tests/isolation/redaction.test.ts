/** #202, #120 AC8: a tool's `sensitive` arguments go through their action wherever a channel shows them. */
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import { redactedArguments, redactedDto } from "../../src/dto/redact.js";
import { ListOf, Nested, Text } from "../../src/dto/index.js";
import { PiiAction } from "../../src/index.js";
import { schemaOf } from "../../src/dto/schema.js";
import { createSqliteTernStore } from "../../src/terns/index.js";
import { callTool, replyWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ApprovalDesk, ChatStart } from "../channels/approval.workflow.js";
import { Pay, PaymentLog, PaymentsApplication } from "./isolation.workflow.js";
import { execute, answerOf } from "../helpers/flow.js";

const card = { orderId: "A-1", cardNumber: "4111 1111 1111 1111" };
const approve = { approved: true };

describe("#202: sensitive tool arguments are redacted in channel output", () => {
  it("the channel, the pause and the ask summary get the card masked; the tool gets it whole", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:cashier-agent").thenReturn(callTool(Pay, card), replyWith("Paid."));
    const app = await createApp(PaymentsApplication, {
      processEnv: {},
      gateway: createScriptedGateway(book),
    });

    const paused = await execute(app, ChatStart, { text: "pay A-1" });

    const desk = app.resolve(ApprovalDesk);
    expect(desk.posted).toEqual([
      expect.objectContaining({
        value: expect.objectContaining({ arguments: { orderId: "A-1", cardNumber: "•••• 1111" } }),
      }),
    ]);
    expect(paused.pending).toMatchObject([
      { ask: { arguments: { orderId: "A-1", cardNumber: "•••• 1111" } } },
    ]);
    expect(JSON.stringify(paused)).not.toContain("4111 1111");
    await app.resume(answerOf(paused, approve));
    expect(app.resolve(PaymentLog).cards).toEqual(["4111 1111 1111 1111"]);
    await app.close();
  });

  it("nested and listed DTOs are masked too; arguments without a DTO stay as they are", () => {
    class Holder {
      @Text({ sensitive: PiiAction.replaceWithKind() })
      name!: string;
    }
    class Order {
      @Text()
      id!: string;

      @Nested(Holder)
      holder!: Holder;

      @ListOf(Holder)
      others!: Holder[];
    }
    const order = { id: "o", holder: { name: "Ann" }, others: [{ name: "Bo" }], extra: 1 };

    expect(redactedArguments(schemaOf(Order), order)).toEqual({
      id: "o",
      holder: { name: "<name>" },
      others: [{ name: "<name>" }],
      extra: 1,
    });
    expect(redactedArguments({}, { name: "Ann" })).toEqual({ name: "Ann" });
    expect(redactedDto(Order, "text")).toBe("text");
  });
});
