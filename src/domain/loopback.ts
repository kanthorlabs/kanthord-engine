export const LOOPBACK_IPV4 = "127.0.0.1";
export const LOOPBACK_HOSTNAME = "localhost";

const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidOctet(segment: string): boolean {
  if (segment.length === 0) return false;
  if (segment.length > 1 && segment[0] === "0") return false;
  const n = Number(segment);
  return n >= 0 && n <= 255;
}

export function isLoopbackHost(host: string): boolean {
  if (host === LOOPBACK_HOSTNAME) return true;
  if (host === "::1") return true;

  const m = IPV4_LOOPBACK.exec(host);
  if (m === null) return false;
  return isValidOctet(m[1]!) && isValidOctet(m[2]!) && isValidOctet(m[3]!);
}

export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }
  let hostname = url.hostname;
  if (hostname.startsWith("[")) {
    hostname = hostname.slice(1);
  }
  if (hostname.endsWith("]")) {
    hostname = hostname.slice(0, -1);
  }
  return isLoopbackHost(hostname);
}
