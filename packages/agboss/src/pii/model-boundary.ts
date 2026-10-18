import { AIMessage, type BaseMessage, type MessageContent } from "@langchain/core/messages";
import { createHash } from "node:crypto";
import type { UsageRecord } from "../finops/usage.js";
import type { PiiFinding } from "./masking.js";
import type { PiiPolicySet } from "./policy-set.js";
import { DetectionMode } from "./runtime-policy.js";
import { maskedMessageOf } from "./message-mask.js";
import { asRecord, mappedStrings } from "./strings.js";
import { revealedText, type PiiTokenMap } from "./tokens.js";

/**
 * The model boundary (#120 S38) — the only place PII is masked and revealed, both ways. Into the
 * model: every message of the request (instructions, memory, the input message, the moves and the
 * tool results) through the effective policies of that agent or router. Out of the model: the
 * move's text and every tool-call and answer-tool argument revealed right after parsing, before any
 * DTO validation — the scope, the checkpoint and every step's code carry real values.
 */

/**
 * Texts already masked in this agent's loop (its `piiMasked` channel): the masked form by the role
 * and the hash of the text — the conversation is masked whole for every call, each text searched
 * (and its model detection paid) once.
 */
export type PiiMaskCache = Readonly<Record<string, string>>;

/** The cache key of a text: its role (`in` — what came in — or `out`) and its SHA-256. */
export const maskCacheKey = (text: string, isIncoming: boolean): string =>
  `${isIncoming ? "in" : "out"}:${createHash("sha256").update(text).digest("hex")}`;

/** A request as the model sees it, the tokens it introduced, what a block rule matched and the cost. */
export interface MaskedRequest {
  readonly messages: readonly BaseMessage[];
  readonly tokens: Readonly<Record<string, string>>;
  /** The texts this request masked for the first time (the loop's `piiMasked`). */
  readonly cache: PiiMaskCache;
  /** Blocked values in what came in (instructions, memory, input, tool results) — refused. */
  readonly blocked: readonly PiiFinding[];
  readonly usage: readonly UsageRecord[];
}

/** One pass over the texts of a request: their tokens, blocked values and spend. */
class MaskingPass {
  readonly tokens: Record<string, string> = {};
  readonly blocked: PiiFinding[] = [];
  readonly usage: UsageRecord[] = [];
  readonly cached: Record<string, string> = {};

  constructor(
    private readonly set: PiiPolicySet,
    private readonly known: PiiTokenMap,
    private readonly cache: PiiMaskCache,
  ) {}

  async text(text: string, isIncoming: boolean): Promise<string> {
    const key = maskCacheKey(text, isIncoming);
    const hit = this.cache[key] ?? this.cached[key];
    if (hit !== undefined) return hit;
    const { masked, usage } = await this.set.mask(
      text,
      { ...this.known, ...this.tokens },
      DetectionMode.WithModel,
    );
    Object.assign(this.tokens, masked.tokens);
    this.usage.push(...usage);
    if (isIncoming) this.blocked.push(...masked.blocked);
    if (!isIncoming || masked.blocked.length === 0) this.cached[key] = masked.text;
    return masked.text;
  }
}

const maskedMessage = (message: BaseMessage, pass: MaskingPass): Promise<BaseMessage> =>
  maskedMessageOf(message, (text, isIncoming) => pass.text(text, isIncoming));

/** The request through the policies; `known` = the execution's `piiTokens` so far. */
export async function maskForModel(
  set: PiiPolicySet,
  messages: readonly BaseMessage[],
  known: PiiTokenMap,
  cache: PiiMaskCache = {},
): Promise<MaskedRequest> {
  if (set.isEmpty) return { messages, tokens: {}, cache: {}, blocked: [], usage: [] };
  const pass = new MaskingPass(set, known, cache);
  const masked: BaseMessage[] = [];
  for (const message of messages) masked.push(await maskedMessage(message, pass));
  const { tokens, cached, blocked, usage } = pass;
  return { messages: masked, tokens, cache: cached, blocked, usage };
}

/** A move with its tokens replaced by their values, and the tokens no map knows (an invalid answer). */
export interface RevealedMove {
  readonly move: AIMessage;
  readonly unknownTokens: readonly string[];
}

/** The model's move with every known token revealed — its text and each call's arguments. */
export function revealFromModel(move: AIMessage, tokens: PiiTokenMap): RevealedMove {
  const unknownTokens: string[] = [];
  const reveal = (text: string): string => {
    const revealed = revealedText(text, tokens);
    unknownTokens.push(...revealed.unknownTokens);
    return revealed.text;
  };
  const toolCalls = (move.tool_calls ?? []).map((call) => ({
    ...call,
    args: asRecord(mappedStrings(call.args, reveal)),
  }));
  const content =
    typeof move.content === "string"
      ? reveal(move.content)
      : (mappedStrings(move.content, reveal) as MessageContent);
  return {
    move: new AIMessage({ content, tool_calls: toolCalls }),
    unknownTokens: [...new Set(unknownTokens)],
  };
}

/** A text a model reads (a router's input), masked; its new tokens and what the masking cost. */
export interface MaskedModelText {
  readonly text: string;
  readonly tokens: Readonly<Record<string, string>>;
  readonly usage: readonly UsageRecord[];
}

/**
 * One text into a model through the policies (a router's request): a `blockWithRefusal` value in it
 * fails the execution with `PiiRefusedError`.
 */
export async function maskedModelText(
  set: PiiPolicySet,
  text: string,
  known: PiiTokenMap,
): Promise<MaskedModelText> {
  const { masked, usage } = await set.mask(text, known, DetectionMode.WithModel);
  const refused = await set.refusalError(masked.blocked, usage);
  if (refused !== undefined) throw refused;
  return { text: masked.text, tokens: masked.tokens, usage };
}
