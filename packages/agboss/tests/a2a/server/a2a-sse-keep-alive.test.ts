/** #1008 AC2: an idle SSE stream says `: keep-alive` every 15 s of the application's clock. */
import { describe, expect, it } from "vitest";
import { SSE_KEEP_ALIVE } from "../../../src/a2a/server/a2a-sse-write.js";
import { seconds } from "../../../src/units/index.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { received, sseClient, sseServer } from "./support/sse-socket.js";

describe("#1008 AC2: keep-alive", () => {
  it("an idle stream writes a comment each interval of the app's clock, and none before", async () => {
    const clock = new VirtualClock();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const server = await sseServer(
      () =>
        (async function* () {
          yield { kind: "first" };
          await gate;
        })(),
      clock,
    );
    const client = await sseClient(server.port);
    const got = received(client);
    await got.until('"first"');

    expect(SSE_KEEP_ALIVE).toBe(seconds(15));
    await clock.advance(seconds(14));
    expect(got.text()).not.toContain(": keep-alive");

    await clock.advance(seconds(1));
    await got.until(": keep-alive");
    const count = (): number => got.text().split(": keep-alive").length - 1;
    expect(count()).toBe(1);

    await clock.advance(SSE_KEEP_ALIVE);
    await got.until(": keep-alive\n\n: keep-alive");
    expect(count()).toBe(2);

    release();
    await server.answered();
    await new Promise<void>((resolve) => client.once("end", resolve));
    expect(client.complete).toBe(true);
    await server.close();
  });
});
