import { coerceMessageLikeToMessage, type BaseMessageLike } from "@langchain/core/messages";
import type { UsageRecord } from "../../finops/usage.js";
import type { DecisionRequest, DecisionQuestions } from "../../llm/decisions.js";
import { maskedMessageOf } from "../../pii/message-mask.js";
import type { ModelReadingMask } from "../../pii/model-reading.js";
import { mappedStringsAsync } from "../../pii/strings.js";
import { revealedText, type PiiTokenMap } from "../../pii/tokens.js";

/**
 * A model judge's calls read as its agent's model reads (#708): what the judge sends — a text, chat
 * messages, a decision's state and questions — through the agent's PII policies, and a chat reply
 * revealed before the judge's code reads it, so the judge sees real values and its model none.
 */

/** One judge's reading: each text masked as it is sent, the tokens met, what masking cost. */
export class JudgeReading {
  readonly tokens: Record<string, string> = {};
  readonly usage: UsageRecord[] = [];

  constructor(private readonly mask: ModelReadingMask) {}

  readonly text = async (text: string): Promise<string> => {
    const read = await this.mask([text]);
    Object.assign(this.tokens, read.tokens);
    this.usage.push(...read.usage);
    return read.texts[0] ?? text;
  };

  /** A chat call's input as the model reads it. */
  async input(input: string | readonly BaseMessageLike[]): Promise<string | BaseMessageLike[]> {
    if (typeof input === "string") return this.text(input);
    const messages = [];
    for (const like of input) messages.push(await maskedMessageOf(coerceMessageLikeToMessage(like), this.text));
    return messages;
  }

  /** A decision's request as the model reads it; an image's data is no text. */
  async request<Q extends DecisionQuestions>(request: DecisionRequest<Q>): Promise<DecisionRequest<Q>> {
    const read = (text: string): Promise<string> =>
      text.startsWith("data:image/") ? Promise.resolve(text) : this.text(text);
    return (await mappedStringsAsync(request, read)) as DecisionRequest<Q>;
  }

  /** The model's reply with the tokens it was shown back to their values. */
  revealed(reply: string, known: PiiTokenMap = {}): string {
    return revealedText(reply, { ...known, ...this.tokens }).text;
  }
}
