import type { JsonSchema } from "../dto/schema.js";

/**
 * Structural compatibility of two JSON Schemas (#398 PR 4): whether a **receiver** accepts every value
 * a **sender** may produce — never by hash (an equal `schemaHash` is only the fast path). Read the
 * way the framework's DTO schemas are written (`z.toJSONSchema`, input side): objects with
 * `properties`, `required` and `additionalProperties`, `type`, `enum` / `const`, `items`,
 * `anyOf` / `oneOf`, string and number bounds, `$ref` into `$defs`. Each difference is one reason,
 * named by its field path (`currency`, `lines[].amount`); none = compatible. A shape it cannot read
 * is compared as equal JSON only.
 */

type Schema = Readonly<Record<string, unknown>>;

/** A schema and the root its `$ref`s resolve against. */
interface Rooted {
  readonly schema: Schema;
  readonly root: Schema;
}

const isSchema = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `#/$defs/X` (or `#/definitions/X`) in its root; the schema itself otherwise. */
function resolved({ schema, root }: Rooted): Schema {
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  const [, section, name] = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref) ?? [];
  if (section === undefined || name === undefined) return schema;
  const defs = root[section];
  const target = isSchema(defs) ? defs[name] : undefined;
  return isSchema(target) ? target : schema;
}

const typesOf = (schema: Schema): readonly string[] | undefined => {
  const { type } = schema;
  if (typeof type === "string") return [type];
  return Array.isArray(type)
    ? type.filter((item): item is string => typeof item === "string")
    : undefined;
};

const valuesOf = (schema: Schema): readonly unknown[] | undefined => {
  if (Array.isArray(schema.enum)) return schema.enum as readonly unknown[];
  return "const" in schema ? [schema.const] : undefined;
};

const branchesOf = (schema: Schema): readonly Schema[] | undefined => {
  const branches = schema.anyOf ?? schema.oneOf;
  return Array.isArray(branches) ? branches.filter(isSchema) : undefined;
};

const named = (path: string, field: string): string => (path === "" ? field : `${path}.${field}`);

/** The receiver's types accept the sender's (an `integer` is a `number`). */
function typeReasons(receiver: Schema, sender: Schema, path: string): string[] {
  const accepted = typesOf(receiver);
  const sent = typesOf(sender);
  if (accepted === undefined) return [];
  if (sent === undefined)
    return [`${path || "the value"} may be of any type; only ${accepted.join(" | ")} is accepted`];
  const missing = sent.filter(
    (type) => !accepted.includes(type) && !(type === "integer" && accepted.includes("number")),
  );
  return missing.length === 0
    ? []
    : [
        `${path || "the value"} may be ${missing.join(" | ")}; only ${accepted.join(" | ")} is accepted`,
      ];
}

/** Every value the sender may give is one the receiver lists. */
function valueReasons(receiver: Schema, sender: Schema, path: string): string[] {
  const accepted = valuesOf(receiver);
  if (accepted === undefined) return [];
  const sent = valuesOf(sender);
  const where = path || "the value";
  if (sent === undefined)
    return [`${where} may be any value; only ${JSON.stringify(accepted)} is accepted`];
  const extra = sent.filter(
    (value) => !accepted.some((one) => JSON.stringify(one) === JSON.stringify(value)),
  );
  return extra.length === 0
    ? []
    : [`${where} may be ${JSON.stringify(extra)}, which is not accepted`];
}

const BOUNDS = [
  ["minLength", "at least"],
  ["minimum", "at least"],
  ["minItems", "at least"],
  ["maxLength", "at most"],
  ["maximum", "at most"],
  ["maxItems", "at most"],
] as const;

/** The receiver's bounds are no tighter than the sender's; a pattern the sender does not promise. */
function boundReasons(receiver: Schema, sender: Schema, path: string): string[] {
  const where = path || "the value";
  const reasons: string[] = [];
  for (const [key, word] of BOUNDS) {
    const accepted = receiver[key];
    if (typeof accepted !== "number") continue;
    const sent = sender[key];
    const isLower = word === "at least";
    const isLooser = typeof sent === "number" && (isLower ? sent >= accepted : sent <= accepted);
    if (!isLooser) reasons.push(`${where} must now be ${word} ${String(accepted)} (${key})`);
  }
  if (typeof receiver.pattern === "string" && receiver.pattern !== sender.pattern)
    reasons.push(`${where} must now match ${receiver.pattern}`);
  return reasons;
}

const requiredOf = (schema: Schema): readonly string[] =>
  Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];

const propertiesOf = (schema: Schema): Readonly<Record<string, Schema>> =>
  isSchema(schema.properties)
    ? Object.fromEntries(
        Object.entries(schema.properties).filter((entry): entry is [string, Schema] =>
          isSchema(entry[1]),
        ),
      )
    : {};

/** Objects: every field the receiver requires is one the sender always gives, field by field. */
function objectReasons(receiver: Rooted, sender: Rooted, path: string): string[] {
  const accepted = propertiesOf(receiver.schema);
  const sent = propertiesOf(sender.schema);
  const sentRequired = requiredOf(sender.schema);
  const reasons = requiredOf(receiver.schema)
    .filter((field) => !sentRequired.includes(field))
    .map((field) =>
      field in sent
        ? `field "${named(path, field)}" is now required; the sender may leave it out`
        : `field "${named(path, field)}" is now required; the sender does not send it`,
    );
  for (const [field, schema] of Object.entries(sent)) {
    const own = accepted[field];
    if (own === undefined) {
      if (receiver.schema.additionalProperties === false)
        reasons.push(`field "${named(path, field)}" is no longer accepted`);
      continue;
    }
    reasons.push(
      ...reasonsOf(
        { schema: own, root: receiver.root },
        { schema, root: sender.root },
        named(path, field),
      ),
    );
  }
  return reasons;
}

/** Union branches: each sent branch accepted; a received union accepts the value by one branch. */
function unionReasons(receiver: Rooted, sender: Rooted, path: string): string[] | undefined {
  const sent = branchesOf(sender.schema);
  if (sent !== undefined)
    return sent.flatMap((branch) =>
      reasonsOf(receiver, { schema: branch, root: sender.root }, path),
    );
  const accepted = branchesOf(receiver.schema);
  if (accepted === undefined) return undefined;
  const all = accepted.map((branch) =>
    reasonsOf({ schema: branch, root: receiver.root }, sender, path),
  );
  return all.some((reasons) => reasons.length === 0) ? [] : (all[0] ?? []);
}

/** Why the receiver does not accept every value of the sender; empty when it does. */
function reasonsOf(receiver: Rooted, sender: Rooted, path: string): string[] {
  const accepting: Rooted = { schema: resolved(receiver), root: receiver.root };
  const sending: Rooted = { schema: resolved(sender), root: sender.root };
  const union = unionReasons(accepting, sending, path);
  if (union !== undefined) return union;
  const reasons = [
    ...typeReasons(accepting.schema, sending.schema, path),
    ...valueReasons(accepting.schema, sending.schema, path),
    ...boundReasons(accepting.schema, sending.schema, path),
  ];
  if (typesOf(accepting.schema)?.includes("object") === true)
    reasons.push(...objectReasons(accepting, sending, path));
  const items = accepting.schema.items;
  const sentItems = sending.schema.items;
  if (isSchema(items) && isSchema(sentItems)) {
    const item = { schema: items, root: accepting.root };
    reasons.push(...reasonsOf(item, { schema: sentItems, root: sending.root }, `${path}[]`));
  }
  return reasons;
}

/** Why `receiver` does not accept every value `sender` may produce; empty when it does. */
export function incompatibilitiesOf(receiver: JsonSchema, sender: JsonSchema): readonly string[] {
  if (!isSchema(receiver) || !isSchema(sender))
    return JSON.stringify(receiver) === JSON.stringify(sender) ? [] : ["the schemas differ"];
  return reasonsOf({ schema: receiver, root: receiver }, { schema: sender, root: sender }, "");
}
