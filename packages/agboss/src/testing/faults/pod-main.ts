/**
 * A fault pod (#484): one application instance of the fault fixture in a `node` process of its
 * own, started by the fault suite with an IPC channel. It imports the store set's module
 * (`AGBOSS_FAULT_STORES`), builds the fixture application on it — its database at
 * `AGBOSS_FAULT_DATABASE_URL` —, listens for SIGTERM as `createApp` does, says `ready`, then does
 * each command of the test and acks it. Its held stores report every operation, its holds every
 * held operation. Nothing is shared with the other pods but the database and the test.
 */
import { pathToFileURL } from "node:url";
import { applicationOf } from "../../application/assemble.js";
import { buildApplication } from "../../application/create-app.js";
import { closeOnStopSignals } from "../../application/stop-signals.js";
import { resolveEnvironment } from "../../environments/resolve.js";
import { waitOf } from "../../infrastructure/clock.js";
import { FAULT_STORES_EXPORT, type FaultStores } from "./fault-stores.js";
import { faultApplicationOf } from "./fixture/fault.application.js";
import { connectPodLink, deliverGatewayReply, sendToTest } from "./fixture/pod-link.js";
import { heldStoreSeam } from "./held-stores.js";
import { processHoldPoints } from "./hold-points.js";
import { commandDone, type PodParts } from "./pod-control.js";
import { POD_VARIABLES, type FromPod, type ToPod } from "./pod-protocol.js";

/** The store set of the module at `path`. */
async function storesOf(path: string): Promise<FaultStores> {
  const url = path.startsWith("file:") ? path : pathToFileURL(path).href;
  const module = (await import(url)) as Readonly<Record<string, unknown>>;
  const stores = module[FAULT_STORES_EXPORT];
  if (typeof stores !== "object" || stores === null)
    throw new Error(`${path} exports no ${FAULT_STORES_EXPORT} (defineFaultStores({ … }))`);
  return stores as FaultStores;
}

/** A whole number from the environment, when set. */
const numberOf = (name: string): number | undefined => {
  const text = process.env[name];
  return text === undefined || text === "" ? undefined : Number(text);
};

const send = (message: FromPod): void => {
  process.send?.(message);
};

/** Sends `message`, then ends the process once the channel took it. */
const sendThenExit = (message: FromPod): void => {
  if (process.send === undefined) process.exit(0);
  process.send(message, undefined, {}, () => process.exit(0));
};

/** Answers one message of the test. */
async function answer(parts: PodParts, message: ToPod): Promise<void> {
  if (message.kind === "gateway-reply") {
    deliverGatewayReply(message.id, message.result, message.error);
    return;
  }
  const reply = await commandDone(parts, message.command).then(
    (result): FromPod => ({ kind: "reply", id: message.id, result }),
    (error: unknown): FromPod => ({ kind: "reply", id: message.id, error: String(error) }),
  );
  if (message.command.op === "close") sendThenExit(reply);
  else send(reply);
}

const name = process.env[POD_VARIABLES.name] ?? "pod";
connectPodLink({ send });
heldStoreSeam.process = name;
heldStoreSeam.recorder = {
  record: (event) => {
    send({ kind: "operation", event });
  },
};
processHoldPoints.onHeld((held) => {
  sendToTest({ kind: "event", event: { ...held, type: "held" } });
});
const stores = await storesOf(process.env[POD_VARIABLES.stores] ?? "");
const shutdownTimeout = numberOf(POD_VARIABLES.shutdownTimeout);
const application = faultApplicationOf(stores, {
  shutdownTimeout: shutdownTimeout === undefined ? undefined : waitOf(shutdownTimeout),
  maxConcurrentSteps: numberOf(POD_VARIABLES.maxConcurrentSteps),
});
const assembled = await applicationOf(application);
const loaded = {
  name: "fault",
  contract: stores.environment.contract.name,
  values: stores.environment.values,
};
const instanceId = `${name}-${String(process.pid)}`;
heldStoreSeam.instanceId = instanceId;
const built = await buildApplication(
  assembled,
  { environmentName: "fault", environment: resolveEnvironment(loaded, process.env) },
  { instanceId },
);
closeOnStopSignals(built);
process.on("SIGTERM", () => {
  sendToTest({ kind: "event", event: { type: "signal", signal: "SIGTERM" } });
});
void built.closed.then(() => {
  sendThenExit({ kind: "event", event: { type: "closed" } });
});
const parts: PodParts = {
  app: built.app,
  points: processHoldPoints,
  seam: heldStoreSeam,
  businessRows: stores.businessRows,
};
process.on("message", (message: ToPod) => {
  void answer(parts, message);
});
send({ kind: "event", event: { type: "ready", instanceId, pid: process.pid } });
