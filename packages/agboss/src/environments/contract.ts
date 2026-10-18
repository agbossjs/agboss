import type { Class } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";

/**
 * The environment contract's rules (#261), checked at the application's assembly (`createApp`,
 * `testWith`, `agboss check`): the contract is a class with declared fields only, and every field a
 * listed framework implementation reads is declared in it.
 */

/** The type of a field a framework implementation reads from the environment. */
export enum EnvironmentFieldType {
  Text = "string",
  Integer = "number",
  Flag = "boolean",
  Secret = "Secret",
}

/** A field a framework implementation reads (`SqliteExecutionRecordRepository` → `sqlitePath`). */
export interface EnvironmentFieldRequirement {
  readonly field: string;
  readonly type: EnvironmentFieldType;
}

const requirements = new WeakMap<Class, readonly EnvironmentFieldRequirement[]>();

/** Declares the fields a framework implementation reads from the project's contract (internal). */
export function requireEnvironmentFields(
  implementation: Class,
  fields: readonly EnvironmentFieldRequirement[],
): void {
  requirements.set(implementation, fields);
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

function missingFieldViolations(
  application: string,
  contract: Class | undefined,
  implementations: readonly Class[],
): RuleViolation[] {
  const declared =
    contract === undefined ? new Set<string>() : new Set(Object.keys(instanceOf(contract)));
  const where =
    contract === undefined
      ? `the environment contract — declare one: @Application({ environment: AppEnvironment })`
      : contract.name;
  return implementations.flatMap((implementation) =>
    requirementsOf(implementation)
      .filter((requirement) => !declared.has(requirement.field))
      .map((requirement) =>
        violation(
          "environment.missing-field",
          `${implementation.name} needs ${requirement.field}: ${requirement.type} in ${where}`,
          [application],
        ),
      ),
  );
}

/** Every rule the application's environment contract breaks, with the classes it lists. */
export function environmentRuleViolations(
  application: string,
  contract: Class | undefined,
  listed: readonly Class[],
): RuleViolation[] {
  return [
    ...(contract === undefined ? [] : contractValueViolations(application, contract)),
    ...missingFieldViolations(application, contract, listed),
  ];
}
