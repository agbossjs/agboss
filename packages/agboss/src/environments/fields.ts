import { ComponentError } from "../components/metadata.js";
import { shownValueOf } from "../core/shown-value.js";

/** The type of a field a class reads from the environment, as printed in a violation. */
export enum EnvironmentFieldType {
  Text = "string",
  Integer = "number",
  Flag = "boolean",
  Secret = "Secret",
}

/** `EnvironmentField.secret({ optional: true })`: whether the contract may lack the field. */
export interface EnvironmentFieldOptions {
  /** An optional field may be absent from the contract (the class reads `undefined`); default `false`. */
  readonly optional?: boolean;
}

declare const environmentFieldBrand: unique symbol;

/**
 * One field a class reads from the environment contract (#511, #834), made only by
 * `EnvironmentField.text()`, `.integer()`, `.flag()` or `.secret()` — a literal does not compile, and
 * a JavaScript caller's is refused at decoration.
 */
export interface EnvironmentField {
  readonly [environmentFieldBrand]: true;
}

/** What the framework reads of a field the helpers made. */
export interface FieldSpec {
  readonly type: EnvironmentFieldType;
  readonly isOptional: boolean;
}

const made = new WeakMap<object, FieldSpec>();

/** What the helpers made of a field, or `undefined` for a value they did not make. */
export const fieldSpecOf = (value: unknown): FieldSpec | undefined =>
  typeof value === "object" && value !== null ? made.get(value) : undefined;

const fieldOf =
  (type: EnvironmentFieldType, maker: string) =>
  (options: EnvironmentFieldOptions = {}): EnvironmentField => {
    // a JavaScript caller's typo (`{ optinal: true }`, `optional: "yes"`) is named, never read as required
    const given: unknown = options;
    const keys = typeof given === "object" && given !== null ? Object.keys(given) : undefined;
    const optional = (given as { optional?: unknown } | null)?.optional;
    if (
      keys === undefined ||
      keys.some((key) => key !== "optional") ||
      (optional !== undefined && typeof optional !== "boolean")
    ) {
      throw new ComponentError(
        `EnvironmentField.${maker}(${shownValueOf(given)}): its options are { optional?: boolean } — EnvironmentField.${maker}({ optional: true })`,
      );
    }
    const field = Object.freeze({});
    made.set(field, { type, isOptional: options.optional === true });
    return field as EnvironmentField;
  };

/**
 * The fields a class reads from the environment contract, declared on it (#511, #834):
 * `@Injectable({ environmentFields: { postgresUrl: EnvironmentField.secret(), postgresPoolSize:
 * EnvironmentField.integer({ optional: true }) } })`. A required field the contract lacks fails the
 * application's assembly with `[environment.missing-field]`; an optional one may be absent.
 */
export const EnvironmentField = Object.freeze({
  /** A text field (`env("X")`). */
  text: fieldOf(EnvironmentFieldType.Text, "text"),
  /** A whole-number field (`env.integer("X")`). */
  integer: fieldOf(EnvironmentFieldType.Integer, "integer"),
  /** A boolean field (`env.flag("X")`). */
  flag: fieldOf(EnvironmentFieldType.Flag, "flag"),
  /** A `Secret` field (`secret("X")`). */
  secret: fieldOf(EnvironmentFieldType.Secret, "secret"),
});

/** The fields a class declares, by name: `{ postgresUrl: EnvironmentField.secret() }`. */
export type EnvironmentFields = Readonly<Record<string, EnvironmentField>>;
