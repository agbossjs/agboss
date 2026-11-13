import { loadChatOpenAI } from "../../src/models/chat-openai.js";

/**
 * Tests make a provider's chat model without `createApp`, which loads the OpenAI client at
 * assembly (#956): the tests load it here, once per file.
 */
await loadChatOpenAI();
