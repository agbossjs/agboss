import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * The addresses a file by `url` is never fetched from (#859, SSRF): loopback, private, link-local,
 * carrier-grade NAT, "this network", unique-local and the IPv4 ones mapped into IPv6 — checked on
 * the address the connection is made to (the lookup's answer, an IP literal as it is), so a name
 * that resolves to one, or a redirect to one, is refused as well.
 */
const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  BLOCKED.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  BLOCKED.addSubnet(network, prefix, "ipv6");

/** `::ffff:127.0.0.1` → `127.0.0.1`; any other address as it is. */
const unmappedOf = (address: string): string => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped?.[1] ?? address;
};

/** Whether a file is never fetched from `address` (an IP literal). */
export function isDeniedAddress(address: string): boolean {
  const plain = unmappedOf(address.replace(/^\[|\]$/g, ""));
  const family = isIP(plain);
  if (family === 0) return true; // no address: never connected to
  return BLOCKED.check(plain, family === 4 ? "ipv4" : "ipv6");
}

/** Why a lookup refused: its error's code. */
export const ADDRESS_DENIED = "A2A_FILE_ADDRESS_DENIED";

/** An error a guarded lookup fails with, its `code` `ADDRESS_DENIED`. */
const deniedError = (): NodeJS.ErrnoException =>
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
 * refused, never raced).
 */
export function guardedLookupOf(resolve: AddressLookup = systemLookup): LookupFunction {
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
      if (options.all === true) callback(null, [...addresses]);
      else callback(null, first.address, first.family);
    });
  };
}
