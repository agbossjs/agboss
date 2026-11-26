import { violation, type RuleViolation } from "../graph/rule-error.js";
import { variableOfSecretRef } from "../environments/secret.js";
import type { AssembledStorage } from "./storage-assembly.js";

/** The storage's secrets are each its own variable. */
export function secretViolations(application: string, storage: AssembledStorage): RuleViolation[] {
  const meta = storage.database?.meta;
  if (meta === undefined) return [];
  const keys = [
    ["idempotencySecret", meta.idempotencySecret],
    ["previousIdempotencySecret", meta.previousIdempotencySecret],
    ["piiSecret", meta.piiSecret],
    ["previousPiiSecret", meta.previousPiiSecret],
  ] as const;
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
  return shared;
}
