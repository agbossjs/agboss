import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * The addresses a file by `url` is never fetched from (#859, #904: SSRF) — every range of the IANA
 * special-purpose registries that is not globally reachable (or is deprecated), checked on the
 * address the connection is made to (the lookup's answer, an IP literal as it is), so a name that
 * resolves to one, or a redirect to one, is refused as well. An IPv6 address that carries an IPv4
 * one — IPv4-mapped (`::ffff:0:0/96`), IPv4-translated (`::ffff:0:0:0/96`), IPv4-compatible
 * (`::/96`), NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`) — is checked as the IPv4 it carries: each
 * IPv4 range below is blocked in every one of those forms too.
 */
const IPV4_BLOCKED: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // this network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // shared address space (carrier-grade NAT)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation (TEST-NET-1)
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation (TEST-NET-2)
  ["203.0.113.0", 24], // documentation (TEST-NET-3)
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and 255.255.255.255 (broadcast)
];

const IPV6_BLOCKED: readonly (readonly [string, number])[] = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b:1::", 48], // local-use NAT64 (its embedding is the operator's)
  ["100::", 64], // discard-only
  ["100:0:0:1::", 64], // dummy prefix
  ["2001::", 23], // IETF protocol assignments: Teredo, benchmarking, ORCHID, …
  ["2001:db8::", 32], // documentation
  ["3fff::", 20], // documentation
  ["5f00::", 16], // segment routing (SRv6) SIDs
  ["fc00::", 7], // unique-local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
];

/** `10.0.0.0` → `a00:0`: an IPv4 address as the two hextets that carry it. */
const hextetsOf = (ipv4: string): string => {
  const [a = 0, b = 0, c = 0, d = 0] = ipv4.split(".").map(Number);
  return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
};

/** Where an IPv6 address carries an IPv4 one: its prefix, and how many bits stand before it. */
const EMBEDDINGS: readonly (readonly [(hextets: string) => string, number])[] = [
  [(hextets) => `::ffff:${hextets}`, 96], // IPv4-mapped
  [(hextets) => `::ffff:0:${hextets}`, 96], // IPv4-translated (SIIT)
  [(hextets) => `::${hextets}`, 96], // IPv4-compatible
  [(hextets) => `64:ff9b::${hextets}`, 96], // NAT64, the well-known prefix
  [(hextets) => `2002:${hextets}::`, 16], // 6to4
];

const BLOCKED = new BlockList();
for (const [network, prefix] of IPV4_BLOCKED) {
  BLOCKED.addSubnet(network, prefix, "ipv4");
  for (const [embed, before] of EMBEDDINGS)
    BLOCKED.addSubnet(embed(hextetsOf(network)), before + prefix, "ipv6");
}
for (const [network, prefix] of IPV6_BLOCKED) BLOCKED.addSubnet(network, prefix, "ipv6");

/** An address as checked: no brackets, no zone (`fe80::1%eth0`). */
const plainOf = (address: string): string => address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");

/** Whether a file is never fetched from `address` (an IP literal). */
export function isDeniedAddress(address: string): boolean {
  const plain = plainOf(address);
  const family = isIP(plain);
  if (family === 0) return true; // no address: never connected to
  return BLOCKED.check(plain, family === 4 ? "ipv4" : "ipv6");
}

/** Why a lookup refused: its error's code. */
export const ADDRESS_DENIED = "A2A_FILE_ADDRESS_DENIED";

/** An error a connection is refused with for its address, its `code` `ADDRESS_DENIED`. */
export const deniedError = (): NodeJS.ErrnoException =>
  Object.assign(new Error("the file's host resolves to an address it is never fetched from"), {
    code: ADDRESS_DENIED,
  });

/** How a name is resolved: `node:dns`'s `lookup` by default, a stub in tests. */
export type AddressLookup = (
  hostname: string,
  callback: (error: NodeJS.ErrnoException | null, addresses: readonly LookupAddress[]) => void,
) => void;

const systemLookup: AddressLookup = (hostname, callback) => {
  dnsLookup(hostname, { all: true }, (error, addresses) => {
    callback(error, addresses);
  });
};

/**
 * A `net` lookup that answers only an allowed address: every address the name resolves to is
 * checked, one denied fails the connection (a name with one private address among public ones is
 * refused, never raced). `answered` is told the addresses a successful lookup returned (#916: the
 * connection's peer is checked against them).
 */
export function guardedLookupOf(
  resolve: AddressLookup = systemLookup,
  answered?: (addresses: readonly string[]) => void,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, (error, addresses) => {
      if (error !== null) {
        callback(error, "", 4);
        return;
      }
      const [first] = addresses;
      if (first === undefined || addresses.some((found) => isDeniedAddress(found.address))) {
        callback(deniedError(), "", 4);
        return;
      }
      answered?.(addresses.map((found) => found.address));
      if (options.all === true) callback(null, [...addresses]);
      else callback(null, first.address, first.family);
    });
  };
}

/**
 * The addresses `hostname` resolves to, every one of them allowed (#916: the file transport makes
 * its own connection to one of them). Fails with `ADDRESS_DENIED` as the guarded lookup does.
 */
export function addressesOf(hostname: string, resolve?: AddressLookup): Promise<readonly string[]> {
  return new Promise((done, fail) => {
    guardedLookupOf(resolve)(hostname, { all: true }, (error, answered) => {
      if (error !== null) fail(error);
      else done(typeof answered === "string" ? [answered] : answered.map(({ address }) => address));
    });
  });
}
