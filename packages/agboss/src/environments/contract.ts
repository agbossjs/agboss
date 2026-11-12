import type { Class, Token } from "../components/injection.js";
import { ComponentError } from "../components/metadata.js";
import { shownValueOf } from "../core/shown-value.js";
import {
  EnvironmentField,
  EnvironmentFieldType,
  fieldSpecOf,
  type EnvironmentFieldOptions,
  type EnvironmentFields,
} from "./fields.js";

export {
  EnvironmentField,
  EnvironmentFieldType,
  type EnvironmentFieldOptions,
  type EnvironmentFields,
};
import { violation, type RuleViolation } from "../graph/rule-error.js";

/**
 * The environment contract's rules (#261), checked at the application's assembly (`createApp`,
 * `testWith`, `agboss check`): the contract is a class with declared fields only, and every field a
 * listed class reads — or a class its `deps` reach, a store's connection (#511) — is declared in it.
 */

/** A field a class reads (`SqliteConnection` → `sqlitePath`). */
export interface EnvironmentFieldRequirement {
  readonly field: string;
  readonly type: EnvironmentFieldType;
  /** An optional field may be absent from the contract. */
  readonly isOptional?: boolean;
}

const requirements = new WeakMap<Class, readonly EnvironmentFieldRequirement[]>();

/** Declares the fields a class reads from the project's contract (`environmentFields`, internal). */
export function requireEnvironmentFields(
  implementation: Class,
  fields: readonly EnvironmentFieldRequirement[],
): void {
  requirements.set(implementation, fields);
}

/** A field of the contract is a class field: a camelCase identifier (`postgresUrl`). */
const FIELD_NAME = /^[a-z][A-Za-z0-9]*$/;

/** The declaration of one field, or why it is refused. */
function requirementOf(
  implementation: Class,
  field: string,
  value: unknown,
): EnvironmentFieldRequirement {
  const where = `@Injectable({ environmentFields }) of ${implementation.name || "(anonymous class)"}`;
  if (!FIELD_NAME.test(field)) {
    throw new ComponentError({
      message: `${where}: "${field}" is not a field name — a field of the environment contract is a camelCase identifier (postgresUrl)`,
    });
  }
  if (typeof value === "function") {
    throw new ComponentError({
      message: `${where}: ${field} is a helper, not a field — call it: EnvironmentField.text(), .integer(), .flag() or .secret()`,
    });
  }
  const spec = fieldSpecOf(value);
  if (spec === undefined) {
    throw new ComponentError({
      message: `${where}: ${field} is ${shownValueOf(value)}, not a field made by EnvironmentField.text(), .integer(), .flag() or .secret() (a store with its own copy of @agboss/core makes fields this one does not know: list the core as a peer dependency)`,
    });
  }
  return { field, type: spec.type, isOptional: spec.isOptional };
}

/** `environmentFields` of a decorator, as the class's requirements (#511), each checked (#834). */
export function declareEnvironmentFields(implementation: Class, fields: EnvironmentFields): void {
  if (typeof fields !== "object" || (fields as unknown) === null) {
    throw new ComponentError({
      message: `@Injectable({ environmentFields }) of ${implementation.name || "(anonymous class)"}: ${shownValueOf(fields)} is not an object of fields`,
    });
  }
  requireEnvironmentFields(
    implementation,
    Object.entries(fields as Readonly<Record<string, unknown>>).map(([field, value]) =>
      requirementOf(implementation, field, value),
    ),
  );
}

/** The fields a class reads, its base classes' included. */
function requirementsOf(cls: Class): readonly EnvironmentFieldRequirement[] {
  const found: EnvironmentFieldRequirement[] = [];
  for (let at: unknown = cls; typeof at === "function"; at = Object.getPrototypeOf(at)) {
    const own = requirements.get(at as Class);
    if (own !== undefined) found.push(...own);
  }
  return found;
}

/** The `Secret` fields the classes read (#825: the keys an application's key fields must not share). */
export const secretFieldsReadBy = (readers: readonly Class[]): readonly string[] => [
  ...new Set(
    readers.flatMap((reader) =>
      requirementsOf(reader)
        .filter((required) => required.type === EnvironmentFieldType.Secret)
        .map((required) => required.field),
    ),
  ),
];

/** The contract's own fields: a declared field is an own property of an instance (class fields). */
const instanceOf = (contract: Class): Readonly<Record<string, unknown>> => {
  const instance: unknown = Reflect.construct(contract, []);
  return typeof instance === "object" && instance !== null ? { ...instance } : {};
};

/** The fields the contract declares (empty for an application with no settings). */
export const declaredFieldsOf = (contract: Class): readonly string[] =>
  Object.keys(instanceOf(contract));

function contractValueViolations(application: string, contract: Class): RuleViolation[] {
  return Object.entries(instanceOf(contract)).flatMap(([field, value]) =>
    value === undefined
      ? []
      : [
          violation(
            "environment.contract-value",
            `${contract.name}.${field} has a value — the contract declares fields only; put the value in each environment`,
            [application],
          ),
        ],
  );
}

/** A listed class and the classes it reaches through its `deps`, each with what it reads. */
export interface ReadingClass {
  /** The class the application lists. */
  readonly listed: Class;
  /** The class that reads the field: the listed one, or one its `deps` reach. */
  readonly reader: Class;
}

/** A class's constructor dependencies, as its decorator recorded them (the container's `depsOf`). */
export type DepsReader = (cls: Class) => readonly Token[];

/** Each listed class with every class it reaches through `deps` (itself first), each once. */
export function readingClassesOf(
  listed: readonly Class[],
  depsOf: DepsReader,
): readonly ReadingClass[] {
  return [...new Set(listed)].flatMap((root) => {
    const reached = new Set<Class>([root]);
    for (const cls of reached) {
      for (const token of depsOf(cls)) if (typeof token === "function") reached.add(token);
    }
    return [...reached].map((reader) => ({ listed: root, reader }));
  });
}

/** `X needs f: T in C`, and `(read by SqliteConnection)` when a class its deps reach reads it. */
const neededMessage = (
  reading: ReadingClass,
  required: EnvironmentFieldRequirement,
  where: string,
): string =>
  `${reading.listed.name} needs ${required.field}: ${required.type} in ${where}` +
  (reading.reader === reading.listed ? "" : ` (read by ${reading.reader.name})`);

function missingFieldViolations(
  application: string,
  contract: Class | undefined,
  readers: readonly ReadingClass[],
): RuleViolation[] {
  const declared =
    contract === undefined ? new Set<string>() : new Set(Object.keys(instanceOf(contract)));
  const where =
    contract === undefined
      ? `the environment contract — declare one: @Application({ environment: AppEnvironment })`
      : contract.name;
  return readers.flatMap((reading) =>
    requirementsOf(reading.reader)
      .filter((required) => required.isOptional !== true && !declared.has(required.field))
      .map((required) =>
        violation("environment.missing-field", neededMessage(reading, required, where), [
          application,
        ]),
      ),
  );
}

/** One field read as two types by two classes (#511): the contract cannot give both. */
function conflictingFieldViolations(
  application: string,
  readers: readonly ReadingClass[],
): RuleViolation[] {
  const first = new Map<string, { readonly reader: Class; readonly type: EnvironmentFieldType }>();
  const reported = new Set<string>();
  const found: RuleViolation[] = [];
  for (const { reader } of readers) {
    for (const { field, type } of requirementsOf(reader)) {
      const earlier = first.get(field);
      if (earlier === undefined) first.set(field, { reader, type });
      else if (earlier.type !== type && !reported.has(field)) {
        reported.add(field);
        const message = `${earlier.reader.name} reads ${field} as ${earlier.type}, ${reader.name} as ${type} — one field has one type; rename one of them`;
        found.push(violation("environment.conflicting-field", message, [application]));
      }
    }
  }
  return found;
}

/** Every rule the application's environment contract breaks, with the classes that read it. */
export function environmentRuleViolations(
  application: string,
  contract: Class | undefined,
  readers: readonly ReadingClass[],
): RuleViolation[] {
  return [
    ...(contract === undefined ? [] : contractValueViolations(application, contract)),
    ...missingFieldViolations(application, contract, readers),
    ...conflictingFieldViolations(application, readers),
  ];
}
