import type { DecisionOutcome } from "../llm/decision-response.js";
import type { RouteOutcome } from "../routers/index.js";
import { versionOf } from "../terns/index.js";
import { CassetteMissingError, StaleCassetteError } from "./errors.js";
import {
  componentOfKey,
  staleComponentsOf,
  type CassetteHashes,
  type StaleComponent,
} from "./vcr-hashes.js";
import {
  RE_RECORD,
  readCassette,
  v1HintOf,
  writeCassette,
  type CassetteContent,
  type Interaction,
  type StoredReply,
} from "./vcr-file.js";

export type { StoredReply } from "./vcr-file.js";

/** The request hash an interaction is found by: equal requests → equal hashes, on every machine. */
export const requestHashOf = (request: unknown): string => versionOf(request);

/** An interaction as the gateway records it: the cassette adds its component and hashes. */
export type RecordedCall = Interaction extends infer TKind
  ? TKind extends Interaction
    ? Omit<TKind, "component" | "promptHash" | "schemaHash">
    : never
  : never;

/** How a cassette answers: from its recordings, by recording everything, or the stale part only. */
enum CassetteMode {
  Replay = "replay",
  Record = "record",
  RecordStale = "record-stale",
}

/** The version 1 cassettes this process was told about: each hint once. */
const hinted = new Set<string>();

function hintVersion1(file: string, content: CassetteContent): void {
  if (content.version !== 1 || hinted.has(file)) return;
  hinted.add(file);
  process.emitWarning(v1HintOf(file), { code: "vcr.v1-cassette" });
}

/** The stale components of a cassette by name; a version 1 one has every component stale. */
function staleOf(content: CassetteContent, hashes: CassetteHashes): Map<string, StaleComponent> {
  const found =
    content.version === 1
      ? [...new Set(content.interactions.map((i) => componentOfKey(i.key)))].map((component) => ({
          component,
          changes: [],
        }))
      : staleComponentsOf(content.interactions, hashes);
  return new Map(found.map((stale) => [stale.component, stale]));
}

/** The component an interaction belongs to. */
const componentOf = (interaction: Interaction): string =>
  interaction.component ?? componentOfKey(interaction.key);

/**
 * The recorded model calls of one test: agents, judges, compaction (`chat`) and every router,
 * guard decision, Jev included (`decision`), every judge's `decide` on a decision model (`decide`), each under its script key
 * (`agent:<name>`, `judge:<name>`, `router:<name>`, `compaction:<name>`) and request hash. Replay
 * returns the n-th recording of an equal request in order; a component changed since it was
 * recorded is a `StaleCassetteError` (#395 PR 4), anything else unrecorded a
 * `CassetteMissingError` — both reported through `report`, so the test fails even when the run
 * swallows them. `RECORD_STALE` replays the rest and records the stale components' calls anew.
 */
export class Cassette {
  readonly #used = new Map<string, number>();

  private constructor(
    readonly file: string,
    private readonly mode: CassetteMode,
    private readonly interactions: Interaction[],
    private readonly hashes: CassetteHashes,
    private readonly stale: ReadonlyMap<string, StaleComponent>,
    private readonly report: (failure: Error) => Error,
  ) {}

  /** Replays `file`; a missing or unreadable cassette fails here, before the test runs. */
  static replaying(
    file: string,
    hashes: CassetteHashes,
    report: (failure: Error) => Error,
  ): Cassette {
    const content = readCassette(file);
    hintVersion1(file, content);
    // a version 1 cassette has no hashes: it replays as it is, nothing is stale
    const stale = content.version === 1 ? new Map() : staleOf(content, hashes);
    return new Cassette(file, CassetteMode.Replay, content.interactions, hashes, stale, report);
  }

  /** Records into `file` from scratch, writing it after every call. */
  static recording(file: string, hashes: CassetteHashes): Cassette {
    return new Cassette(file, CassetteMode.Record, [], hashes, new Map(), (failure) => failure);
  }

  /**
   * Replays `file` but records the calls of its stale components anew (`VCRMode.RECORD_STALE`):
   * their old recordings are dropped, the others kept as they are. A version 1 cassette has no
   * hashes, so all of it is recorded again (as version 2).
   */
  static recordingStale(
    file: string,
    hashes: CassetteHashes,
    report: (failure: Error) => Error,
  ): Cassette {
    const content = readCassette(file);
    const stale = staleOf(content, hashes);
    const kept = content.interactions.filter((interaction) => !stale.has(componentOf(interaction)));
    return new Cassette(file, CassetteMode.RecordStale, kept, hashes, stale, report);
  }

  /** Whether a call under `key` goes to the real model and is recorded. */
  records(key: string): boolean {
    if (this.mode === CassetteMode.Record) return true;
    return this.mode === CassetteMode.RecordStale && this.stale.has(componentOfKey(key));
  }

  chat(key: string, request: string): StoredReply {
    const found = this.#take("chat", key, request);
    if (found?.kind !== "chat") throw this.#missing(key);
    return found.reply;
  }

  decision(key: string, request: string): RouteOutcome {
    const found = this.#take("decision", key, request);
    if (found?.kind !== "decision") throw this.#missing(key);
    return found.outcome;
  }

  /** A judge's `judgeModel.decide` (a decision model's answers and cost). */
  decide(key: string, request: string): DecisionOutcome {
    const found = this.#take("decide", key, request);
    if (found?.kind !== "decide") throw this.#missing(key);
    return found.outcome;
  }

  /** Keeps a call with its component's current hashes and writes the cassette (version 2). */
  record(call: RecordedCall): void {
    const interaction: Interaction = { ...call, ...this.hashes.of(call.key) };
    this.interactions.push(interaction);
    writeCassette(this.file, this.interactions);
  }

  #take(kind: Interaction["kind"], key: string, request: string): Interaction | undefined {
    const stale = this.stale.get(componentOfKey(key));
    if (stale !== undefined && this.mode === CassetteMode.Replay) {
      throw this.report(new StaleCassetteError(this.file, stale.component, stale.changes));
    }
    const id = `${kind} ${key} ${request}`;
    const n = this.#used.get(id) ?? 0;
    this.#used.set(id, n + 1);
    return this.interactions.filter(
      (i) => i.kind === kind && i.key === key && i.request === request,
    )[n];
  }

  #missing(key: string): Error {
    const recorded = this.interactions.filter((i) => i.key === key).length;
    return this.report(
      new CassetteMissingError(
        `${this.file} has no recording of this ${key} request (${String(recorded)} recorded for ${key}: a prompt, tool or input changed) — ${RE_RECORD}`,
      ),
    );
  }
}
