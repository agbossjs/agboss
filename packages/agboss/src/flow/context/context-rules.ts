import { DtoError } from "../../dto/errors.js";
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
    // an undecorated field (`DtoError`) fails the start; missing values are the execution's business
    if (error instanceof DtoError) throw error;
  }
}

/**
 * Every field of the declared context classes has a field decorator — else `DtoError`
 * (`dto.undecorated-field`), at the application's assembly, before any execution.
 */
export function checkContextFields(declared: DeclaredContexts): void {
  const { tenantContext, executionContext } = declared;
  if (tenantContext !== undefined) checkFields(() => tenantFieldsOf(tenantContext, {}));
  if (executionContext !== undefined) checkFields(() => executionFieldsOf(executionContext, {}));
}

/** `[context.prompt-unused]` for every field of the declared context classes that has a prompt. */
export function contextRuleViolations(
  application: string,
  declared: DeclaredContexts,
): RuleViolation[] {
  const declaredClasses = [declared.tenantContext, declared.executionContext];
  return declaredClasses.flatMap((type) =>
    type === undefined ? [] : promptViolations(application, type as DtoClass),
  );
}
