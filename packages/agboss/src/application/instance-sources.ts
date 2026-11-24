import type { Clock } from "../infrastructure/clock.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import { resolvedStorageOf } from "../storage/storage-assembly.js";
import type { ApplicationContainerSources } from "./application-container.js";
import type { AssembledApplication } from "./assemble.js";
import type { InstanceSeams } from "./instance-seams.js";

/** What the instance's container is built from besides the seams: modules, clock, contexts, storage. */
export const sourcesOf = (
  assembled: AssembledApplication,
  parts: {
    readonly clock: Clock;
    readonly contexts: RuntimeContexts;
    readonly seams: InstanceSeams;
    readonly processEnv: NodeJS.ProcessEnv;
  },
): ApplicationContainerSources => ({
  ...{ modules: assembled.modules, clock: parts.clock, contexts: parts.contexts },
  ...{ idGenerator: parts.seams.idGenerator },
  storage: resolvedStorageOf(assembled.storage, parts.processEnv),
});
