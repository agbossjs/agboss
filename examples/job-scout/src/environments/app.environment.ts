/**
 * job-scout's environment contract (#261): declared fields only — the values are in each
 * `<name>.environment.ts` here. Declared once: `@Application({ environment: AppEnvironment })`;
 * `GreenhouseBoards` gets it with `@Injectable({ deps: [ENV] })`.
 */
export class AppEnvironment {
  /** The Greenhouse job-board API. */
  greenhouseApiUrl!: string;
  /** The file of the SQLite implementations the application lists (`:memory:` in tests). */
  sqlitePath!: string;
}
