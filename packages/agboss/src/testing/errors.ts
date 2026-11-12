import { causeOptionOf, type PlainErrorOptions } from "../core/errors.js";

/** Codes of the testing toolkit's failures — stable, so a test can expect them. */
export type TestFailureCode =
  | "test.live-call-blocked"
  | "test.script-exhausted"
  | "test.not-a-route"
  | "test.wrong-script"
  | "test.app-closed"
  | "test.app-not-ready"
  | "test.cassette-missing"
  | "vcr.stale-cassette"
  | "test.no-matching-script"
  | "test.unused-script"
  | "test.unreachable-step"
  | "test.close-timeout"
  | "test.unsettled-work";

/** What a test failure takes (#906): its code, the sentence, and the cause when there is one. */
export interface TestFailureOptions {
  readonly code: TestFailureCode;
  readonly message: string;
  readonly cause?: unknown;
}

/** A failure the toolkit raises for a test: it carries a stable code. */
export class TestFailure extends Error {
  override name = "TestFailure";
  readonly code: TestFailureCode;

  constructor(options: TestFailureOptions) {
    super(`${options.code}: ${options.message}`, causeOptionOf(options.cause));
    this.code = options.code;
  }
}

/** A model, an MCP server or a network host a test would reach — stopped before the call. */
export class LiveCallBlockedError extends TestFailure {
  static readonly code = "test.live-call-blocked" as const;
  declare readonly code: typeof LiveCallBlockedError.code;
  override name = "LiveCallBlockedError";

  constructor(options: PlainErrorOptions) {
    super({ ...options, code: LiveCallBlockedError.code });
  }
}

/**
 * A VCR replay found no recording: the cassette file is missing, or it holds no interaction for
 * this request (a prompt, tool or input changed since it was recorded) — re-record it.
 */
export class CassetteMissingError extends TestFailure {
  static readonly code = "test.cassette-missing" as const;
  declare readonly code: typeof CassetteMissingError.code;
  override name = "CassetteMissingError";

  constructor(options: PlainErrorOptions) {
    super({ ...options, code: CassetteMissingError.code });
  }
}

/** What changed in a component since its interactions were recorded. */
export enum CassetteChange {
  /** What its model is told: an agent's instructions, a model router's prompt and routes. */
  Prompt = "prompt",
  /** What it reads and writes: its input and output DTOs. */
  Schema = "schema",
  /** The application no longer has it. */
  Removed = "removed",
}

/** How a stale cassette is brought up to date: its stale interactions re-recorded, then the evals. */
export const RE_RECORD_STALE =
  "re-record its stale interactions with AGBOSS_VCR_MODE=RECORD_STALE npm test (never edit a cassette by hand), then run the evals";

/** What a stale cassette takes (#906): the file, the component and what changed in it. */
export interface StaleCassetteErrorOptions {
  readonly file: string;
  readonly component: string;
  readonly changes: readonly CassetteChange[];
  readonly cause?: unknown;
}

/**
 * A VCR replay met a component that changed since its interactions were recorded (#395 PR 4): its
 * prompt or schema hash is not the one the cassette holds, or the application no longer has it —
 * the recording answers a request that no longer happens. `agboss check --cassettes` reports the
 * same without running the tests.
 */
export class StaleCassetteError extends TestFailure {
  static readonly code = "vcr.stale-cassette" as const;
  declare readonly code: typeof StaleCassetteError.code;
  override name = "StaleCassetteError";
  /** The cassette file. */
  readonly file: string;
  /** The component whose recordings are stale (its `name`). */
  readonly component: string;
  readonly changes: readonly CassetteChange[];

  constructor(options: StaleCassetteErrorOptions) {
    const { file, component, changes, cause } = options;
    super({
      code: StaleCassetteError.code,
      message: `${file}: ${component} changed since it was recorded (${changes.join(", ")}) — ${RE_RECORD_STALE}`,
      cause,
    });
    this.file = file;
    this.component = component;
    this.changes = changes;
  }
}

/** What a close timeout takes (#906): the instance and the bound it was given. */
export interface AppCloseTimeoutErrorOptions {
  readonly instance: number;
  readonly timeout: number;
  readonly cause?: unknown;
}

/**
 * A test's app did not close within its bound of real time (#509): an execution still running — a
 * frozen step, a frozen lease, a wait on the `VirtualClock` nobody advances — would keep the
 * test's teardown waiting forever, and vitest bounds no fixture's teardown.
 */
export class AppCloseTimeoutError extends TestFailure {
  static readonly code = "test.close-timeout" as const;
  declare readonly code: typeof AppCloseTimeoutError.code;
  override name = "AppCloseTimeoutError";
  /** The application instance that did not close. */
  readonly instance: number;
  /** The bound it was given, in ms of real time. */
  readonly timeout: number;

  constructor(options: AppCloseTimeoutErrorOptions) {
    const { instance, timeout, cause } = options;
    super({
      code: AppCloseTimeoutError.code,
      message:
        `instance ${String(instance)} of the test's application did not close within ${String(timeout)} ms ` +
        "of real time — an execution still runs (a frozen step, a frozen lease, a wait on the " +
        "VirtualClock nobody advances); the test's own failure, if any, is the cause",
      cause,
    });
    this.instance = instance;
    this.timeout = timeout;
  }
}

/** What unsettled work takes (#906): how many calls, the bound, and whether they were lazy loads. */
export interface UnsettledWorkErrorOptions {
  readonly inFlight: number;
  readonly settleTimeout: number;
  readonly isLoad?: boolean;
  readonly cause?: unknown;
}

/**
 * `VirtualClock.advance` waited for work it tracks (a store call of a contract suite, `clock.track`)
 * longer than its `settleTimeout` in real time (#511): a call that never settles fails the test by
 * name instead of hanging it.
 */
export class UnsettledWorkError extends TestFailure {
  static readonly code = "test.unsettled-work" as const;
  declare readonly code: typeof UnsettledWorkError.code;
  override name = "UnsettledWorkError";
  /** How many tracked calls were still in flight. */
  readonly inFlight: number;
  /** The bound it was given, in ms of real time. */
  readonly settleTimeout: number;
  /** Whether the work was lazy loads of the core, not store calls. */
  readonly isLoad: boolean;

  constructor(options: UnsettledWorkErrorOptions) {
    const { inFlight, settleTimeout, isLoad = false, cause } = options;
    super({
      code: UnsettledWorkError.code,
      message: isLoad
        ? `${String(inFlight)} lazy load(s) of the core did not settle within ${String(settleTimeout)} ms ` +
          "of real time — a module that does not load, or a project file loaded by path that waits on the test's clock"
        : `${String(inFlight)} tracked call(s) did not settle within ${String(settleTimeout)} ms of real ` +
          "time — a store call that never resolves (a lost connection, a missing reply)",
      cause,
    });
    this.inFlight = inFlight;
    this.settleTimeout = settleTimeout;
    this.isLoad = isLoad;
  }
}

/** The test itself is set up wrong: `mockOf` / `mcpOf` of something the workflow does not use. */
export class TestSetupError extends Error {
  static readonly code = "test.setup" as const;
  readonly code = TestSetupError.code;
  override name = "TestSetupError";

  constructor(options: PlainErrorOptions) {
    super(options.message, causeOptionOf(options.cause));
  }
}

/** Anything thrown, as an Error. */
export const asError = (thrown: unknown): Error =>
  thrown instanceof Error ? thrown : new Error(String(thrown));
