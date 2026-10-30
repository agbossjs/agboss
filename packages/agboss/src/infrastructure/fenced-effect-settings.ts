import { EXECUTION_LEASE } from "../app/lease-fence.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import { hours, kilobytes, type Bytes, type Milliseconds } from "../units/index.js";

/** `@Application({ fencedEffects })` (#500): the largest result and how long rows are kept. */
export interface FencedEffectsOptions {
  /** The largest stored result, in UTF-8 bytes of its JSON (default `kilobytes(64)`). */
  readonly maxResultSize?: Bytes;
  /**
   * How long a stored result and a scope's mark are kept (default `hours(24)`), then removed by
   * the recovery sweep on the `Clock` — above the lease's 30 s, so a late zombie is still refused.
   */
  readonly retention?: Milliseconds;
}

/** The default largest result: 64 KB — a receipt, not a document. */
export const DEFAULT_FENCED_EFFECT_RESULT_SIZE: Bytes = kilobytes(64);

/** The default retention: a day. */
export const DEFAULT_FENCED_EFFECT_RETENTION: Milliseconds = hours(24);

/**
 * The application's fenced-effect settings, as a fenced-effect store reads them (#500): a DI token
 * of the application's container — `@Injectable({ deps: [SqliteConnection, Clock,
 * FencedEffectSettings] })` for a store of your own.
 */
export class FencedEffectSettings {
  /** The largest stored result, in UTF-8 bytes of its JSON. */
  readonly maxResultSize: Bytes;
  /** How long stored results and marks are kept. */
  readonly retention: Milliseconds;

  constructor(options: FencedEffectsOptions = {}) {
    this.maxResultSize = options.maxResultSize ?? DEFAULT_FENCED_EFFECT_RESULT_SIZE;
    this.retention = options.retention ?? DEFAULT_FENCED_EFFECT_RETENTION;
    Object.freeze(this);
  }
}

/**
 * `@Application({ fencedEffects })` (#500): a positive `maxResultSize`, and a `retention` above the
 * lease (30 s) — a mark removed sooner would let a zombie's late write through.
 */
export function fencedEffectsViolations(
  application: string,
  options: FencedEffectsOptions | undefined,
): RuleViolation[] {
  const problems: string[] = [];
  const { maxResultSize, retention } = options ?? {};
  if (maxResultSize !== undefined && !(maxResultSize > 0))
    problems.push(`maxResultSize is ${String(maxResultSize)} bytes, not a positive size`);
  if (retention !== undefined && !(retention > EXECUTION_LEASE))
    problems.push(
      `retention is ${String(retention)} ms, not above the lease's ${String(EXECUTION_LEASE)} ms`,
    );
  return problems.map((problem) =>
    violation(
      "application.fenced-effects-invalid",
      `its fencedEffects.${problem} — @Application({ fencedEffects: { maxResultSize: kilobytes(64), retention: hours(24) } })`,
      [application],
    ),
  );
}
