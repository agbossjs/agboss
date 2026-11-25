import { ConfigError } from "../../core/error-families/config-errors.js";
import { fieldsOf } from "../../dto/metadata.js";
import type { DtoClass } from "../../dto/types.js";
import { violation, type RuleViolation } from "../../graph/rule-error.js";
import { executionFieldsOf, tenantFieldsOf } from "./context-values.js";
import type { ExecutionContextClass, TenantContextClass } from "./context-values.js";

/**
 * The rules of the context subclasses an application declares (#261), checked at its assembly
 * (`createApp`, `testWith`, `agboss check`): every field has a field decorator, and none has a
 * `prompt` — no model reads a context; the field's name is its meaning.
 */

/** The context classes an application declares (absent = the built-in level). */
export interface DeclaredContexts {
  readonly tenantContext?: TenantContextClass | undefined;
  readonly executionContext?: ExecutionContextClass | undefined;
}

/**
 * The names the framework's contexts own (#1316f): a project's subclass adds fields beside them and
 * never declares one — a field named `tenantId` or `ownerId` would shadow what the framework sets
 * (tenant isolation, ownership), so `[context.reserved-field]` refuses it at assembly.
 */
const RESERVED_FIELDS: ReadonlySet<string> = new Set([
  "executionId",
  "threadId",
  "ownerId",
  "tenant",
  "tenantId",
  "weight",
  "application",
  "signal",
  "workflow",
  "step",
  "itemIndex",
  "parent",
  "root",
  "depth",
  "origin",
  "executionOf",
  "handledError",
  "compensation",
  "onInterrupted",
]);

/** `[context.reserved-field]`: a field of a context that shadows one the framework owns. */
function reservedViolations(application: string, type: DtoClass): RuleViolation[] {
  return fieldsOf(type)
    .filter((field) => RESERVED_FIELDS.has(field.name))
    .map((field) =>
      violation(
        "context.reserved-field",
        `${type.name}.${field.name} shadows a field the framework sets on every context — rename it`,
        [application],
      ),
    );
}

/** `[context.prompt-unused]`: a field of a context with a `prompt`. */
function promptViolations(application: string, type: DtoClass): RuleViolation[] {
  return fieldsOf(type)
    .filter((field) => field.settings.prompt !== undefined)
    .map((field) =>
      violation(
        "context.prompt-unused",
        `${type.name}.${field.name} has a prompt — no model reads a context; remove it`,
        [application],
      ),
    );
}

/** Runs `check` (a validation of empty values): only the class's own checks may fail it. */
function checkFields(check: () => unknown): void {
  try {
    check();
  } catch (error) {
    // an undecorated field (`ConfigError.Dto`) fails the start; missing values are the execution's business
    if (error instanceof ConfigError.Dto) throw error;
  }
}

/**
 * Every field of the declared context classes has a field decorator — else `ConfigError.Dto`
 * (`dto.undecorated-field`), at the application's assembly, before any execution.
 */
export function checkContextFields(declared: DeclaredContexts): void {
  const { tenantContext, executionContext } = declared;
  if (tenantContext !== undefined) checkFields(() => tenantFieldsOf(tenantContext, {}));
  if (executionContext !== undefined) checkFields(() => executionFieldsOf(executionContext, {}));
}

/** `[context.prompt-unused]` and `[context.reserved-field]` for the fields of the declared context classes. */
export function contextRuleViolations(
  application: string,
  declared: DeclaredContexts,
): RuleViolation[] {
  const declaredClasses = [declared.tenantContext, declared.executionContext];
  return declaredClasses.flatMap((type) =>
    type === undefined
      ? []
      : [
          ...promptViolations(application, type as DtoClass),
          ...reservedViolations(application, type as DtoClass),
        ],
  );
}
