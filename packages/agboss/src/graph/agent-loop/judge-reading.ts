import { coerceMessageLikeToMessage, type BaseMessageLike } from "@langchain/core/messages";
import type { UsageRecord } from "../../finops/usage.js";
import type { DecisionRequest, DecisionQuestions } from "../../llm/decisions.js";
import { maskedMessageOf } from "../../pii/message-mask.js";
import type { ModelReadingMask } from "../../pii/model-boundary.js";
import { mappedStringsAsync } from "../../pii/strings.js";
import { revealedText, type PiiTokenMap } from "../../pii/tokens.js";

/**
 * A model judge's calls read as its agent's model reads (#708): what the judge sends — a text, chat
 * messages, a decision's state and questions — through the agent's PII policies, and a chat reply
 * revealed before the judge's code reads it, so the judge sees real values and its model none.
 */

/** A whole base64 image data URL, as `Decision.image` makes it: nothing else is exempt. */
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u;

/** A decision's image part (`{ type: "image_url", image_url: { url } }`) holding only image data. */
function isImagePart(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const part = value as { readonly type?: unknown; readonly image_url?: unknown };
  if (part.type !== "image_url" || typeof part.image_url !== "object" || part.image_url === null)
    return false;
  const { url, ...rest } = part.image_url as { readonly url?: unknown; readonly detail?: unknown };
  const isOnlyDetail = Object.keys(rest).every((key) => key === "detail");
  return (
    typeof url === "string" &&
    IMAGE_DATA_URL.test(url) &&
    isOnlyDetail &&
    Object.keys(value).length === 2
  );
}

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
    for (const like of input)
      messages.push(await maskedMessageOf(coerceMessageLikeToMessage(like), this.text));
    return messages;
  }

  /**
   * A decision's request as the model reads it, as plain data (a class instance is read by its
   * fields, never passed through): every string masked but the data of a real image part — an
   * `image_url` part whose whole url is a base64 image data URL (no prefix exempts a text).
   */
  async request<Q extends DecisionQuestions>(
    request: DecisionRequest<Q>,
  ): Promise<DecisionRequest<Q>> {
    const plain: unknown = JSON.parse(JSON.stringify(request));
    return (await this.#read(plain)) as DecisionRequest<Q>;
  }

  async #read(value: unknown): Promise<unknown> {
    if (isImagePart(value)) return value;
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) items.push(await this.#read(item));
      return items;
    }
    if (typeof value === "object" && value !== null) {
      const entries: [string, unknown][] = [];
      for (const [key, item] of Object.entries(value)) entries.push([key, await this.#read(item)]);
      return Object.fromEntries(entries);
    }
    return mappedStringsAsync(value, this.text);
  }

  /** The model's reply with the tokens it was shown back to their values. */
  revealed(reply: string, known: PiiTokenMap = {}): string {
    return revealedText(reply, { ...known, ...this.tokens }).text;
  }
}
