import { driverHandlerOf } from "../../src/models/model-driver.js";
import { isDriverOptions, modelProviderOf } from "../../src/models/model-provider.decorator.js";
import type { ProviderHandler } from "../../src/models/handler.js";
import type { OpenAiCompatibleProvider } from "../../src/models/openai-compatible.provider.js";
import type { OpenRouterProvider } from "../../src/models/openrouter.provider.js";

/** The handler of a driver provider's driver, as a test calls it directly (its `chat`, its wire plan). */
export function handlerOf(
  cls: object,
): OpenAiCompatibleProvider & OpenRouterProvider & ProviderHandler {
  const options = modelProviderOf(cls);
  if (!isDriverOptions(options)) throw new Error(`${options.name} is not a driver provider`);
  return driverHandlerOf(options.driver) as OpenAiCompatibleProvider &
    OpenRouterProvider &
    ProviderHandler;
}
