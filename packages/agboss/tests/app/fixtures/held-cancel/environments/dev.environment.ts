import { env } from "../../../../../src/index.js";
import type { HeldCancelEnvironment } from "./app.environment.js";

export const environment: HeldCancelEnvironment = {
  sqlitePath: env("HELD_CANCEL_SQLITE_PATH"),
};
