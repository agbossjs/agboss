import { systemClock } from "../infrastructure/clock.js";
import fs from "node:fs";
import path from "node:path";
import { DecisionError } from "../llm/decision-errors.js";
import type { DecisionOutcome } from "../llm/decision-response.js";
import type { Environment } from "../flow/generated-types.js";
import { NO_ENVIRONMENT_VALUES } from "../environments/resolve.js";
import {
  createProviderGateway,
  type DecideSpec,
  type DecisionSpec,
  type ModelGateway,
} from "../llm/gateway.js";
import { directoryOf } from "../models/workflow-models.js";
import type { RouteOutcome } from "../routers/index.js";
import type { AssembledWorkflow } from "../workflow.js";
import { CassetteMissingError, StaleCassetteError, TestSetupError } from "./errors.js";
import { cassetteHashesOf, type CassetteHashes } from "./vcr-hashes.js";
import { chatKeyOf, routerKeyOf } from "./scripted-gateway.js";
import { Cassette, requestHashOf } from "./vcr-cassette.js";
import { VcrChatModel } from "./vcr-chat-model.js";

export enum VCRMode {
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

const MODES: ReadonlySet<string> = new Set(Object.values(VCRMode));

const isVcrMode = (value: string): value is VCRMode => MODES.has(value);

/** `AGBOSS_VCR_MODE`, when set: a member's value, else the test fails naming the values. */
function modeFromEnv(env: NodeJS.ProcessEnv): VCRMode | undefined {
  const value = env[VCR_MODE_VARIABLE];
  if (value === undefined || value === "") return undefined;
  if (isVcrMode(value)) return value;
  throw new TestSetupError(
    `${VCR_MODE_VARIABLE}=${value} is not a VCR mode: one of ${[...MODES].join(", ")}`,
  );
}

/** `testWith(W, { vcr })`: record real model calls once, replay them in every later run. */
export interface VcrConfig {
  readonly cassetteName: string;
  /** Default: REPLAY when `CI` is set (CI never calls a model), else AUTO. */
  readonly mode?: VCRMode;
  /** Where `<cassetteName>.cassette.json` lives; default `__snapshots__` (from the working directory). */
  readonly dir?: string;
}

const isCi = (env: NodeJS.ProcessEnv): boolean =>
  env.CI !== undefined && !["", "0", "false"].includes(env.CI.toLowerCase());

/**
 * The mode a VCR test runs in: `AGBOSS_VCR_MODE` when set (it re-records tests that name their own
 * mode too), else the given one; REPLAY under `CI`; else AUTO.
 */
export const vcrModeOf = (config: VcrConfig, env: NodeJS.ProcessEnv): VCRMode =>
  modeFromEnv(env) ?? config.mode ?? (isCi(env) ? VCRMode.REPLAY : VCRMode.AUTO);

export const cassetteFileOf = (config: VcrConfig): string =>
  path.join(config.dir ?? "__snapshots__", `${config.cassetteName}.cassette.json`);

function cassetteOf(
  file: string,
  mode: VCRMode,
  hashes: CassetteHashes,
  report: (failure: Error) => Error,
): Cassette {
  if (mode === VCRMode.RECORD_STALE) return Cassette.recordingStale(file, hashes, report);
  const replay = mode === VCRMode.REPLAY || (mode === VCRMode.AUTO && fs.existsSync(file));
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
    throw new DecisionError(`the recording gateway cannot decide (${model})`);
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

/** Where a recording reads its settings: the process, and the test's environment (its keys). */
export interface VcrEnvironments {
  readonly env: NodeJS.ProcessEnv;
  readonly environment?: Environment | undefined;
}

/**
 * The VCR gateway of a test: the application's workflows (their components' hashes) and the real
 * providers behind the cassette — keys from the
 * test's environment (`environment`, record with one that holds them), base URLs from `env`.
 */
export function createVcrGateway(
  workflows: readonly AssembledWorkflow[],
  config: VcrConfig,
  { env, environment = NO_ENVIRONMENT_VALUES }: VcrEnvironments,
  report: (failure: Error) => Error,
): ModelGateway {
  const [bundle] = workflows;
  if (bundle === undefined)
    throw new TestSetupError("a VCR test needs an application with a workflow");
  const hashes = cassetteHashesOf(workflows);
  const cassette = cassetteOf(cassetteFileOf(config), vcrModeOf(config, env), hashes, report);
  let real: ModelGateway | undefined;
  return vcrGateway(
    cassette,
    () =>
      (real ??= createProviderGateway(
        directoryOf(bundle.modelProviders),
        // recording talks to the real providers: in real time, no rate limit or breaker of a test
        { env, environment, clock: systemClock },
      )),
  );
}
