import type { App } from "../../app/types.js";
import { OutboundCalls } from "../../app/outbound-calls.js";
import { ApplicationContext } from "../../flow/context/application-context.js";
import { Clock } from "../../infrastructure/clock.js";
import { A2AFiles } from "../files/a2a-files.service.js";
import type { A2AFileDto } from "../files/a2a-file.dto.js";
import { A2AFileUnavailableError, A2AFileUnavailableReason } from "../files/a2a-file-errors.js";
import type { A2AMeshSeam } from "./a2a-mesh-seam.js";

/**
 * What an `A2AClient` uses of the application it runs in (#809, internal): its `OutboundCalls` (the
 * accept round trip) and its `Clock` (the card's cache, polling, the deadline). A client is the
 * project's own class, built with its own `deps`, so it reads them through the calling execution's
 * frame — remembered here per `ApplicationContext`, as the mesh settings are.
 */
export interface A2AClientServices {
  /** The application's `OutboundCalls`, resolved on the first call that needs it. */
  readonly outboundCalls: () => OutboundCalls;
  readonly clock: Clock;
  /** The application's `A2AFiles` (#859): a stored file an input forwards is read through it. */
  readonly files?: () => A2AFiles;
  /** What rides a call beyond the core protocol; none → the AGBoss mesh (`AGBOSS_MESH`). */
  readonly mesh?: A2AMeshSeam;
}

const byContext = new WeakMap<ApplicationContext, A2AClientServices>();

/** Remembers an application instance's services for its executions' A2A calls. */
export function rememberA2AClientServices(
  context: ApplicationContext,
  services: A2AClientServices,
): void {
  byContext.set(context, services);
}

/** The services of the application an execution runs in; `undefined` for one never remembered. */
export const a2aClientServicesOf = (context: ApplicationContext): A2AClientServices | undefined =>
  byContext.get(context);

/** Remembers what an application instance's A2A calls use: its `OutboundCalls` (on first use), its `Clock`. */
export function rememberA2AClientServicesOf(app: Pick<App, "resolve">): void {
  rememberA2AClientServices(app.resolve(ApplicationContext), {
    outboundCalls: () => app.resolve(OutboundCalls),
    clock: app.resolve(Clock),
    files: () => app.resolve(A2AFiles),
  });
}

/**
 * How a typed input's stored file (#859, `fileId`: a file of the calling execution's task) is read
 * before it is sent: the application's `A2AFiles`; outside an execution there is none to read.
 */
export const storedFileReaderOf =
  (services: A2AClientServices | undefined) =>
  (file: A2AFileDto): Promise<Uint8Array> => {
    const files = services?.files?.();
    return files === undefined
      ? Promise.reject(new A2AFileUnavailableError(A2AFileUnavailableReason.OutsideExecution))
      : files.read(file);
  };
