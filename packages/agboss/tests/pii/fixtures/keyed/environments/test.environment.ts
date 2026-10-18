import { secret } from "../../../../../src/index.js";
import type { PiiEnvironment } from "./app.environment.js";

export const environment: PiiEnvironment = { piiPseudonymKey: secret("PII_APP_KEY") };
