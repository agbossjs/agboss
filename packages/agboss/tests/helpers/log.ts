import { Injectable } from "../../src/components/decorators.js";
import { Logger, type LogEntry, type FrameworkLog } from "../../src/infrastructure/logger.js";

/**
 * The framework's log in tests (#261): `RecordingLogger` is a `Logger` an application lists in its
 * providers (the real path — tests read the log only through a listed one); `recordingLog()` is
 * the framework's side for a unit that takes a log directly.
 */

/** Every entry a `RecordingLogger` wrote, in order (reset with `resetLogged`). */
export const logged: LogEntry[] = [];

export function resetLogged(): void {
  logged.length = 0;
}

/** A `Logger` that keeps every entry in `logged`. */
@Injectable()
export class RecordingLogger extends Logger {
  write(entry: LogEntry): void {
    logged.push(entry);
  }
}

/** One entry as a unit test checks it: level, code and message. */
export interface SeenLogEntry {
  readonly level: string;
  readonly code: string;
  readonly message: string;
}

/** A framework log that keeps what it is told. */
export function recordingLog(): { readonly log: FrameworkLog; readonly entries: SeenLogEntry[] } {
  const entries: SeenLogEntry[] = [];
  const at =
    (level: string) =>
    (code: string, message: string): void => {
      entries.push({ level, code, message });
    };
  return { log: { info: at("info"), warn: at("warn"), error: at("error") }, entries };
}
