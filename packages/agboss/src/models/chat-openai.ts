import type { ChatOpenAI } from "@langchain/openai";
import { lazyLoad } from "../infrastructure/clock.js";

/**
 * The OpenAI chat client (`@langchain/openai`, with the OpenAI SDK behind it: hundreds of modules),
 * loaded when an application is assembled or on a model's first call, not when the root is read
 * (#956). A failed load leaves nothing behind: the next call tries again.
 */
let loaded: typeof ChatOpenAI | undefined;

/** Loads the client (`createApp` assembly, a lazy model's first call); a no-op once loaded. */
export async function loadChatOpenAI(): Promise<typeof ChatOpenAI> {
  loaded ??= (await lazyLoad(import("@langchain/openai"))).ChatOpenAI;
  return loaded;
}

/** The client when something has loaded it, else `undefined`: `chat()` is synchronous. */
export const loadedChatOpenAI = (): typeof ChatOpenAI | undefined => loaded;
