import type { Class, Token } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";

/**
 * The environment contract's rules (#261), checked at the application's assembly (`createApp`,
 * `testWith`, `agboss check`): the contract is a class with declared fields only, and every field a
 * listed class reads — or a class its `deps` reach, a store's connection (#511) — is declared in it.
 */

/** The type of a field a class reads from the environment, as printed in a violation. */
export enum EnvironmentFieldType {
  Text = "string",
  Integer = "number",
  Flag = "boolean",
  Secret = "Secret",
}

/**
 * What a class reads from the environment contract, declared on it (#511):
 * `@Injectable({ environmentFields: { postgresUrl: EnvironmentField.Secret } })`. A required field the
 * contract lacks fails the application's assembly with `[environment.missing-field]`; an optional
 * one may be absent (the class reads `undefined`).
 */
export enum EnvironmentField {
  Text = "text",
  Integer = "integer",
  Flag = "flag",
  Secret = "secret",
  OptionalText = "optional-text",
  OptionalInteger = "optional-integer",
  OptionalFlag = "optional-flag",
  OptionalSecret = "optional-secret",
}

/** The fields a class declares, by name: `{ postgresUrl: EnvironmentField.Secret }`. */
export type EnvironmentFields = Readonly<Record<string, EnvironmentField>>;

/** A field a class reads (`SqliteConnection` → `sqlitePath`). */
export interface EnvironmentFieldRequirement {
  readonly field: string;
  readonly type: EnvironmentFieldType;
  /** An optional field may be absent from the contract. */
  readonly isOptional?: boolean;
}

const FIELD_TYPES: Readonly<Record<EnvironmentField, EnvironmentFieldRequirement["type"]>> = {
  [EnvironmentField.Text]: EnvironmentFieldType.Text,
  [EnvironmentField.Integer]: EnvironmentFieldType.Integer,
  [EnvironmentField.Flag]: EnvironmentFieldType.Flag,
  [EnvironmentField.Secret]: EnvironmentFieldType.Secret,
  [EnvironmentField.OptionalText]: EnvironmentFieldType.Text,
  [EnvironmentField.OptionalInteger]: EnvironmentFieldType.Integer,
  [EnvironmentField.OptionalFlag]: EnvironmentFieldType.Flag,
  [EnvironmentField.OptionalSecret]: EnvironmentFieldType.Secret,
};

const requirements = new WeakMap<Class, readonly EnvironmentFieldRequirement[]>();

/** Declares the fields a class reads from the project's contract (`environmentFields`, internal). */
export function requireEnvironmentFields(
  implementation: Class,
  fields: readonly EnvironmentFieldRequirement[],
): void {
  requirements.set(implementation, fields);
}

/** `environmentFields` of a decorator, as the class's requirements (#511). */
export function declareEnvironmentFields(implementation: Class, fields: EnvironmentFields): void {
  requireEnvironmentFields(
    implementation,
    Object.entries(fields).map(([field, kind]) => ({
      field,
      type: FIELD_TYPES[kind],
      isOptional: kind.startsWith("optional-"),
    })),
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
