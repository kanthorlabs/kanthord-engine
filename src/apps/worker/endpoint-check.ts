import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Diagnostic } from "../../kernel/errors.ts";

const HTTP_PROTOCOL = "http:";
const IPV4 = 4;
const IPV6 = 6;
const IPV4_FAMILY = "ipv4";
const IPV6_FAMILY = "ipv6";
const IPV6_BRACKETS = /^\[|\]$/g;

const PRIVATE_ADDRESSES = new BlockList();
PRIVATE_ADDRESSES.addSubnet("127.0.0.0", 8, IPV4_FAMILY);
PRIVATE_ADDRESSES.addSubnet("10.0.0.0", 8, IPV4_FAMILY);
PRIVATE_ADDRESSES.addSubnet("172.16.0.0", 12, IPV4_FAMILY);
PRIVATE_ADDRESSES.addSubnet("192.168.0.0", 16, IPV4_FAMILY);
PRIVATE_ADDRESSES.addSubnet("100.64.0.0", 10, IPV4_FAMILY);
PRIVATE_ADDRESSES.addAddress("::1", IPV6_FAMILY);
PRIVATE_ADDRESSES.addSubnet("fc00::", 7, IPV6_FAMILY);
PRIVATE_ADDRESSES.addSubnet("fe80::", 10, IPV6_FAMILY);

export type AddressLookup = (
  host: string,
) => Promise<{ address: string; family: number }[]>;

const systemLookup: AddressLookup = (host) => dnsLookup(host, { all: true });

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === IPV4) return PRIVATE_ADDRESSES.check(address, IPV4_FAMILY);
  if (family !== IPV6) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  return mapped
    ? PRIVATE_ADDRESSES.check(mapped, IPV4_FAMILY)
    : PRIVATE_ADDRESSES.check(address, IPV6_FAMILY);
}

export async function refuseInsecureEndpoint(
  endpoint: string,
  lookup: AddressLookup = systemLookup,
): Promise<void> {
  const url = new URL(endpoint);
  if (url.protocol !== HTTP_PROTOCOL) return;
  const host = url.hostname.replace(IPV6_BRACKETS, "");
  let addresses: string[];
  try {
    addresses = isIP(host)
      ? [host]
      : (await lookup(host)).map((entry) => entry.address);
  } catch {
    addresses = [];
  }
  if (addresses.length && addresses.every(isPrivateAddress)) return;
  throw new Diagnostic(
    "worker.start.endpoint_insecure",
    "worker: an http endpoint must resolve to a private address. Use https for any other host.",
    { fields: [["host", host]] },
  );
}
