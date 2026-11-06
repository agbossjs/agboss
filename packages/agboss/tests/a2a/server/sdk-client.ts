import { Role, type Message } from "@a2a-js/sdk";
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  type Client,
} from "@a2a-js/sdk/client";

/** `fetch` with the bearer token of `owner` (none: no token). */
export const fetchAs =
  (owner: string | undefined, headers: Record<string, string> = {}): typeof fetch =>
  (input, init) => {
    const sent = new Headers(init?.headers);
    if (owner !== undefined) sent.set("authorization", `Bearer ${owner}`);
    for (const [name, value] of Object.entries(headers)) sent.set(name, value);
    return fetch(input, { ...init, headers: sent });
  };

/** The official SDK's client of the agent at `url`, its card fetched, as `owner` (#808 AC1). */
export function sdkClientOf(
  url: string,
  owner: string | undefined = "dana",
  headers: Record<string, string> = {},
): Promise<Client> {
  const fetchImpl = fetchAs(owner, headers);
  const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl }),
  });
  return new ClientFactory(options).createFromUrl(url);
}

const part = (text: string) => ({
  content: { $case: "text" as const, value: text },
  metadata: undefined,
  filename: "",
  mediaType: "text/plain",
});

/** A user message of one text part. */
export const textMessage = (
  messageId: string,
  text: string,
  fields: Partial<Pick<Message, "taskId" | "contextId" | "metadata">> = {},
): Message => ({
  messageId,
  role: Role.ROLE_USER,
  parts: [part(text)],
  contextId: fields.contextId ?? "",
  taskId: fields.taskId ?? "",
  metadata: fields.metadata,
  extensions: [],
  referenceTaskIds: [],
});

/** A user message of one data part. */
export const dataMessage = (
  messageId: string,
  value: unknown,
  fields: Partial<Pick<Message, "taskId" | "contextId" | "metadata">> = {},
): Message => ({
  ...textMessage(messageId, "", fields),
  parts: [
    {
      content: { $case: "data", value },
      metadata: undefined,
      filename: "",
      mediaType: "application/json",
    },
  ],
});
