import type { Provider } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import {
  hasProviderMethod,
  isModelProviderClass,
  isTransportClass,
  modelProviderOf,
  type ModelProviderType,
} from "./model-provider.decorator.js";
import { withFallbacks } from "./resolution.js";

/**
 * A `@ModelProvider` is either HTTP — `baseUrl` (and `apiKey`, `baseUrlField`), a `chat` /
 * `routeTo` class — or a transport (#385): `complete(request)`, `deps`, no base URL or key. Both at
 * once, or neither, is `[model-provider.both-modes]` (the decorator's overloads make it a compile
 * error too).
 */

const HTTP_FIELDS = ["baseUrl", "baseUrlField", "apiKey"] as const;

/** The HTTP fields the decorator sets. */
const httpFieldsOf = (cls: ModelProviderType): readonly string[] =>
  HTTP_FIELDS.filter((field) => Reflect.get(modelProviderOf(cls), field) !== undefined);

/** What is wrong with a provider's mode, if anything. */
function modeProblemOf(cls: ModelProviderType): string | undefined {
  const fields = httpFieldsOf(cls);
  const isTransport = isTransportClass(cls);
  if (isTransport && fields.length > 0)
    return `implements complete(request) and sets ${fields.join(", ")} — a transport makes its own calls: remove them`;
  if (isTransport && hasProviderMethod(cls, "chat"))
    return "has both chat(request) and complete(request) — keep one: HTTP (chat) or a transport (complete)";
  const deps = modelProviderOf(cls).deps ?? [];
  if (!isTransport && deps.length > 0)
    return "has deps but no complete(request) — only a transport provider is created by the container";
  if (!isTransport && fields.length === 0)
    return "has neither a baseUrl (HTTP) nor complete(request) (a transport)";
  return undefined;
}

/** `[model-provider.both-modes]` for every listed model provider and breaker fallback in no single mode. */
export function providerModeViolations(
  application: string,
  providers: readonly Provider[] | undefined,
): RuleViolation[] {
  const classes = withFallbacks((providers ?? []).filter(isModelProviderClass));
  return classes.flatMap((cls) => {
    const problem = modeProblemOf(cls);
    if (problem === undefined) return [];
    const message = `${modelProviderOf(cls).name} (${cls.name}) ${problem}`;
    return [violation("model-provider.both-modes", message, [application])];
  });
}
