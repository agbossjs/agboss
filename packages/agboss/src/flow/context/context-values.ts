import { z } from "zod";
import { KEY_TEXT_RULE_TEXT, keyTextRuleOf } from "../../core/errors.js";
import { DtoError, DtoValidationError, pathOf } from "../../dto/errors.js";
import { fieldsOf } from "../../dto/metadata.js";
import { fieldsSchemaOf } from "../../dto/schema.js";
import type { DtoClass } from "../../dto/types.js";
import type { InboundMesh } from "../../mesh/inbound-mesh.js";
import type { ExecutionDeadline } from "../../budgets/execution-deadline.js";
import type { ApplicationContext } from "./application-context.js";
import type { ExecutionContext } from "./execution-context.js";
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_WEIGHT, TenantContext } from "./tenant-context.js";

/**
 * The values of a context level (#261): what `app.execute(…, { tenant, execution })` passes, typed by
 * the declared subclasses, validated by their field decorators before the first step (invalid →
 * `dto.invalid`, naming the field, never the value), then frozen. The framework creates the
 * instance and links it up; the project never creates a context with `new`.
 */

/** A `TenantContext` class: the built-in one or the project's subclass. */
export type TenantContextClass<T extends TenantContext = TenantContext> = abstract new () => T;

/** An `ExecutionContext` class: the built-in one or the project's subclass. */
export type ExecutionContextClass<T extends ExecutionContext = ExecutionContext> =
  abstract new () => T;

/** The data fields of `T`: its members that are not methods. */
type DataKeysOf<T> = {
  [K in keyof T]-?: T[K] extends (...args: never[]) => unknown ? never : K;
}[keyof T];

/** The built-in fields of a tenant a caller may pass: both optional (`"default"`, weight 1). */
export interface TenantValues {
  /** The organization; omitted → `"default"`. */
  readonly tenantId?: string;
  /** A positive integer; omitted → 1. */
  readonly weight?: number;
}

/**
 * The data passed for a context class `T` (`tenant: { … }`, `execution: { … }`): its own data
 * fields only — without the links up (`application`, `tenant`) and the fields the framework fills
 * (`executionId`, `depth`, the tree, `step`). A tenant's `tenantId` and `weight` are optional.
 */
export type ContextValues<T> = T extends ExecutionContext
  ? Readonly<Pick<T, Exclude<DataKeysOf<T>, keyof ExecutionContext>>>
  : T extends TenantContext
    ? Readonly<Pick<T, Exclude<DataKeysOf<T>, keyof TenantContext>>> & TenantValues
    : never;

/** A context's values as the framework keeps them: plain, validated, frozen JSON-like data. */
export type ContextFields = Readonly<Record<string, unknown>>;

/** A tenant's values as kept: the built-in fields always set. */
export interface TenantFields extends ContextFields {
  readonly tenantId: string;
  readonly weight: number;
}

/** The context values of one execution, as its state keeps them (checkpointed, kept by a resume). */
export interface ExecutionContextValues {
  readonly tenant: TenantFields;
  readonly execution: ContextFields;
  /** The call chain a mesh request arrived with (#398), when one did: its calls carry it on. */
  readonly mesh?: InboundMesh;
  /** The execution's deadline (#398 PR 2), fixed at its start; none without one. */
  readonly deadline?: ExecutionDeadline;
}

/** The tenant of an execution that passes none. */
export const DEFAULT_TENANT: TenantFields = Object.freeze({
  tenantId: DEFAULT_TENANT_ID,
  weight: DEFAULT_TENANT_WEIGHT,
});

/** The contexts of an execution that passes nothing. */
export const DEFAULT_CONTEXT_VALUES: ExecutionContextValues = Object.freeze({
  tenant: DEFAULT_TENANT,
  execution: Object.freeze({}),
});

/** The project's own fields of a context class (its decorated fields, its parents' first). */
export const contextFieldNamesOf = (type: Class): readonly string[] =>
  fieldsOf(type as DtoClass).map((field) => field.name);

type Class = abstract new () => unknown;

/** Every own field of a context subclass has a field decorator (it is read by name, validated). */
function checkDecorated(type: Class): void {
  const decorated = new Set(contextFieldNamesOf(type));
  const instance: unknown = Reflect.construct(type, []);
  const fields = typeof instance === "object" && instance !== null ? Object.keys(instance) : [];
  const undecorated = fields.filter((field) => !decorated.has(field));
  if (undecorated.length > 0) {
    throw new DtoError(
      "dto.undecorated-field",
      `${type.name}: every field of a context needs a field decorator — ${undecorated.join(", ")}`,
    );
  }
}

/** Why a tenant id is not one (#552): the key-text rule it breaks, never the id. */
const tenantIdReason = (tenantId: string): string | undefined => {
  const rule = keyTextRuleOf(tenantId);
  return rule === undefined
    ? undefined
    : `a tenant id is a key's text (${rule}): ${KEY_TEXT_RULE_TEXT[rule]}`;
};

/**
 * Checks a tenant id given outside the tenant's values (#552: `app.resume`'s and `app.cancel`'s
 * `tenantId`): a key's text, else `DtoValidationError` (`dto.invalid`) naming the rule, never the id.
 */
export function checkedTenantId(tenantId: string): void {
  const reason = tenantIdReason(tenantId);
  if (reason !== undefined)
    throw new DtoValidationError(TenantContext.name, [{ path: "tenantId", reason }]);
}

const TenantBuiltIns = z.object({
  // #552: a tenant id keys threads, leases and business-key rows — the rules of a key's text
  tenantId: z
    .string()
    .superRefine((tenantId, context) => {
      const reason = tenantIdReason(tenantId);
      if (reason !== undefined) context.addIssue({ code: "custom", message: reason });
    })
    .optional(),
  weight: z.number().int().positive().optional(),
});

const schemas = new WeakMap<Class, z.ZodType<ContextFields>>();

function schemaOf(type: Class, isTenant: boolean): z.ZodType<ContextFields> {
  const cached = schemas.get(type);
  if (cached !== undefined) return cached;
  checkDecorated(type);
  const own = fieldsSchemaOf(fieldsOf(type as DtoClass));
  const schema = (isTenant ? own.extend(TenantBuiltIns.shape) : own).strict();
  schemas.set(type, schema);
  return schema;
}

/** Freezes a value and everything in it: a context's values never change during the execution. */
function deepFrozen<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const inner of Object.values(value)) deepFrozen(inner);
  return Object.freeze(value);
}

/** Checks `raw` against a context class's fields: the parsed, frozen values, else `dto.invalid`. */
function validated(type: Class, raw: unknown, isTenant: boolean): ContextFields {
  const parsed = schemaOf(type, isTenant).safeParse(raw ?? {});
  if (!parsed.success) {
    throw new DtoValidationError(
      type.name,
      parsed.error.issues.map((issue) => ({ path: pathOf(issue.path), reason: issue.message })),
    );
  }
  return deepFrozen(parsed.data);
}

/** The tenant values of an execution: validated by the tenant class, the built-in fields filled. */
export function tenantFieldsOf(type: TenantContextClass, raw: unknown): TenantFields {
  const values = validated(type, raw, true);
  const { tenantId, weight } = values;
  return deepFrozen({
    ...values,
    tenantId: typeof tenantId === "string" ? tenantId : DEFAULT_TENANT_ID,
    weight: typeof weight === "number" ? weight : DEFAULT_TENANT_WEIGHT,
  });
}

/** The execution values of an execution: validated by the execution class (`{}` for the built-in). */
export const executionFieldsOf = (type: ExecutionContextClass, raw: unknown): ContextFields =>
  validated(type, raw, false);

/** The tenant of an execution: an instance of its class, linked to the application, frozen. */
export function tenantContextOf(
  type: TenantContextClass,
  values: TenantFields,
  application: ApplicationContext,
): TenantContext {
  // the framework's instance of the project's class: its prototype, its values as own fields
  const tenant = Object.create(type.prototype as object) as TenantContext;
  return Object.freeze(Object.assign(tenant, values, { application }));
}

/** Whether a class is a context level or a subclass of one. */
export const isTenantContextClass = (type: unknown): type is TenantContextClass =>
  typeof type === "function" && (type === TenantContext || type.prototype instanceof TenantContext);
