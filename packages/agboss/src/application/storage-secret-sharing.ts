import { violation, type RuleViolation } from "../graph/rule-error.js";
import { variableOfSecretRef } from "../environments/secret.js";
import type { AssembledApplication } from "./assemble.js";
import { referencesOf, type Reference } from "./referenced-variables.js";
import type { SecretRef } from "../environments/env-ref.js";
import { VariableReference } from "../environments/variables.js";

/**
 * `[storage.secret-shared]` across the application (#1324b, #825): the variable of a database storage's
 * `piiSecret`, `previousPiiSecret`, `idempotencySecret` or `previousIdempotencySecret` is read by nothing
 * else — no model provider's `apiKey`, no mesh `signingKey`, no PII policy's `secret`, no other component's
 * `env(…)` / `secret(…)`. Rotating a provider's key must never change every stored token or fingerprint.
 * (Two model providers may share one key: neither is a storage secret.) The storage's own four are
 * compared with each other by the storage's rules.
 */
export function sharedStorageSecretViolations(assembled: AssembledApplication): RuleViolation[] {
  const meta = assembled.storage?.database?.meta;
  if (meta === undefined) return [];
  const own = assembled.storage?.database?.cls.name;
  const keys = [
    ["piiSecret", meta.piiSecret],
    ["previousPiiSecret", meta.previousPiiSecret],
    ["idempotencySecret", meta.idempotencySecret],
    ["previousIdempotencySecret", meta.previousIdempotencySecret],
  ] as const;
  const named = keys.flatMap(([option, ref]) =>
    ref === undefined ? [] : [[option, variableOfSecretRef(ref as SecretRef)] as const],
  );
  const others = referencesOf(assembled).filter((found) => found.owner !== own);
  return named.flatMap(([option, variable]) =>
    others
      .filter((found) => variableOf(found.reference) === variable)
      .slice(0, 1)
      .map((found) =>
        violation(
          "storage.secret-shared",
          `the storage's ${option} reads ${variable}, as ${found.path} does — give the key a variable of its own: rotating it would change every stored value made with it, and the other reader's with it`,
          [assembled.name],
        ),
      ),
  );
}

const variableOf = (reference: Reference): string =>
  reference instanceof VariableReference
    ? reference.variable
    : variableOfSecretRef(reference as SecretRef);
