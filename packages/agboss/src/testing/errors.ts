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
  | "test.unreachable-step";

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

/** The test itself is set up wrong: `mockOf` / `mcpOf` of something the workflow does not use. */
export class TestSetupError extends Error {
  override name = "TestSetupError";
}

/** Anything thrown, as an Error. */
export const asError = (thrown: unknown): Error =>
  thrown instanceof Error ? thrown : new Error(String(thrown));
