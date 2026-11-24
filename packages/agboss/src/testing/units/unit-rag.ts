import type { Container } from "../../components/container/container.js";
import { componentOf } from "../../components/metadata.js";
import { ragMeta } from "../../components/rag.js";
import { buildRagRuntime } from "../../components/rag-retrieval.js";
import type { Class } from "../../components/injection.js";
import type { RuntimeContexts } from "../../flow/context/runtime-contexts.js";
import type { ModelGateway } from "../../llm/gateway.js";
import { bindRagRuntime, isRagSource } from "../../rag/rag-source.js";
import type { WorkflowServices } from "../../workflow.js";
import { unitChatSettings } from "./unit-models.js";

/**
 * A `@Rag` source of a unit runner gets the pipeline an application gives it — its scope, its
 * reranker on the runner's scripted gateway, its spend — when the runner's container creates it.
 */
export function bindUnitRag(
  instance: unknown,
  contexts: RuntimeContexts,
  container: Container,
  gateway: () => ModelGateway,
): void {
  if (!isRagSource(instance)) return;
  const cls = instance.constructor as Class;
  if (componentOf(cls)?.kind !== "rag") return;
  const services: WorkflowServices = {
    contexts,
    router: () => {
      throw new TypeError("a unit runner has no router");
    },
    rerankModel: (reranker, model) => {
      const settings = unitChatSettings(model);
      const chat = gateway().chatModel({ user: { kind: "reranker", reranker }, settings });
      return { model: chat, settings };
    },
  };
  bindRagRuntime(
    instance,
    buildRagRuntime(ragMeta(cls), instance, (dep) => container.get(dep), services, {}),
  );
}
