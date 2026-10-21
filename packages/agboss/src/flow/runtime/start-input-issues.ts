import type { Class } from "../../components/injection.js";
import { DtoValidationError, type DtoIssue } from "../../dto/errors.js";
import { validate } from "../../dto/schema.js";
import type { DtoClass } from "../../dto/types.js";
import { NodeKind } from "../ast.js";
import { declarationOf, isFieldMap } from "../decorators/declaration.js";
import { Wrapper, type ListWrapper, type ValueShape } from "../dto-wrappers.js";

/**
 * Every problem of a payload for a start's input (#268 AC3), before anything runs — `agboss run
 * --input '<json>'`: one DTO, a `listOf(…)` or a map of fields, each issue with its path from the
 * input's root (`company.name`, `[2].url`, `jobs[0].title`). The execution itself checks the same
 * input again (`validStartInput`); this only lists all problems at once instead of the first.
 */

/** `prefix` + an issue's own path: `company` + `name` → `company.name`, `` + `[2].url`. */
function joined(prefix: string, path: string): string {
  if (path === "(root)") return prefix === "" ? path : prefix;
  if (prefix === "" || path.startsWith("[")) return `${prefix}${path}`;
  return `${prefix}.${path}`;
}

function dtoIssues(dto: DtoClass, value: unknown, prefix: string): DtoIssue[] {
  try {
    validate(dto, value);
    return [];
  } catch (error) {
    if (!(error instanceof DtoValidationError)) throw error;
    return error.issues.map((issue) => ({
      path: joined(prefix, issue.path),
      reason: issue.reason,
    }));
  }
}

function listIssues(list: ListWrapper, value: unknown, prefix: string): DtoIssue[] {
  const { element } = list;
  if (!Array.isArray(value) || typeof element !== "function")
    return [{ path: joined(prefix, "(root)"), reason: "expected a list" }];
  return (value as readonly unknown[]).flatMap((item, index) =>
    dtoIssues(element, item, `${prefix}[${String(index)}]`),
  );
}

function fieldIssues(shape: ValueShape, value: unknown, prefix: string): DtoIssue[] {
  if (typeof shape === "function") return dtoIssues(shape, value, prefix);
  if (shape.kind === Wrapper.List) return listIssues(shape, value, prefix);
  return value === undefined ? [] : fieldIssues(shape.inner, value, prefix);
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The issues of `payload` as the input of `start`; empty when it fits. */
export function startInputIssuesOf(start: Class, payload: unknown): readonly DtoIssue[] {
  const declaration = declarationOf(start);
  if (declaration?.kind !== NodeKind.Start) throw new TypeError(`${start.name} is not a start`);
  const { input } = declaration.options;
  if (!isFieldMap(input)) return fieldIssues(input, payload, "");
  if (!isRecord(payload)) return [{ path: "(root)", reason: "expected an object of fields" }];
  return Object.entries(input).flatMap(([name, shape]) => fieldIssues(shape, payload[name], name));
}
