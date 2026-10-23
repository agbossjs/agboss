/**
 * What a mesh transport (`a2aHttpListener`, `createMcpService`) needs of the application it serves
 * (#398, internal): its name — the `application` of its hops — and its `maxMeshHops`.
 */
export interface MeshSettings {
  readonly application: string;
  readonly maxMeshHops: number;
}

const settings = new WeakMap<object, () => MeshSettings | undefined>();

/** Remembers an application instance's mesh settings (read when a request comes in). */
export function rememberMeshSettings(app: object, read: () => MeshSettings | undefined): void {
  settings.set(app, read);
}

/** The settings of an app an application instance made; `undefined` for a host's own `A2AApp`. */
export const meshSettingsOf = (app: object): MeshSettings | undefined => settings.get(app)?.();
