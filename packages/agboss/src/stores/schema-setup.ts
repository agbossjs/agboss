/**
 * What a database store package does with its schema when an application instance starts (#891):
 * one setting for `@agboss/postgres` (`postgresSchemaSetup`) and `@agboss/mongodb`
 * (`mongodbSchemaSetup`).
 */
export enum SchemaSetup {
  /**
   * The default: the start checks the schema and refuses one that is missing, older or newer than
   * the package's — it is migrated explicitly (`agboss-postgres migrate`, `agboss-mongodb migrate`,
   * a Kubernetes Job), so an application's pods need no rights to change it.
   */
  Check = "check",
  /** The start migrates a missing or older schema first (one instance at a time), then checks it. */
  MigrateOnStart = "migrate-on-start",
}
