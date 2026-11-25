import { ConfigError } from "../core/error-families/config-errors.js";
import { ValidationError } from "../core/error-families/effect-errors.js";

/** What went wrong with a DTO class itself (found at registration, before any data). */
export type DtoClassProblem =
  "dto.undecorated-field" | "dto.not-plain-data" | "dto.no-metadata" | "dto.cyclic";

/** What a DTO class error takes: why, and the sentence naming the class and fields. */
export interface DtoClassProblemOptions {
  readonly code: DtoClassProblem;
  readonly message: string;
  readonly cause?: unknown;
}

/** A DTO class that cannot be used (`ConfigError.Dto`): the reason leads the message, the class and fields follow. */
export function dtoClassError(options: DtoClassProblemOptions): ConfigError.Dto {
  const { code, message, cause } = options;
  return new ConfigError.Dto({ message: `${code}: ${message}`, cause, details: { reason: code } });
}

/** One rejected value: where (`jobs[2].url`) and why. */
export interface DtoIssue {
  readonly path: string;
  readonly reason: string;
}

/** What invalid data takes: the DTO's name and each issue. */
export interface InvalidDtoOptions {
  /** The DTO class's name. */
  readonly dto: string;
  readonly issues: readonly DtoIssue[];
  readonly cause?: unknown;
}

/** Data that does not fit a DTO (`ValidationError.DtoInvalid`): every issue with its field path and reason. */
export function invalidDto(options: InvalidDtoOptions): ValidationError.DtoInvalid {
  const { dto, issues, cause } = options;
  return new ValidationError.DtoInvalid({
    message: `invalid ${dto}: ${issues.map((i) => `${i.path}: ${i.reason}`).join("; ")}`,
    dto,
    issues,
    cause,
  });
}

/** A zod issue path as people write it: `jobs[2].url`, `(root)` for the whole value. */
export function pathOf(path: readonly PropertyKey[]): string {
  const text = path
    .map((key) => (typeof key === "number" ? `[${String(key)}]` : `.${String(key)}`))
    .join("")
    .replace(/^\./, "");
  return text === "" ? "(root)" : text;
}
