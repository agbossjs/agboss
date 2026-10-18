/**
 * The environment contract of an application with no settings (#261: `environment` is required) —
 * `@Application({ environment: EmptyEnvironment })`. It declares no fields, so the application
 * needs no environment file; add a contract of its own when it gets settings.
 */
export class EmptyEnvironment {
  /** Never set, and not a field: the contract stays empty. */
  declare private readonly noFields?: never;
}
