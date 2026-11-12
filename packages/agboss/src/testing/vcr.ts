import fs from "node:fs";
import path from "node:path";
import { DecisionError } from "../llm/decision-errors.js";
import type { DecisionOutcome } from "../llm/decision-response.js";
import type { GatewayOverProviders } from "../app/models.js";
import { type DecideSpec, type DecisionSpec, type ModelGateway } from "../llm/gateway.js";
import type { RouteOutcome } from "../routers/index.js";
import type { AssembledWorkflow } from "../workflow.js";
import { CassetteMissingError, StaleCassetteError, TestSetupError } from "./errors.js";
import { cassetteHashesOf, type CassetteHashes } from "./vcr-hashes.js";
import { chatKeyOf, routerKeyOf } from "./scripted-gateway.js";
import { Cassette, requestHashOf } from "./vcr-cassette.js";
import { VcrChatModel } from "./vcr-chat-model.js";

// VCR (#204): a test answers from a cassette instead of scripts — every model call recorded once,
// then replayed with no key and no network. Version 2 cassettes keep each call's component hashes
// (#395 PR 4: stale cassettes, `RECORD_STALE`). While recording, the real providers' gateway is the
// one `createApp` builds — its transport providers created by the test app's container (#439) — so
// an offline project records through its transport; a replay never builds a provider. The mode
// comes from the test's `vcr.mode`, else `AUTO` (`REPLAY` under `CI`); `AGBOSS_VCR_MODE` overrides
// every test's own for one run. Under `CI` no mode records against real models (#839): one that
// would — `RECORD`, `RECORD_STALE`, `AUTO` with no cassette — is refused before the app is built,
// `[vcr.record-in-ci]`, unless `AGBOSS_VCR_RECORD_IN_CI=1` says the run records on purpose.

/** How a VCR test answers its model calls: from the cassette, from the models, or both. */
export enum VcrMode {
  /** Call the real models and write every call to the cassette (from scratch). */
  RECORD = "RECORD",
  /** Answer only from the cassette; a missing cassette or call fails with `CassetteMissingError`. */
  REPLAY = "REPLAY",
  /** REPLAY when the cassette exists, else RECORD. */
  AUTO = "AUTO",
  /**
   * Replay the cassette, but record anew the calls of every component whose prompt or schema hash
   * changed since it was recorded (#395 PR 4) — the others are kept as they are; a version 1
   * cassette (no hashes) is recorded again whole.
   */
  RECORD_STALE = "RECORD_STALE",
}

/** The process variable that picks the mode of every VCR test: a member's value (`RECORD_STALE`). */
export const VCR_MODE_VARIABLE = "AGBOSS_VCR_MODE";

/**
 * The process variable that lets a CI run record (#839): `1` (or `true`) — any other value, or
 * none, and a mode that would call real models under `CI` is refused (`[vcr.record-in-ci]`).
 */
export const VCR_RECORD_IN_CI_VARIABLE = "AGBOSS_VCR_RECORD_IN_CI";

const MODES: ReadonlySet<string> = new Set(Object.values(VcrMode));

const isVcrMode = (value: string): value is VcrMode => MODES.has(value);

/** `AGBOSS_VCR_MODE`, when set: a member's value, else the test fails naming the values. */
function modeFromEnv(env: NodeJS.ProcessEnv): VcrMode | undefined {
  const value = env[VCR_MODE_VARIABLE];
  if (value === undefined || value === "") return undefined;
  if (isVcrMode(value)) return value;
  throw new TestSetupError({
    message: `${VCR_MODE_VARIABLE}=${value} is not a VCR mode: one of ${[...MODES].join(", ")}`,
  });
}

/** `testWith(W, { vcr })`: record real model calls once, replay them in every later run. */
export interface VcrConfig {
  /** The cassette's name: its file is `<cassetteName>.cassette.json` in `dir`. */
  readonly cassetteName: string;
  /**
   * Default: REPLAY when `CI` is set (CI never calls a model), else AUTO. Under `CI` a mode that
   * would call real models (RECORD, RECORD_STALE, AUTO with no cassette) is refused at startup,
   * `[vcr.record-in-ci]`, unless `AGBOSS_VCR_RECORD_IN_CI=1` (#839).
   */
  readonly mode?: VcrMode;
  /** Where `<cassetteName>.cassette.json` lives; default `__snapshots__` (from the working directory). */
  readonly dir?: string;
}

const isCi = (env: NodeJS.ProcessEnv): boolean =>
  env.CI !== undefined && !["", "0", "false"].includes(env.CI.toLowerCase());

/** Whether the run opted in to recording under `CI` (#839): `AGBOSS_VCR_RECORD_IN_CI` is `1` or `true`. */
const recordsInCi = (env: NodeJS.ProcessEnv): boolean =>
  ["1", "true"].includes((env[VCR_RECORD_IN_CI_VARIABLE] ?? "").toLowerCase());

/** Why `mode` would call real models for `file`'s calls — `undefined` when it only replays. */
function recordingOf(mode: VcrMode, file: string): string | undefined {
  if (mode === VcrMode.RECORD || mode === VcrMode.RECORD_STALE) return mode;
  if (mode === VcrMode.AUTO && !fs.existsSync(file)) return `AUTO with no cassette at ${file}`;
  return undefined;
}

/**
 * The mode a VCR test runs in: `AGBOSS_VCR_MODE` when set (it re-records tests that name their own
 * mode too), else the given one; REPLAY under `CI`; else AUTO. Under `CI` a mode that would call
 * real models is refused (#839, fail closed): `[vcr.record-in-ci]`, naming where the mode came from,
 * the variable and the remedy — unless `AGBOSS_VCR_RECORD_IN_CI=1`.
 */
export function vcrModeOf(config: VcrConfig, env: NodeJS.ProcessEnv): VcrMode {
  const configured = configuredModeOf(config);
  const fromEnv = modeFromEnv(env);
  const mode = fromEnv ?? configured ?? (isCi(env) ? VcrMode.REPLAY : VcrMode.AUTO);
  if (!isCi(env) || recordsInCi(env)) return mode;
  const recording = recordingOf(mode, cassetteFileOf(config));
  if (recording === undefined) return mode;
  const source =
    fromEnv === undefined ? `vcr.mode ${recording}` : `${VCR_MODE_VARIABLE}=${recording}`;
  const optIn = env[VCR_RECORD_IN_CI_VARIABLE];
  // a value set and not taken is named, so a typo does not read as the variable ignored
  const rejected =
    optIn === undefined || optIn === ""
      ? ""
      : ` (${VCR_RECORD_IN_CI_VARIABLE}=${optIn} is no opt-in: 1 or true)`;
  throw new TestSetupError({
    message:
      `[vcr.record-in-ci] ${source} records against real models, and CI is set (CI=${String(env.CI)}): ` +
      `a CI run replays its cassettes — record without CI and commit the cassette, or set ` +
      `${VCR_RECORD_IN_CI_VARIABLE}=1 to record in this CI run on purpose${rejected}`,
  });
}

/** A value as a message shows it: a text quoted, a number, a flag or null as is, else its type. */
const shownOf = (value: unknown): string =>
  typeof value === "string"
    ? JSON.stringify(value)
    : typeof value === "number" || typeof value === "boolean" || value === null
      ? String(value)
      : typeof value;

/**
 * The test's own `vcr.mode` (#819): absent, or a member's value — anything else (a JavaScript
 * caller's typo, a value read from JSON) is refused before any model is asked, whatever
 * `AGBOSS_VCR_MODE` or `CI` say, never taken for a mode that records against real models.
 */
function configuredModeOf(config: VcrConfig): VcrMode | undefined {
  const mode: unknown = Reflect.get(config, "mode");
  if (mode === undefined) return undefined;
  if (typeof mode === "string" && isVcrMode(mode)) return mode;
  throw new TestSetupError({
    message: `[vcr.unknown-mode] vcr.mode is ${shownOf(mode)}: one of ${[...MODES].join(", ")}`,
  });
}

export const cassetteFileOf = (config: VcrConfig): string =>
  path.join(config.dir ?? "__snapshots__", `${config.cassetteName}.cassette.json`);

function cassetteOf(
  file: string,
  mode: VcrMode,
  hashes: CassetteHashes,
  report: (failure: Error) => Error,
): Cassette {
  if (mode === VcrMode.RECORD_STALE) return Cassette.recordingStale(file, hashes, report);
  const replay = mode === VcrMode.REPLAY || (mode === VcrMode.AUTO && fs.existsSync(file));
  return replay ? Cassette.replaying(file, hashes, report) : Cassette.recording(file, hashes);
}

const decisionRequestOf = ({ model, request }: DecisionSpec): string =>
  requestHashOf({
    model: model.kind === "jev" ? model.model : model.settings.model,
    instructions: request.instructions ?? "",
    input: request.input,
    options: request.options,
  });

/** A judge's decision: recorded from `real`, or replayed under `judge:<name>` and its request. */
async function decideOf(
  cassette: Cassette,
  real: () => ModelGateway,
  spec: DecideSpec,
): Promise<DecisionOutcome> {
  const { model, request } = spec;
  const hash = requestHashOf({ model, state: request.state, questions: request.questions });
  if (!cassette.records(spec.caller)) return cassette.decide(spec.caller, hash);
  const decide = real().decide;
  if (decide === undefined)
    throw new DecisionError({ message: `the recording gateway cannot decide (${model})` });
  const outcome = await decide(spec);
  cassette.record({ kind: "decide", key: spec.caller, request: hash, outcome });
  return outcome;
}

/**
 * A gateway over a cassette: every chat model (agents, judges, compaction) and every decision
 * (routers, guards — Jev and LLM alike) and every judge's `decide` answers from it, or, while recording, from `real`
 * — created on the first recorded call, so a replay never builds a provider client or needs a key.
 */
export function vcrGateway(cassette: Cassette, real: () => ModelGateway): ModelGateway {
  return {
    chatModel: (spec) =>
      new VcrChatModel(cassette, chatKeyOf(spec.user), spec.settings.model, () =>
        real().chatModel(spec),
      ),
    decide: (spec) => decideOf(cassette, real, spec),
    routeTo: async (spec): Promise<RouteOutcome> => {
      const key = routerKeyOf(spec.router);
      const request = decisionRequestOf(spec);
      if (cassette.records(key)) {
        const outcome = await real().routeTo(spec);
        cassette.record({ kind: "decision", key, request, outcome });
        return outcome;
      }
      try {
        return cassette.decision(key, request);
      } catch (error) {
        if (!(error instanceof CassetteMissingError || error instanceof StaleCassetteError))
          throw error;
        return { kind: "failed", reason: error.message };
      }
    },
  };
}

/**
 * The VCR gateway of a test over the real providers' (#439): the application's workflows (their
 * components' hashes), one cassette for every workflow; while recording, the providers' gateway is
 * built as `createApp` builds its own — keys from the test's environment (record with one that
 * holds them), base URLs from `env`, transport providers from the test app's container.
 */
export function vcrGatewayOverProviders(
  workflows: readonly AssembledWorkflow[],
  config: VcrConfig,
  env: NodeJS.ProcessEnv,
  report: (failure: Error) => Error,
): GatewayOverProviders {
  if (workflows.length === 0)
    throw new TestSetupError({ message: "a VCR test needs an application with a workflow" });
  const cassette = cassetteOf(
    cassetteFileOf(config),
    vcrModeOf(config, env),
    cassetteHashesOf(workflows),
    report,
  );
  return (real) => vcrGateway(cassette, real);
}
