import type {
  InvalidToolCall,
  MessageContent,
  ToolCall,
  UsageMetadata,
} from "@langchain/core/messages";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DecisionOutcome } from "../llm/decision-response.js";
import type { RouteOutcome } from "../routers/index.js";
import { stableJson } from "../terns/index.js";
import { CassetteMissingError } from "./errors.js";

/**
 * A cassette file (#395 PR 4): version 2 keeps, with every interaction, the component that made the
 * call and that component's `promptHash` / `schemaHash` at recording — what a replay and
 * `agboss check --cassettes` compare with the application's to find a stale recording. A version 1
 * file (no hashes) still replays, without stale detection.
 */

/** A model's reply as a cassette keeps it: enough to rebuild the `AIMessage` it returned. */
export interface StoredReply {
  readonly content: MessageContent;
  readonly tool_calls?: ToolCall[];
  /** Calls whose arguments were no JSON (#395): replayed as the provider sent them. */
  readonly invalid_tool_calls?: InvalidToolCall[];
  readonly usage_metadata?: UsageMetadata;
  readonly response_metadata?: Record<string, unknown>;
}

const isObject = (value: unknown): boolean => typeof value === "object" && value !== null;

/** The component of an interaction and its hashes when it was recorded (version 2). */
const Recorded = {
  component: z.string().optional(),
  promptHash: z.string().optional(),
  schemaHash: z.string().optional(),
};

const ChatInteraction = z.strictObject({
  kind: z.literal("chat"),
  key: z.string(),
  request: z.string(),
  ...Recorded,
  reply: z.custom<StoredReply>(isObject),
});

const DecisionInteraction = z.strictObject({
  kind: z.literal("decision"),
  key: z.string(),
  request: z.string(),
  ...Recorded,
  outcome: z.custom<RouteOutcome>(isObject),
});

const DecideInteraction = z.strictObject({
  kind: z.literal("decide"),
  key: z.string(),
  request: z.string(),
  ...Recorded,
  outcome: z.custom<DecisionOutcome>(isObject),
});

const Interaction = z.discriminatedUnion("kind", [
  ChatInteraction,
  DecisionInteraction,
  DecideInteraction,
]);

/** One recorded model call. */
export type Interaction = z.infer<typeof Interaction>;

/** The cassette format this version writes. */
export const CASSETTE_VERSION = 2;

const CassetteFile = z.strictObject({
  version: z.union([z.literal(1), z.literal(CASSETTE_VERSION)]),
  interactions: z.array(Interaction),
});

/** A cassette as read: its format version and its interactions. */
export interface CassetteContent {
  readonly version: 1 | typeof CASSETTE_VERSION;
  readonly interactions: Interaction[];
}

/** How to record a cassette from scratch (a missing or unreadable one). */
export const RE_RECORD = "re-record it: run the test with vcr mode RECORD (and a model key)";

/** The cassette in `file`; a missing or unreadable one fails here, before the test runs. */
export function readCassette(file: string): CassetteContent {
  if (!fs.existsSync(file)) {
    throw new CassetteMissingError(`no cassette ${file} — ${RE_RECORD}`);
  }
  const parsed = CassetteFile.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new CassetteMissingError(
      `${file} is not a cassette (${parsed.error.message}) — ${RE_RECORD}`,
    );
  }
  return parsed.data;
}

/** Writes the interactions as a version 2 cassette, keys sorted (a stable diff). */
export function writeCassette(file: string, interactions: readonly Interaction[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const content = { version: CASSETTE_VERSION, interactions };
  fs.writeFileSync(file, `${JSON.stringify(JSON.parse(stableJson(content)), null, 2)}\n`);
}

/** The hint a version 1 cassette prints once: it replays, but a change cannot be seen in it. */
export const v1HintOf = (file: string): string =>
  `${file} is a version 1 cassette: it replays, but without stale detection (no prompt or schema hashes) — re-record it once with AGBOSS_VCR_MODE=RECORD npm test`;
