import type { TracerProvider } from "@opentelemetry/api";
import type { TracingAdapter } from "../../tracing/types.js";
import { builtApplicationOf, type BuildApplicationOptions } from "../../application/create-app.js";
import type { ProfileSelection } from "../../config/profile-names.js";
import type { Class } from "../../components/injection.js";
import type { ChaosOptions } from "../chaos/chaos-failure.js";
import type { EvalRunReport } from "./report.js";
import { runSuiteOn } from "./run-suite.js";

/**
 * `runEvalSuite(Application, Suite, options?)` (#1328d, `@agboss/core/eval`): the suite run in code,
 * as `agboss eval run` runs it — the application built as `createApp` builds it, every case run
 * `runs` times, the artifact returned and the application closed.
 */

/** What a run of a suite takes. */
export interface RunEvalSuiteOptions {
  /** The profiles the application is built with (`--profile`): `"economy"`, `["prod", "economy"]`. */
  readonly profile?: ProfileSelection | undefined;
  /** How many times each case runs — the k of pass@k and pass^k; default 1. */
  readonly runs?: number;
  /** `--chaos`: failures injected into the candidate's model calls, never into a judge's. */
  readonly chaos?: ChaosOptions;
  /** `--metamorphic`: every case's `variants` run too, as the check `metamorphic`. */
  readonly metamorphic?: boolean;
  /** Where the run's spans go; the application closes an adapter it was given. */
  readonly tracerProvider?: TracerProvider | TracingAdapter;
  /** The process environment: model provider keys, MCP servers, stores. Default `process.env`. */
  readonly processEnv?: NodeJS.ProcessEnv;
}

/** The profile as the report's header names it: layers joined with `+`. */
const profileTextOf = (profile: ProfileSelection | undefined): string | undefined =>
  profile === undefined ? undefined : typeof profile === "string" ? profile : profile.join("+");

/** `runEvalSuite` with the model gateway (and the other seams of the internal build path) replaced: a test's scripted models (`@agboss/core/internal`). */
export async function runEvalSuiteWith(
  application: Class,
  suite: Class,
  options: RunEvalSuiteOptions & { readonly seams?: Pick<BuildApplicationOptions, "gateway"> } = {},
): Promise<EvalRunReport> {
  const built = await builtApplicationOf(application, {
    ...options.seams,
    ...(options.chaos === undefined ? {} : { chaos: options.chaos }),
    profile: options.profile,
    ...(options.tracerProvider === undefined ? {} : { tracerProvider: options.tracerProvider }),
    ...(options.processEnv === undefined ? {} : { processEnv: options.processEnv }),
  });
  try {
    const profile = profileTextOf(options.profile);
    return await runSuiteOn(built, suite, {
      runs: options.runs ?? 1,
      ...(profile === undefined ? {} : { profile }),
      ...(options.chaos === undefined ? {} : { chaos: options.chaos }),
      ...(options.metamorphic === true ? { metamorphic: true } : {}),
    });
  } finally {
    await built.app.close();
  }
}

/** Runs `suite` on a new instance of `application`, closed after the run. */
export const runEvalSuite = (
  application: Class,
  suite: Class,
  options: RunEvalSuiteOptions = {},
): Promise<EvalRunReport> => runEvalSuiteWith(application, suite, options);
