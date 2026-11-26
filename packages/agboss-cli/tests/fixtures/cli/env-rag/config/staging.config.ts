import { configureEnv, defineConfig } from "../../../../../../agboss/src/index.js";
import { ragEnv } from "../env-rag.application.js";

export default defineConfig({ env: configureEnv(ragEnv, { docs: "from-staging" }) });
