const SCP_LIKE = /^([A-Za-z0-9._~+-]+)@([^:/@]+):(.+)$/;

export function remoteTransport(value: string): "http-basic" | "ssh" | null {
  if (SCP_LIKE.test(value)) {
    return "ssh";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === "https:" || url.protocol === "http:") {
    return "http-basic";
  }
  if (url.protocol === "ssh:") {
    return "ssh";
  }
  return null;
}
