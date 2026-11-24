import { chainOf, formatError, userSpanOf } from "./error-report.js";
import type { ErrorDiagnostics, ErrorFormatOptions } from "./error-report.js";
import { currentSpanTrace } from "./span-trace.js";

/**
 * What an error carries for its report (#1325c): kept apart from its own properties, so it is never
 * compared, serialized or spread into a record — and its class line, which a record keeps, is the
 * one it had before: the report's members are put on `AGBossError`'s prototype, no class between.
 */
const DIAGNOSTICS = new WeakMap<Error, ErrorDiagnostics>();

const diagnosticsOf = (error: Error): ErrorDiagnostics => DIAGNOSTICS.get(error) ?? {};

const NONE: readonly never[] = Object.freeze([]);

/** Keeps what the thrower said and the spans around the current execution; nothing when there is none. */
export function keepDiagnostics(error: Error, options: ErrorDiagnostics): void {
  const { location, secondarySpans, notes, help, suggestionPatch } = options;
  const spanTrace = options.spanTrace ?? currentSpanTrace();
  const given = { location, secondarySpans, notes, help, suggestionPatch };
  if (spanTrace.length === 0 && Object.values(given).every((value) => value === undefined)) return;
  DIAGNOSTICS.set(error, {
    ...Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)),
    ...(spanTrace.length === 0 ? {} : { spanTrace }),
  });
}

/** `console.log(error)`, an uncaught error and `util.inspect` print the report. */
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

type ReportedMember = (this: Error) => unknown;

/** A read-only member of the report: `error.location`, `error.notes`, … */
const reading = (read: ReportedMember): PropertyDescriptor => ({ get: read, configurable: true });

/** A method of the report: `error.chain()`, `error.format(options?)`. */
const calling = (call: (this: Error, ...args: never[]) => unknown): PropertyDescriptor => ({
  value: call,
  writable: true,
  configurable: true,
});

/**
 * Puts the report's members on `prototype` (`AGBossError.prototype`): `location`, `secondarySpans`,
 * `spanTrace`, `notes`, `help`, `suggestionPatch`, `chain()`, `format(options?)` and the inspect hook.
 * `isFramework` tells an error whose message is the framework's own sentence from any other.
 */
export function installReportMembers(
  prototype: Error,
  isFramework: (error: Error) => boolean,
): void {
  const report = function (this: Error, options?: ErrorFormatOptions): string {
    return formatError(this as never, isFramework, options);
  };
  Object.defineProperties(prototype, {
    location: reading(function () {
      return diagnosticsOf(this).location ?? userSpanOf(this);
    }),
    secondarySpans: reading(function () {
      return diagnosticsOf(this).secondarySpans ?? NONE;
    }),
    spanTrace: reading(function () {
      return diagnosticsOf(this).spanTrace ?? NONE;
    }),
    notes: reading(function () {
      return diagnosticsOf(this).notes ?? NONE;
    }),
    help: reading(function () {
      return diagnosticsOf(this).help;
    }),
    suggestionPatch: reading(function () {
      return diagnosticsOf(this).suggestionPatch;
    }),
    chain: calling(function () {
      return chainOf(this);
    }),
    format: calling(report as never),
    [INSPECT]: calling(function () {
      return report.call(this);
    }),
  });
}
