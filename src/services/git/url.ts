import { isLoopbackHost } from "../../domain/loopback.ts";

import type { RemoteUrlVerdict } from "./index.ts";

const SCP_LIKE = /^([A-Za-z0-9._~+-]+)@([^:/@]+):(.+)$/;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function namesNoHost(value: string): boolean {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd === -1) {
    return false;
  }
  const rest = value.slice(schemeEnd + 3);
  return (
    rest === "" ||
    rest.startsWith("/") ||
    rest.startsWith("?") ||
    rest.startsWith("#")
  );
}

function optionLikeRefusal(
  host: string,
  path: string,
): RemoteUrlVerdict | null {
  if (host.startsWith("-")) {
    return {
      allowed: false,
      refusal: "option-like",
      reason: "the host begins with a hyphen",
    };
  }
  const strippedPath = path.startsWith("/") ? path.slice(1) : path;
  if (strippedPath.startsWith("-")) {
    return {
      allowed: false,
      refusal: "option-like",
      reason: "the path begins with a hyphen",
    };
  }
  return null;
}

export function remoteUrlVerdict(remoteUrl: string): RemoteUrlVerdict {
  if (hasControlCharacter(remoteUrl)) {
    return {
      allowed: false,
      refusal: "control-character",
      reason: "the url carries a control character",
    };
  }

  const scpLike = SCP_LIKE.exec(remoteUrl);
  if (scpLike !== null) {
    const host = scpLike[2]!;
    const path = scpLike[3]!;
    const optionLike = optionLikeRefusal(host, path);
    if (optionLike !== null) {
      return optionLike;
    }
    return { allowed: true, transport: "ssh", host };
  }

  let url: URL;
  try {
    url = new URL(remoteUrl);
  } catch {
    return {
      allowed: false,
      refusal: "malformed",
      reason: "the url does not parse",
    };
  }

  let transport: "http-basic" | "ssh";
  const protocol = url.protocol;
  if (protocol === "https:") {
    transport = "http-basic";
  } else if (protocol === "http:") {
    transport = "http-basic";
  } else if (protocol === "ssh:") {
    transport = "ssh";
  } else {
    return {
      allowed: false,
      refusal: "scheme-not-allowed",
      reason: `the scheme ${protocol.slice(0, -1)} is not allowed`,
    };
  }

  const host = url.hostname;
  const path = url.pathname;

  if (namesNoHost(remoteUrl)) {
    return {
      allowed: false,
      refusal: "malformed",
      reason: "the url names no host",
    };
  }

  if (url.password !== "") {
    return {
      allowed: false,
      refusal: "password-in-url",
      reason: "the url carries a password; store the secret in a credential",
    };
  }

  const optionLike = optionLikeRefusal(host, path);
  if (optionLike !== null) {
    return optionLike;
  }

  if (
    protocol === "http:" &&
    !isLoopbackHost(host.replace(/^\[/, "").replace(/\]$/, ""))
  ) {
    return {
      allowed: false,
      refusal: "insecure-non-loopback",
      reason: "plain HTTP is allowed only on a loopback host",
    };
  }

  return { allowed: true, transport, host };
}
