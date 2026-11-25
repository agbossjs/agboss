import type { TracerProvider } from "@opentelemetry/api";
import type { Class } from "../components/injection.js";
import type { ApplicationAssembly } from "../application/assembly-options.js";
import { TEST_DEFAULT_PROFILE, type ProfileSelection } from "../config/profile-names.js";
import type { TracingAdapter } from "../tracing/index.js";

/** What `testWith` replaces of the application's own settings (#1328). */
export interface TestWithSeams {
  /** Replaces the application's `modelProvider` (#1328), as a profile's would: no implicit free provider — a test names its own. */
  readonly modelProvider?: Class | undefined;
  /** The `@Channel`s of the test, replacing the application's own `channels` (#1307, #1328). */
  readonly channels?: readonly Class[] | undefined;
  /** When the test's clock starts (#1328): a `Date` or an ISO 8601 text; default 2026-01-05 09:00 UTC. */
  readonly startAt?: Date | string | undefined;
  /** Where the application's spans go (#1328): tracing is on only with a `tracerProvider`. */
  readonly tracerProvider?: TracerProvider | TracingAdapter | undefined;
}

/** How a test's application is assembled: its profile (default `test`), no idempotency keys, its replacements. */
export const assemblyOf = (
  options: TestWithSeams & { readonly profile?: ProfileSelection | undefined },
): ApplicationAssembly => ({
  profile: options.profile,
  defaultProfile: TEST_DEFAULT_PROFILE,
  withoutIdempotencyKeys: true,
  replacements: { modelProvider: options.modelProvider, channels: options.channels },
});

/** The build option of the test's spans: none without a `tracerProvider`. */
export const tracingOf = ({
  tracerProvider,
}: TestWithSeams): { readonly tracerProvider?: TracerProvider | TracingAdapter } =>
  tracerProvider === undefined ? {} : { tracerProvider };
