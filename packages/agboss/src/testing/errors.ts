/** Codes of the testing toolkit's failures — stable, so a test can expect them. */
export type TestFailureCode =
  | "test.live-call-blocked"
  | "test.script-exhausted"
  | "test.not-a-route"
  | "test.wrong-script"
  | "test.app-closed"
  | "test.cassette-missing"
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

/** The test itself is set up wrong: `mockOf` / `mcpOf` of something the workflow does not use. */
export class TestSetupError extends Error {
  override name = "TestSetupError";
}

/** Anything thrown, as an Error. */
export const asError = (thrown: unknown): Error =>
  thrown instanceof Error ? thrown : new Error(String(thrown));
