import { rememberExecutionControl } from "../app/execution-control.js";
import { LeaseGate, rememberLeaseGate } from "./leases.js";
import type { BuiltApplication } from "../application/create-app.js";
import type { AnyTenantApp } from "../app/types.js";
import type { Class, Resolved, Token } from "../components/injection.js";
import type { AgentsConfigOf } from "../config/types.js";
import type { VirtualClock } from "./clock.js";
import type { TestEnvironment } from "./environment.js";
import { TestFailure } from "./errors.js";
import {
  type ActionSlice,
  type AgentSlice,
  type RouterSlice,
  type ToolClassOf,
  type ToolSlice,
} from "./slices.js";
import { isListedProvider, rememberListedProviders } from "../application/listed-providers.js";
import { meshSettingsOf, rememberMeshSettings } from "../mesh/mesh-settings.js";
import { lazyLoad } from "../infrastructure/clock.js";
import {
  checked,
  forwardedControlOf,
  probesOf,
  resolvingOf,
  runsOf,
  slicesOf,
} from "./test-app-parts.js";

/**
 * The app of a test: the same `run` / `resume` as in production, built on first use (so `mockOf`
 * in the test body still takes effect), plus the test's clock and slices of single components.
 * A blocked live call or a script problem fails the call, even when the run swallowed it; any call
 * after `close()` (or `recoverApp()`) but the probes (#300) fails with `test.app-closed`.
 */
export interface TestApp extends Pick<
  AnyTenantApp,
  | "execute"
  | "resume"
  | "extendPause"
  | "reassignPause"
  | "close"
  | "cancel"
  | "getStatusHistory"
  | "checkLiveness"
  | "checkReadiness"
  | "auditLogOf"
  | "outboundCallsOf"
  | "pendingOutboundCallsOf"
  | "listPauses"
  | "resolve"
> {
  readonly clock: VirtualClock;
  /**
   * The settings each workflow of the application runs with, by its name — a profile of
   * `testWith(App, { profile })` applied (#895): `app.settings["scout-workflow"].agents["scout-agent"].thinking`.
   * Read-only; known before the app is built.
   */
  readonly settings: Readonly<Record<string, AgentsConfigOf<string>>>;
  /**
   * Builds the test's application now (assembly, `onInit` → `onStart`), for a test that executes
   * nothing; the first `execute` builds it otherwise. A second call does nothing.
   */
  ready(): Promise<void>;
  /**
   * What the app's container gives for a token (#1328): a class's instance, the value of an
   * `InjectionToken`, or the resolved values of a `defineEnv` dictionary — `app.get(appEnv).region`.
   * The app must be built (`await app.ready()` or an execute).
   */
  get<TToken extends Token>(token: TToken): Resolved<TToken>;
  action(action: Class): ActionSlice;
  agent(agent: Class): AgentSlice;
  router(router: Class): RouterSlice;
  tool<TInput, TOutput>(tool: ToolClassOf<TInput, TOutput>): ToolSlice<TInput, TOutput>;
}

/**
 * The app once the module of its probes is loaded too (#300): in production it loads on the first
 * probe; in a test `checkReadiness()` followed at once by `clock.advance(…)` must find its timeouts
 * already waiting on the clock.
 */
async function withProbesLoaded(building: Promise<BuiltApplication>): Promise<BuiltApplication> {
  const [built] = await Promise.all([
    building,
    lazyLoad(import("../health/application-health.js")),
  ]);
  return built;
}

/** The config of each workflow of the application, as assembled (a profile applied), by name. */
const settingsOf = (environment: TestEnvironment): TestApp["settings"] =>
  Object.fromEntries(
    environment.assembled.workflows.map((workflow) => [workflow.config.name, workflow.config]),
  );

/** What other parts of the framework learn of a test app: its providers, mesh, trees and gate. */
function remembering(testApp: TestApp, readyApp: () => AnyTenantApp, gate: LeaseGate): TestApp {
  // a listener built from this app checks its providers like the built application's (#387)
  rememberListedProviders(testApp, (cls) => isListedProvider(readyApp(), cls) ?? false);
  rememberMeshSettings(testApp, () => meshSettingsOf(readyApp()));
  // a transport built from this app reaches its trees by id (#807: an A2A server in a test)
  rememberExecutionControl(testApp, forwardedControlOf(readyApp));
  // `leases.freeze(app)` closes this instance's gate (#471)
  rememberLeaseGate(testApp, gate);
  return testApp;
}

export function createTestApp(environment: TestEnvironment): TestApp {
  const gate = new LeaseGate();
  let building: Promise<BuiltApplication> | undefined;
  /** The built application once `building` resolved: `resolve` reads it synchronously. */
  let ready: BuiltApplication | undefined;
  let closed = false;
  const built = (): Promise<BuiltApplication> => {
    if (closed) {
      const message = "this app is closed — after recoverApp() use the app it returned";
      return Promise.reject(new TestFailure({ code: "test.app-closed", message }));
    }
    return (building ??= withProbesLoaded(environment.newApp(gate)).then(
      (application) => (ready = application),
    ));
  };
  const probed = (): Promise<BuiltApplication> => building ?? built();
  const readyApp = (): AnyTenantApp => {
    if (ready === undefined) {
      const message = "the app is not built yet — await app.ready() (or an execute) before resolve";
      throw new TestFailure({ code: "test.app-not-ready", message });
    }
    return ready.app;
  };
  const testApp: TestApp = {
    clock: environment.clock,
    settings: settingsOf(environment),
    ...runsOf(environment, built),
    extendPause: (request, options) =>
      checked(environment, async () => (await built()).app.extendPause(request, options)),
    reassignPause: (request, options) =>
      checked(environment, async () => (await built()).app.reassignPause(request, options)),
    cancel: (thread, options) =>
      checked(environment, async () => (await built()).app.cancel(thread, options)),
    ...probesOf(environment, probed),
    ready: () =>
      checked(environment, async () => {
        await built();
      }),
    ...resolvingOf(readyApp),
    close: async (options) => {
      closed = true;
      if (building !== undefined) await (await building).app.close(options);
    },
    ...slicesOf(environment, built),
  };
  return remembering(testApp, readyApp, gate);
}
