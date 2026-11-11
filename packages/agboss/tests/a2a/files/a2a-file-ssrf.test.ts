/**
 * #904 items 2 and 3 (SSRF hardening of a file by `url`): every range of the IANA special-purpose
 * registries that is not globally reachable is refused, as an address and embedded in NAT64, 6to4,
 * IPv4-compatible, IPv4-mapped and IPv4-translated ones (checked as the IPv4 they carry) — no
 * address of one is ever connected to —; a url with userinfo is refused, on a redirect too.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { guardedLookupOf, isDeniedAddress } from "../../../src/a2a/files/a2a-file-address.js";
import { fetchedFile, type FileFetch } from "../../../src/a2a/files/a2a-file-fetch.js";
import {
  FileAddressDeniedError,
  httpsFileTransport,
} from "../../../src/a2a/files/a2a-file-transport.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { kilobytes, seconds } from "../../../src/units/index.js";
import { PDF, scriptedTransport } from "./support.js";

/** IPv4 ranges of the IANA registry that are not globally reachable: first and last address. */
const IPV4_RANGES: readonly (readonly [string, string, string])[] = [
  ["0.0.0.0/8 this network", "0.0.0.0", "0.255.255.255"],
  ["10.0.0.0/8 private", "10.0.0.0", "10.255.255.255"],
  ["100.64.0.0/10 shared address space", "100.64.0.0", "100.127.255.255"],
  ["127.0.0.0/8 loopback", "127.0.0.0", "127.255.255.255"],
  ["169.254.0.0/16 link-local", "169.254.0.0", "169.254.255.255"],
  ["172.16.0.0/12 private", "172.16.0.0", "172.31.255.255"],
  ["192.0.0.0/24 IETF protocol assignments", "192.0.0.0", "192.0.0.255"],
  ["192.0.2.0/24 documentation", "192.0.2.0", "192.0.2.255"],
  ["192.88.99.0/24 6to4 relay anycast", "192.88.99.0", "192.88.99.255"],
  ["192.168.0.0/16 private", "192.168.0.0", "192.168.255.255"],
  ["198.18.0.0/15 benchmarking", "198.18.0.0", "198.19.255.255"],
  ["198.51.100.0/24 documentation", "198.51.100.0", "198.51.100.255"],
  ["203.0.113.0/24 documentation", "203.0.113.0", "203.0.113.255"],
  ["224.0.0.0/4 multicast", "224.0.0.0", "239.255.255.255"],
  ["240.0.0.0/4 reserved, 255.255.255.255 broadcast", "240.0.0.0", "255.255.255.255"],
];

/** IPv6 ranges of the registry that are not globally reachable (or deprecated): first and last. */
const IPV6_RANGES: readonly (readonly [string, string, string])[] = [
  ["::/128 unspecified", "::", "::"],
  ["::1/128 loopback", "::1", "::1"],
  ["64:ff9b:1::/48 local-use NAT64", "64:ff9b:1::", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff"],
  ["100::/64 discard-only", "100::", "100::ffff:ffff:ffff:ffff"],
  ["100:0:0:1::/64 dummy prefix", "100:0:0:1::", "100::1:ffff:ffff:ffff:ffff"],
  ["2001::/23 IETF protocol assignments (Teredo)", "2001::", "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["2001:db8::/32 documentation", "2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["3fff::/20 documentation", "3fff::", "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["5f00::/16 segment routing", "5f00::", "5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["fc00::/7 unique-local", "fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["fe80::/10 link-local", "fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["fec0::/10 site-local", "fec0::", "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ["ff00::/8 multicast", "ff00::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
];

/** Public neighbours of the ranges above: never refused. */
const PUBLIC = ["1.1.1.1", "100.128.0.0", "172.32.0.1", "192.0.1.255", "198.20.0.0", "223.255.255.255"];
const PUBLIC_V6 = ["2606:4700:4700::1111", "2001:200::1", "2001:db9::1", "fbff::1"];

/** `a.b.c.d` as two hextets, `abcd:ef01`. */
const hextetsOf = (ipv4: string): string => {
  const [a = 0, b = 0, c = 0, d = 0] = ipv4.split(".").map(Number);
  return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
};

/** The IPv6 forms an IPv4 address rides in. */
const EMBEDDED: readonly (readonly [string, (ipv4: string) => string])[] = [
  ["IPv4-mapped (dotted)", (ipv4) => `::ffff:${ipv4}`],
  ["IPv4-mapped (hex)", (ipv4) => `::ffff:${hextetsOf(ipv4)}`],
  ["IPv4-compatible", (ipv4) => `::${hextetsOf(ipv4)}`],
  ["IPv4-translated (SIIT)", (ipv4) => `::ffff:0:${hextetsOf(ipv4)}`],
  ["NAT64 well-known prefix", (ipv4) => `64:ff9b::${hextetsOf(ipv4)}`],
  ["NAT64 (dotted)", (ipv4) => `64:ff9b::${ipv4}`],
  ["6to4", (ipv4) => `2002:${hextetsOf(ipv4)}::1`],
  ["6to4 (bracketed)", (ipv4) => `[2002:${hextetsOf(ipv4)}:ffff::]`],
];

describe("#904 item 2: the IANA special-purpose ranges are never fetched from", () => {
  it.each(IPV4_RANGES)("AC2.1 IPv4 %s: its first and last address refused", (_range, first, last) => {
    expect([isDeniedAddress(first), isDeniedAddress(last)]).toEqual([true, true]);
  });

  it.each(IPV6_RANGES)("AC2.1 IPv6 %s: its first and last address refused", (_range, first, last) => {
    expect([isDeniedAddress(first), isDeniedAddress(last)]).toEqual([true, true]);
  });

  it("AC2.1 the public neighbours of those ranges pass", () => {
    expect([...PUBLIC, ...PUBLIC_V6].filter(isDeniedAddress)).toEqual([]);
  });

  it.each(EMBEDDED)("AC2.2 %s: the IPv4 it carries is checked as IPv4", (_form, embed) => {
    const denied = ["169.254.169.254", "127.0.0.1", "10.0.0.1", "100.64.0.1", "198.18.0.1"];

    expect(denied.map(embed).filter((address) => !isDeniedAddress(address))).toEqual([]);
    expect(isDeniedAddress(embed("93.184.216.34"))).toBe(false);
  });

  it("AC2.2 the acceptance's address, 64:ff9b::a9fe:a9fe (169.254.169.254 by NAT64), is refused", () => {
    expect(isDeniedAddress("64:ff9b::a9fe:a9fe")).toBe(true);
    expect(isDeniedAddress("[64:ff9b::169.254.169.254]")).toBe(true);
    expect(isDeniedAddress("fe80::1%eth0")).toBe(true);
  });
});

/** An IPv4 address of a range by its first and last address, `offset` of the way in. */
const ipv4Within = (first: string, last: string, offset: number): string => {
  const numberOf = (text: string) =>
    text.split(".").reduce((total, octet) => total * 256 + Number(octet), 0);
  const value = numberOf(first) + Math.floor((numberOf(last) - numberOf(first) + 1) * offset);
  return [24, 16, 8, 0].map((shift) => String(Math.floor(value / 2 ** shift) % 256)).join(".");
};

const anyBlockedIpv4 = fc
  .tuple(fc.constantFrom(...IPV4_RANGES), fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }))
  .map(([[, first, last], offset]) => ipv4Within(first, last, offset));

const anyBlockedAddress = fc.oneof(
  anyBlockedIpv4,
  fc.tuple(anyBlockedIpv4, fc.constantFrom(...EMBEDDED)).map(([ipv4, [, embed]]) => embed(ipv4)),
  fc.constantFrom(...IPV6_RANGES.flatMap(([, first, last]) => [first, last])),
);

/** What a guarded lookup answers for a name resolving to `address`. */
const lookedUp = (address: string) =>
  new Promise<unknown>((resolve) => {
    const family = address.includes(":") ? 6 : 4;
    guardedLookupOf((_hostname, callback) => {
      callback(null, [{ address, family }]);
    })("files.example", {}, (error) => {
      resolve(Reflect.get(Object(error), "code"));
    });
  });

describe("#904 item 2 AC2.3: no address of a blocked range is ever connected to (property)", () => {
  it("as a name's answer: the lookup refuses it; as an IP literal: the transport refuses it unasked", async () => {
    await fc.assert(
      fc.asyncProperty(anyBlockedAddress, async (address) => {
        const host = address.startsWith("[") || !address.includes(":") ? address : `[${address}]`;
        const literal = httpsFileTransport(new URL(`https://${host}/file`), new AbortController().signal);

        expect(isDeniedAddress(address)).toBe(true);
        expect(await lookedUp(address.replace(/^\[|\]$/g, ""))).toBe("A2A_FILE_ADDRESS_DENIED");
        await expect(literal).rejects.toBeInstanceOf(FileAddressDeniedError);
      }),
      { numRuns: 500 },
    );
  });
});

const ORIGIN = "https://files.example";

const fetchOf = (transport: FileFetch["transport"], url: string): FileFetch => ({
  url,
  allowedOrigins: [ORIGIN],
  maxBytes: kilobytes(64),
  transport,
  clock: new VirtualClock(new Date("2026-01-05T09:00:00.000Z")),
  timeout: seconds(10),
  signal: new AbortController().signal,
});

const codeOf = async (work: Promise<unknown>): Promise<unknown> =>
  work.then(
    () => "fetched",
    (error: unknown) =>
      Reflect.get(Object(Reflect.get(Object(error), "metadata")), "code") ??
      Reflect.get(Object(error), "message"),
  );

describe("#904 item 3: a url with userinfo is refused", () => {
  it("AC3.1 user and password, a user alone, a password alone: a2a.file-origin-denied, nothing asked", async () => {
    const script = scriptedTransport({ [`${ORIGIN}/a`]: { body: PDF } });

    const codes = await Promise.all(
      ["https://u:p@files.example/a", "https://u@files.example/a", "https://:p@files.example/a"].map(
        (url) => codeOf(fetchedFile(fetchOf(script.transport, url))),
      ),
    );

    expect(codes).toEqual(["a2a.file-origin-denied", "a2a.file-origin-denied", "a2a.file-origin-denied"]);
    expect(script.asked).toEqual([]);
  });

  it("AC3.2 a redirect to a url with userinfo on an allowed origin: refused, never followed", async () => {
    const script = scriptedTransport({
      [`${ORIGIN}/a`]: { status: 302, location: "https://u:p@files.example/b" },
      [`${ORIGIN}/b`]: { body: PDF },
    });

    const code = await codeOf(fetchedFile(fetchOf(script.transport, `${ORIGIN}/a`)));

    expect(code).toBe("a2a.file-origin-denied");
    expect(script.asked).toEqual([`${ORIGIN}/a`]);
  });
});
