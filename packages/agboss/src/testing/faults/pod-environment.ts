import {
  TIME_ORIGIN_VARIABLE,
  CLOCK_OFFSET_VARIABLE,
  CLOCK_DRIFT_VARIABLE,
  TIME_SCALE_VARIABLE,
} from "./fault-clock.js";
import type { PodLaunch } from "./pod.js";
import { POD_VARIABLES, boundedValueOf, expiringValueOf } from "./pod-protocol.js";

/** The environment of a pod's process. */
export const podEnvironment = (launch: PodLaunch): NodeJS.ProcessEnv => ({
  ...process.env,
  [POD_VARIABLES.name]: launch.name,
  [POD_VARIABLES.stores]: launch.storesModule,
  [POD_VARIABLES.database]: launch.databaseUrl,
  [POD_VARIABLES.shutdownTimeout]: launch.shutdownTimeout?.toString() ?? "",
  [POD_VARIABLES.maxConcurrentSteps]: launch.maxConcurrentSteps?.toString() ?? "",
  [POD_VARIABLES.sabotage]: launch.sabotage ?? "",
  [POD_VARIABLES.expiring]: expiringValueOf(launch.hasExpiringOrders),
  [POD_VARIABLES.bounded]: boundedValueOf(launch.isBounded),
  [TIME_SCALE_VARIABLE]: String(launch.timeScale),
  [TIME_ORIGIN_VARIABLE]: String(launch.timeOrigin),
  [CLOCK_OFFSET_VARIABLE]: String(launch.clockSkew?.offset ?? 0),
  [CLOCK_DRIFT_VARIABLE]: String(launch.clockSkew?.drift ?? 0),
});
