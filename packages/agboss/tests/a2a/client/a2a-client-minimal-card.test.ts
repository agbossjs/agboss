/**
 * #904 item 7: a foreign agent's card may leave `capabilities.extensions` out — or `capabilities`
 * itself: a minimal valid A2A v1.0 card is read as declaring no extension (a foreign peer, no mesh,
 * no skills' schemas), never a `TypeError`.
 */
import { describe, expect, it } from "vitest";
import { A2AClient, A2APeerKind } from "../../../src/a2a/index.js";
import { Text } from "../../../src/dto/index.js";
import { AGENT_URL, scripts, SdkAgent } from "./support/sdk-agent.js";

class QuestionDto {
  @Text()
  question!: string;
}

class AnswerDto {
  @Text()
  answer!: string;
}

/** A minimal valid A2A v1.0 card, as JSON — `capabilities` as given. */
const minimalCard = (capabilities: Record<string, unknown> | undefined) => ({
  name: "minimal-agent",
  description: "A foreign agent with a minimal card",
  version: "1.0.0",
  supportedInterfaces: [{ url: AGENT_URL, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  ...(capabilities === undefined ? {} : { capabilities }),
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [{ id: "ask", name: "ask", description: "Answers", tags: ["ask"] }],
});

describe("#904 item 7: a card without capabilities.extensions", () => {
  it.each([
    ["capabilities without extensions", { streaming: false }],
    ["empty capabilities", {}],
    ["no capabilities", undefined],
  ])("AC7.1 %s: a foreign peer, the call sent and answered", async (_case, capabilities) => {
    const agent = new SdkAgent({ script: scripts.messageEcho, rawCard: minimalCard(capabilities) });
    const client = new A2AClient({ url: AGENT_URL, fetcher: agent.fetcher });

    const answer = await client.send("hi");
    const card = await client.agentCard();

    expect(answer.text).toBe("HI");
    expect(card.name).toBe("minimal-agent");
    expect(answer.peer).toEqual({
      kind: A2APeerKind.Foreign,
      idempotencyRetention: undefined,
      mesh: false,
    });
  });

  it("AC7.2 a typed call checks the card's skill and sends: no schemas declared, none compared", async () => {
    const agent = new SdkAgent({ script: scripts.messageEcho, rawCard: minimalCard({}) });
    const client = new A2AClient<QuestionDto, AnswerDto>({
      url: AGENT_URL,
      fetcher: agent.fetcher,
      contract: { skill: "ask", input: QuestionDto, output: AnswerDto },
    });

    await expect(client.send("hi")).resolves.toMatchObject({ text: "HI" });
    expect(agent.received).toHaveLength(1);
  });
});
