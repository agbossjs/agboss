/**
 * #916 D1, the second guard: the address a file fetch's socket is really connected to is checked
 * again — denied addresses (the embedded-IPv4 forms of #914 too), a peer the guarded lookup did not
 * answer (a proxy standing in for the host) and a socket that skipped the file agent are refused.
 */
import { describe, expect, it } from "vitest";
import { isExpectedPeer } from "../../../src/a2a/files/a2a-file-agent.js";

const answers = (...addresses: string[]): ReadonlySet<string> => new Set(addresses);

describe("#916 D1: the connected peer of a file fetch", () => {
  it("D1.1 the address the lookup answered is the expected peer", () => {
    expect(isExpectedPeer("93.184.216.34", answers("93.184.216.34"), "example.com")).toBe(true);
    expect(isExpectedPeer("2606:2800:220:1::1", answers("2606:2800:220:1::1"), "example.com")).toBe(
      true,
    );
    expect(isExpectedPeer("::ffff:93.184.216.34", answers("93.184.216.34"), "example.com")).toBe(
      true,
    );
  });

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
  ])("D1.2 a denied remote address %s is refused even when the lookup answered it", (remote) => {
    expect(isExpectedPeer(remote, answers(remote), "example.com")).toBe(false);
  });

  it("D1.3 a remote that is not an address the lookup answered (a proxy) is refused", () => {
    expect(isExpectedPeer("203.0.113.9", answers("93.184.216.34"), "example.com")).toBe(false);
    expect(isExpectedPeer("93.184.216.35", answers("93.184.216.34"), "example.com")).toBe(false);
  });

  it("D1.4 a socket that skipped the file agent (no answers) or has no remote is refused", () => {
    expect(isExpectedPeer("93.184.216.34", undefined, "example.com")).toBe(false);
    expect(isExpectedPeer(undefined, answers("93.184.216.34"), "example.com")).toBe(false);
    expect(isExpectedPeer("93.184.216.34", answers(), "example.com")).toBe(false);
  });

  it("D1.5 an IP literal in the url is the expected peer itself, and only if allowed", () => {
    expect(isExpectedPeer("93.184.216.34", undefined, "93.184.216.34")).toBe(true);
    expect(isExpectedPeer("93.184.216.35", undefined, "93.184.216.34")).toBe(false);
    expect(isExpectedPeer("127.0.0.1", undefined, "127.0.0.1")).toBe(false);
  });
});
