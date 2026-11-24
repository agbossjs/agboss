import { violation, type RuleViolation } from "../graph/rule-error.js";
import { variableOfSecretRef } from "../environments/secret.js";
import type { AssembledStorage } from "./storage-assembly.js";

/** What the rules read of an application's key fields. */
export interface KeyFields {
  readonly piiKeyField?: unknown;
}

/** The storage's secrets are each its own variable, and none is also named as a key field. */
export function secretViolations(
  application: string,
  storage: AssembledStorage,
  fields: KeyFields,
): RuleViolation[] {
  const meta = storage.database?.meta;
  if (meta === undefined) return [];
  const keys = [
    ["idempotencySecret", meta.idempotencySecret, undefined, undefined],
    ["previousIdempotencySecret", meta.previousIdempotencySecret, undefined, undefined],
    ["piiSecret", meta.piiSecret, "piiKeyField", fields.piiKeyField],
    ["previousPiiSecret", meta.previousPiiSecret, undefined, undefined],
  ] as const;
  const conflicts = keys.flatMap(([secret, ref, field, named]) =>
    ref !== undefined && named !== undefined
      ? [
          violation(
            "storage.key-conflict",
            `${application} sets the storage's ${secret} and @Application({ ${field} }) — keep the storage's: the environment's field is no longer where the key is read`,
            [application],
          ),
        ]
      : [],
  );
  const variables = keys.flatMap(([secret, ref]) =>
    ref === undefined ? [] : [[secret, variableOfSecretRef(ref)] as const],
  );
  const shared = variables.flatMap(([secret, variable], at) => {
    const other = variables.slice(0, at).find(([, seen]) => seen === variable);
    return other === undefined
      ? []
      : [
          violation(
            "storage.secret-shared",
            `the storage's ${secret} reads ${variable}, as its ${other[0]} does — give each key a variable of its own: rotating one would change every value made with the other`,
            [application],
          ),
        ];
  });
  return [...conflicts, ...shared];
}
