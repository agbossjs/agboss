import { fieldLabelOf } from "../dto/redact.js";
import { fieldsOf } from "../dto/metadata.js";
import type { DtoClass } from "../dto/types.js";
import type { SensitiveValue } from "./policy-set.js";

/**
 * The identity fields of an execution's contexts marked `sensitive: PiiAction.…` (#120 AC13): their
 * values are masked like a DTO field's wherever they appear — in what a model reads, in logs, traces
 * and events. Only masking actions compile there; a context never holds a secret.
 */

/** A context class with its values, as the execution keeps them. */
export interface ContextLevel {
  readonly type: abstract new () => unknown;
  readonly values: Readonly<Record<string, unknown>>;
}

/** The sensitive values of the given context levels (empty values skipped). */
export function sensitiveValuesOf(levels: readonly ContextLevel[]): SensitiveValue[] {
  return levels.flatMap(({ type, values }) =>
    fieldsOf(type as DtoClass).flatMap((field): SensitiveValue[] => {
      const action = field.settings.sensitive;
      const value = values[field.name];
      if (action === undefined || value === undefined || value === null) return [];
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return text === "" ? [] : [{ value: text, label: fieldLabelOf(field.name), action }];
    }),
  );
}
