/**
 * #1366 (ledger-run shard) — the errors of resuming and recovering a run are told apart by their code and their name:
 * a caller (and a log reading `error.name`) tells a run that is not paused from a pause it has not got,
 * and a run with nothing to recover.
 */
import { PauseError } from "../../src/core/error-families/pause-errors.js";
import { describe, expect, it } from "vitest";
import { AGBossError } from "../../src/core/errors.js";
import { NothingToRecoverError } from "../../src/run/continue-agent.js";
import { NotPausedError } from "../../src/run/resume-agent.js";

describe("#1366: the errors of resuming and recovering a run", () => {
  it.each([
    [NotPausedError, "NotPausedError", "run.not-paused"],
    [PauseError.UnknownPause, "PauseError.UnknownPause", "pause.unknown-pause"],
    [NothingToRecoverError, "NothingToRecoverError", "execution.nothing-to-recover"],
  ])("%s has its own name and code, and says what it was given", (ErrorClass, name, code) => {
    const error = new ErrorClass({ message: "what happened" });

    expect(error).toBeInstanceOf(AGBossError);
    expect(error.name).toBe(name);
    expect(ErrorClass.code).toBe(code);
    expect(error.message).toBe("what happened");
  });
});
