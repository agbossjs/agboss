import { AGBossError } from "../core/errors.js";
/** What went wrong with a DTO class itself (found at registration, before any data). */
export type DtoErrorCode = "dto.undecorated-field" | "dto.not-plain-data" | "dto.no-metadata";

/** What a DTO class error takes (#906): why, and the sentence naming the class and fields. */
export interface DtoErrorOptions {
  readonly code: DtoErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}

/** A DTO class that cannot be used: the code says why, the message names the class and fields. */
export class DtoError extends AGBossError {
  static override readonly code: string = "dto";
  declare readonly code: DtoErrorCode;
  override name = "DtoError";

  constructor(options: DtoErrorOptions) {
    super(`${options.code}: ${options.message}`, options);
    this.code = options.code;
  }
}

/** One rejected value: where (`jobs[2].url`) and why. */
export interface DtoIssue {
  readonly path: string;
  readonly reason: string;
}

/** What invalid data takes (#906): the DTO and each issue. */
export interface DtoValidationErrorOptions {
  /** The DTO class's name. */
  readonly dto: string;
  readonly issues: readonly DtoIssue[];
  readonly cause?: unknown;
}

/** Data that does not fit a DTO: every issue with its field path and reason. */
export class DtoValidationError extends AGBossError {
  static override readonly code = "dto.invalid" as const;
  declare readonly code: typeof DtoValidationError.code;
  override name = "DtoValidationError";
  /** The DTO class's name. */
  readonly dto: string;
  /** Each value that failed, by path. */
  readonly issues: readonly DtoIssue[];

  constructor(options: DtoValidationErrorOptions) {
    const { dto, issues, cause } = options;
    super(`invalid ${dto}: ${issues.map((i) => `${i.path}: ${i.reason}`).join("; ")}`, { cause });
    this.dto = dto;
    this.issues = issues;
  }
}

/** A zod issue path as people write it: `jobs[2].url`, `(root)` for the whole value. */
export function pathOf(path: readonly PropertyKey[]): string {
  const text = path
    .map((key) => (typeof key === "number" ? `[${String(key)}]` : `.${String(key)}`))
    .join("")
    .replace(/^\./, "");
  return text === "" ? "(root)" : text;
}
