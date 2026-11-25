import { defineConfig } from "../../../../../src/index.js";
import { PurchaseTargetsWorkflow } from "../../../../channels/pause-targets.fixture.js";

export default defineConfig({ channels: [PurchaseTargetsWorkflow, "inbox"] as never });
