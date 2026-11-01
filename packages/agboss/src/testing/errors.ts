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

/** A failure the toolkit raises for a test: it carries a stable code. */
export class TestFailure extends Error {
  override name = "TestFailure";
  readonly code: TestFailureCode;

  constructor(code: TestFailureCode, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/** A model, an MCP server or a network host a test would reach — stopped before the call. */
export class LiveCallBlockedError extends TestFailure {
  override name = "LiveCallBlockedError";

  constructor(message: string) {
    super("test.live-call-blocked", message);
  }
}

/**
 * A VCR replay found no recording: the cassette file is missing, or it holds no interaction for
 * this request (a prompt, tool or input changed since it was recorded) — re-record it.
 */
export class CassetteMissingError extends TestFailure {
  override name = "CassetteMissingError";

  constructor(message: string) {
    super("test.cassette-missing", message);
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

/**
 * A VCR replay met a component that changed since its interactions were recorded (#395 PR 4): its
 * prompt or schema hash is not the one the cassette holds, or the application no longer has it —
 * the recording answers a request that no longer happens. `agboss check --cassettes` reports the
 * same without running the tests.
 */
export class StaleCassetteError extends TestFailure {
  override name = "StaleCassetteError";
  /** The cassette file. */
  readonly file: string;
  /** The component whose recordings are stale (its `name`). */
  readonly component: string;
  readonly changes: readonly CassetteChange[];

  constructor(file: string, component: string, changes: readonly CassetteChange[]) {
    super(
      "vcr.stale-cassette",
      `${file}: ${component} changed since it was recorded (${changes.join(", ")}) — ${RE_RECORD_STALE}`,
    );
    this.file = file;
    this.component = component;
    this.changes = changes;
  }
}

/**
 * A test's app did not close within its bound of real time (#509): an execution still running — a
 * frozen step, a stalled lease, a wait on the `VirtualClock` nobody advances — would keep the
 * test's teardown waiting forever, and vitest bounds no fixture's teardown.
 */
export class AppCloseTimeoutError extends TestFailure {
  override name = "AppCloseTimeoutError";

  constructor(instance: number, timeout: number) {
    super(
      "test.close-timeout",
      `instance ${String(instance)} of the test's application did not close within ${String(timeout)} ms ` +
        "of real time — an execution still runs (a frozen step, a stalled lease, a wait on the " +
        "VirtualClock nobody advances); the test's own failure, if any, is the cause",
    );
  }
}

/**
 * `VirtualClock.advance` waited for work it tracks (a store call of a contract suite, `clock.track`)
 * longer than its `settleTimeout` in real time (#511): a call that never settles fails the test by
 * name instead of hanging it.
 */
export class UnsettledWorkError extends TestFailure {
  override name = "UnsettledWorkError";
  /** How many tracked calls were still in flight. */
  readonly inFlight: number;

  constructor(inFlight: number, settleTimeout: number, isLoad = false) {
    super(
      "test.unsettled-work",
      isLoad
        ? `${String(inFlight)} lazy load(s) of the core did not settle within ${String(settleTimeout)} ms ` +
            "of real time — a module that does not load, or a project file loaded by path that waits on the test's clock"
        : `${String(inFlight)} tracked call(s) did not settle within ${String(settleTimeout)} ms of real ` +
            "time — a store call that never resolves (a lost connection, a missing reply)",
    );
    this.inFlight = inFlight;
  }
}

/** The test itself is set up wrong: `mockOf` / `mcpOf` of something the workflow does not use. */
export class TestSetupError extends Error {
  override name = "TestSetupError";
}

/** Anything thrown, as an Error. */
export const asError = (thrown: unknown): Error =>
  thrown instanceof Error ? thrown : new Error(String(thrown));
