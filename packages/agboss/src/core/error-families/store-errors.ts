import {
  defineFamily,
  type ErrorVariant,
  type FamilyConstructor,
  type VariantOptions,
} from "./family.js";
import { AGBossError } from "../errors.js";

/** The kinds of `StoreError`: `switch (error.kind)` is exhaustive. */
export enum StoreErrorKind {
  OutcomeUnknown = "outcome-unknown",
  CallTimeout = "call-timeout",
  UnreadableRecord = "unreadable-record",
  Mismatch = "mismatch",
  LiveLeases = "live-leases",
  SchemaMissing = "schema-missing",
  SchemaTooNew = "schema-too-new",
  MigrationChanged = "migration-changed",
  SettingsInvalid = "settings-invalid",
  DeploymentUnsupported = "deployment-unsupported",
  DurabilityInsufficient = "durability-insufficient",
  CollationInvalid = "collation-invalid",
  LedgerMarkMissing = "ledger-mark-missing",
  LeaseKeyConflict = "lease-key-conflict",
  ObjectStorage = "object-storage",
  LedgerCutoffInvalid = "ledger-cutoff-invalid",
  LedgerEntryExpired = "ledger-entry-expired",
  LedgerEntryInvalid = "ledger-entry-invalid",
  ClusterLeaseBehind = "cluster-lease-behind",
}

/** A store (a database, a cluster, an object storage) failed or refused. The store packages build these with `StoreError.of(kind, options)`. */
export type StoreError =
  | StoreError.OutcomeUnknown
  | StoreError.CallTimeout
  | StoreError.UnreadableRecord
  | StoreError.Mismatch
  | StoreError.LiveLeases
  | StoreError.SchemaMissing
  | StoreError.SchemaTooNew
  | StoreError.MigrationChanged
  | StoreError.SettingsInvalid
  | StoreError.DeploymentUnsupported
  | StoreError.DurabilityInsufficient
  | StoreError.CollationInvalid
  | StoreError.LedgerMarkMissing
  | StoreError.LeaseKeyConflict
  | StoreError.ObjectStorage
  | StoreError.LedgerCutoffInvalid
  | StoreError.LedgerEntryExpired
  | StoreError.LedgerEntryInvalid
  | StoreError.ClusterLeaseBehind;

/** The variants of `StoreError`, each with the facts it carries. */
export declare namespace StoreError {
  /** The store did not say whether the write took effect. */
  export type OutcomeUnknown = ErrorVariant<StoreErrorKind.OutcomeUnknown, "store.outcome-unknown">;
  /** A store call ran past its timeout. */
  export type CallTimeout = ErrorVariant<StoreErrorKind.CallTimeout, "store.call-timeout">;
  /** A stored record cannot be read. */
  export type UnreadableRecord = ErrorVariant<
    StoreErrorKind.UnreadableRecord,
    "store.unreadable-record"
  >;
  /** The store does not match what the application declares. */
  export type Mismatch = ErrorVariant<StoreErrorKind.Mismatch, "store.mismatch">;
  /** The store holds live leases. */
  export type LiveLeases = ErrorVariant<StoreErrorKind.LiveLeases, "store.live-leases">;
  /** The store has no schema. */
  export type SchemaMissing = ErrorVariant<StoreErrorKind.SchemaMissing, "store.schema-missing">;
  /** The store's schema is newer than this version. */
  export type SchemaTooNew = ErrorVariant<StoreErrorKind.SchemaTooNew, "store.schema-too-new">;
  /** An applied migration changed. */
  export type MigrationChanged = ErrorVariant<
    StoreErrorKind.MigrationChanged,
    "store.migration-changed"
  >;
  /** The store's settings are not valid. */
  export type SettingsInvalid = ErrorVariant<
    StoreErrorKind.SettingsInvalid,
    "store.settings-invalid"
  >;
  /** The store's deployment is not supported. */
  export type DeploymentUnsupported = ErrorVariant<
    StoreErrorKind.DeploymentUnsupported,
    "store.deployment-unsupported"
  >;
  /** The store does not make writes durable enough. */
  export type DurabilityInsufficient = ErrorVariant<
    StoreErrorKind.DurabilityInsufficient,
    "store.durability-insufficient"
  >;
  /** The store's collation is not the one required. */
  export type CollationInvalid = ErrorVariant<
    StoreErrorKind.CollationInvalid,
    "store.collation-invalid"
  >;
  /** A ledger entry has no mark. */
  export type LedgerMarkMissing = ErrorVariant<
    StoreErrorKind.LedgerMarkMissing,
    "store.ledger-mark-missing"
  >;
  /** A lease key is held under another scope. */
  export type LeaseKeyConflict = ErrorVariant<
    StoreErrorKind.LeaseKeyConflict,
    "store.lease-key-conflict"
  >;
  /** An object storage call failed. */
  export type ObjectStorage = ErrorVariant<StoreErrorKind.ObjectStorage, "store.object-storage">;
  /** The ledger's cutoff is not valid. */
  export type LedgerCutoffInvalid = ErrorVariant<
    StoreErrorKind.LedgerCutoffInvalid,
    "store.ledger-cutoff-invalid"
  >;
  /** The ledger entry is past its retention. */
  export type LedgerEntryExpired = ErrorVariant<
    StoreErrorKind.LedgerEntryExpired,
    "store.ledger-entry-expired"
  >;
  /** The ledger entry is not valid. */
  export type LedgerEntryInvalid = ErrorVariant<
    StoreErrorKind.LedgerEntryInvalid,
    "store.ledger-entry-invalid"
  >;
  /** The cluster's lease could not be recorded in the database: its token is behind the lease row's, or the row is unreachable (#1321e). */
  export type ClusterLeaseBehind = ErrorVariant<
    StoreErrorKind.ClusterLeaseBehind,
    "store.cluster-lease-behind"
  >;
}

/** The variant of `StoreError` of one kind. */
export type StoreErrorOfKind<TKind extends StoreErrorKind> = Extract<
  StoreError,
  { readonly kind: TKind }
>;

/** What the store packages build errors with: `StoreError.of(StoreErrorKind.SchemaTooNew, { … })`. */
export interface StoreErrorStatics {
  /** A genuine `StoreError` of `kind`: how `@agboss/postgres` & co. report without a class of their own. */
  of<TKind extends StoreErrorKind>(
    kind: TKind,
    options: VariantOptions<StoreErrorOfKind<TKind>>,
  ): StoreErrorOfKind<TKind>;
}

/** The variant's name of a kind: `"schema-too-new"` → `SchemaTooNew`. */
const variantNameOf = (kind: StoreErrorKind): string | undefined =>
  Object.entries(StoreErrorKind).find(([, value]) => value === kind)?.[0];

/** `of` finds the variant of a kind among the family's own constructors. */
function withOf<TConstructor extends object>(
  constructor: TConstructor,
): TConstructor & StoreErrorStatics {
  function of<TKind extends StoreErrorKind>(
    kind: TKind,
    options: VariantOptions<StoreErrorOfKind<TKind>>,
  ): StoreErrorOfKind<TKind> {
    const name = variantNameOf(kind);
    const Variant: unknown = name === undefined ? undefined : Reflect.get(constructor, name);
    if (typeof Variant !== "function") throw new TypeError(`${kind} is not a kind of StoreError`);
    const error: unknown = Reflect.construct(Variant, [options]);
    if (!(error instanceof AGBossError)) throw new TypeError(`${kind} did not make an error`);
    return error as StoreErrorOfKind<TKind>;
  }
  return Object.assign(constructor, { of });
}

/** `StoreError`: the family's constructor and its variants'. */
export const StoreError: FamilyConstructor<
  StoreError,
  {
    OutcomeUnknown: StoreError.OutcomeUnknown;
    CallTimeout: StoreError.CallTimeout;
    UnreadableRecord: StoreError.UnreadableRecord;
    Mismatch: StoreError.Mismatch;
    LiveLeases: StoreError.LiveLeases;
    SchemaMissing: StoreError.SchemaMissing;
    SchemaTooNew: StoreError.SchemaTooNew;
    MigrationChanged: StoreError.MigrationChanged;
    SettingsInvalid: StoreError.SettingsInvalid;
    DeploymentUnsupported: StoreError.DeploymentUnsupported;
    DurabilityInsufficient: StoreError.DurabilityInsufficient;
    CollationInvalid: StoreError.CollationInvalid;
    LedgerMarkMissing: StoreError.LedgerMarkMissing;
    LeaseKeyConflict: StoreError.LeaseKeyConflict;
    ObjectStorage: StoreError.ObjectStorage;
    LedgerCutoffInvalid: StoreError.LedgerCutoffInvalid;
    LedgerEntryExpired: StoreError.LedgerEntryExpired;
    LedgerEntryInvalid: StoreError.LedgerEntryInvalid;
    ClusterLeaseBehind: StoreError.ClusterLeaseBehind;
  }
> &
  StoreErrorStatics = withOf(
  defineFamily({
    name: "StoreError",
    code: "store",
    kinds: StoreErrorKind,
    variants: {
      OutcomeUnknown: ["the store did not say whether the write took effect"],
      CallTimeout: ["a store call ran past its timeout"],
      UnreadableRecord: ["a stored record cannot be read"],
      Mismatch: ["the store does not match what the application declares"],
      LiveLeases: ["the store holds live leases"],
      SchemaMissing: ["the store has no schema"],
      SchemaTooNew: ["the store's schema is newer than this version"],
      MigrationChanged: ["an applied migration changed"],
      SettingsInvalid: ["the store's settings are not valid"],
      DeploymentUnsupported: ["the store's deployment is not supported"],
      DurabilityInsufficient: ["the store does not make writes durable enough"],
      CollationInvalid: ["the store's collation is not the one required"],
      LedgerMarkMissing: ["a ledger entry has no mark"],
      LeaseKeyConflict: ["a lease key is held under another scope"],
      ObjectStorage: ["an object storage call failed"],
      LedgerCutoffInvalid: ["the ledger's cutoff is not valid"],
      LedgerEntryExpired: ["the ledger entry is past its retention"],
      LedgerEntryInvalid: ["the ledger entry is not valid"],
      ClusterLeaseBehind: ["the cluster's lease is behind the database's lease row"],
    },
  }),
);
