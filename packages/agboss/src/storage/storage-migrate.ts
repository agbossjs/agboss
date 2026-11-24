import { StoreError, StoreErrorKind } from "../core/error-families/store-errors.js";
import { driverOf, resolvedStorageOf, type AssembledStorage } from "./storage-assembly.js";
import {
  StorageRole,
  type StorageMigration,
  type StorageMigrationOptions,
} from "./storage-driver.js";

/** What `agboss migrate db` found and did: the driver's backend and its migration's outcome. */
export interface DatabaseMigrationRun extends StorageMigration {
  /** The driver's `backend` (`"postgres"`, `"mongodb"`). */
  readonly backend: string;
}

/**
 * Runs the migration of the application's `@DatabaseStorage` driver on its resolved settings
 * (#1321f): the settings are read from `processEnv` here, once, with the profile's config already
 * loaded by the caller. `undefined` when the application has no database storage or its driver
 * migrates nothing (SQLite makes its schema at open); the driver's own refusal
 * (`StoreError.LiveLeases`) passes as it is.
 */
export async function migratedDatabaseOf(
  storage: AssembledStorage | undefined,
  processEnv: NodeJS.ProcessEnv,
  options: StorageMigrationOptions,
): Promise<DatabaseMigrationRun | undefined> {
  const driver = driverOf(storage?.database?.meta, StorageRole.Database);
  if (driver?.migrate === undefined) return undefined;
  const settings = resolvedStorageOf(storage, processEnv).database;
  if (settings === undefined)
    throw StoreError.of(StoreErrorKind.SettingsInvalid, {
      message: "the application's database storage has no settings to migrate",
    });
  const { applied } = await driver.migrate(settings, options);
  return { backend: driver.backend, applied };
}
