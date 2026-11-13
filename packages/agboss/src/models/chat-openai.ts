import type { ChatOpenAI } from "@langchain/openai";
import { lazyLoad } from "../infrastructure/clock.js";

/**
 * The OpenAI chat client (`@langchain/openai`, with the OpenAI SDK behind it: hundreds of modules),
 * loaded when an application is created, not when its decorators are read: the providers' `chat`
 * is synchronous, so the class is kept here once loaded. A failed load leaves nothing behind and
 * the next call tries again.
 */
let loaded: typeof ChatOpenAI | undefined;

/** Loads the client (`createApp` → `chatExtensionsFor`); a no-op once loaded. */
export async function loadChatOpenAI(): Promise<void> {
  if (loaded !== undefined) return;
  loaded = (await lazyLoad(import("@langchain/openai"))).ChatOpenAI;
}

/** The loaded client; `chat` of a provider is called only after `loadChatOpenAI`. */
export function chatOpenAIClass(): typeof ChatOpenAI {
  if (loaded === undefined) {
    throw new Error("The OpenAI chat client is not loaded: await loadChatOpenAI() first");
  }
  return loaded;
}
