/** How the workflows are assembled: a profile on top of each (`profiles/<workflow>/<profile>.yaml`). */
export interface ApplicationAssembly {
  readonly profile?: string | undefined;
  readonly profileRoot?: string | undefined;
  /** Where prompt variables' `env(…)` references are read from (#1347c); default `process.env`. */
  readonly processEnv?: NodeJS.ProcessEnv | undefined;
}
