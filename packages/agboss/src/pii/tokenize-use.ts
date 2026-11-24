import type { Class } from "../components/injection.js";
import { fieldsOf } from "../dto/metadata.js";
import type { DtoClass } from "../dto/types.js";
import { PiiActionKind } from "./actions.js";
import { isCustomPolicy } from "./pii-policy.decorator.js";
import { piiPolicyMetaOf } from "./policy-checks.js";

/**
 * Where an application makes PII tokens (#1301): the places that need the application's PII
 * secret (`@DatabaseStorage({ piiSecret })`) — a policy's `tokenize()` rule or action without a
 * `secret` of its own, and a DTO field marked `sensitive: PiiAction.tokenize()`. Their names only,
 * never a value.
 */

/** The policies that make tokens with the application's key: no `secret` of their own. */
export function policiesTokenizing(policies: readonly Class[]): readonly string[] {
  return policies.flatMap((cls) => {
    const meta = piiPolicyMetaOf(cls);
    if (meta === undefined) return [];
    const tokenizes = isCustomPolicy(meta)
      ? meta.action.kind === PiiActionKind.Tokenize
      : meta.secret === undefined &&
        meta.rules.some((rule) => rule.action.kind === PiiActionKind.Tokenize);
    return tokenizes ? [meta.name] : [];
  });
}

/** `Dto.field` of every `sensitive: PiiAction.tokenize()` field of the DTOs, nested ones included (a cycle once). */
export function tokenizeFieldsOf(dtos: readonly DtoClass[]): readonly string[] {
  const seen = new Set<DtoClass>();
  const walk = (dto: DtoClass): string[] => {
    if (seen.has(dto)) return [];
    seen.add(dto);
    return fieldsOf(dto).flatMap((field) => [
      ...(field.settings.sensitive?.kind === PiiActionKind.Tokenize
        ? [`${dto.name}.${field.name}`]
        : []),
      ...(field.element?.kind === "dto" ? walk(field.element.dto) : []),
    ]);
  };
  return dtos.flatMap(walk);
}
