import type { ChatOpenAI } from "@langchain/openai";
import { lazyLoad } from "../infrastructure/clock.js";

/**
 * The OpenAI chat client (`@langchain/openai`, with the OpenAI SDK behind it: hundreds of modules),
 * loaded on the first call of a model, not when the root is read (#956). Nothing is cached here: the
 * module system keeps a loaded module, and a failed load is tried again by the next call.
 */
export const loadChatOpenAI = async (): Promise<typeof ChatOpenAI> =>
  (await lazyLoad(import("@langchain/openai"))).ChatOpenAI;
