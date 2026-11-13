/**
 * What an A2A client shows of a streamed task (#1004, #1006): the text of its output artifact as
 * A2A v1.0 says to apply the chunks — `append: false` replaces it, `append: true` extends it.
 */
import type { Part, StreamResponse } from "@a2a-js/sdk";
import { sdkClientOf, textMessage } from "../a2a/server/sdk-client.js";

export const textOf = (parts: readonly Part[]): string =>
  parts.map((part) => (part.content?.$case === "text" ? part.content.value : "")).join("");

/** One artifact chunk as the client received it. */
export interface Chunk {
  readonly text: string;
  readonly append: boolean;
  readonly last: boolean;
}

export const chunksOf = (events: readonly StreamResponse[]): Chunk[] =>
  events.flatMap((event) =>
    event.payload?.$case === "artifactUpdate"
      ? [
          {
            text: textOf(event.payload.value.artifact?.parts ?? []),
            append: event.payload.value.append,
            last: event.payload.value.lastChunk,
          },
        ]
      : [],
  );

/** The text the client shows after every chunk, in order. */
export function viewOf(chunks: readonly Chunk[]): string {
  return chunks.reduce((shown, chunk) => (chunk.append ? shown + chunk.text : chunk.text), "");
}

/** The state names of the status updates, in order (the task event's own state first). */
export function statesOf(events: readonly StreamResponse[]): string[] {
  return events.flatMap((event) => {
    switch (event.payload?.$case) {
      case "task":
        return [String(event.payload.value.status?.state)];
      case "statusUpdate":
        return [String(event.payload.value.status?.state)];
      default:
        return [];
    }
  });
}

const request = (messageId: string, text: string) => ({
  tenant: "",
  message: textMessage(messageId, text),
  configuration: {
    acceptedOutputModes: [],
    taskPushNotificationConfig: undefined,
    returnImmediately: false,
  },
  metadata: undefined,
});

/** Streams one message to the agent at `url` with the official SDK's client. */
export async function streamed(url: string, id: string, text = "Q"): Promise<StreamResponse[]> {
  const client = await sdkClientOf(url);
  const events: StreamResponse[] = [];
  for await (const event of client.sendMessageStream(request(id, text))) events.push(event);
  return events;
}
