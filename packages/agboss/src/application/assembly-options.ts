/** How the workflows are assembled: a profile on top of each (`profiles/<workflow>/<profile>.yaml`). */
export interface ApplicationAssembly {
  readonly profile?: string | undefined;
  readonly profileRoot?: string | undefined;
  /** Where prompt variables' `env(…)` references are read from (#1347c); default `process.env`. */
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
  /**
   * The assembly is a test's (`testWith`, a unit runner, a fault pod) or runs no effect (`studio`,
   * an evaluation, a records export): an application that names no `@DatabaseStorage` needs no
   * idempotency secret there — a test gets the test's keys. Everywhere else a component reaching
   * `Idempotency` with no secret is refused (`[application.idempotency-key-required]`).
   */
  readonly withoutIdempotencyKeys?: true | undefined;
}
