export type OriginRefusalReason =
  | "wildcard"
  | "whitespace"
  | "scheme"
  | "path"
  | "query"
  | "fragment"
  | "credentials"
  | "unparsable";

export type OriginCanonicalization =
  | Readonly<{ ok: true; origin: string }>
  | Readonly<{ ok: false; reason: OriginRefusalReason }>;

const FORBIDDEN_SPACE = /[\s\u0000-\u001F\u007F]/;
const SCHEME = /^https?:\/\//;

export function canonicalizeOrigin(raw: string): OriginCanonicalization {
  if (raw.includes("*")) {
    return { ok: false, reason: "wildcard" };
  }
  if (FORBIDDEN_SPACE.test(raw)) {
    return { ok: false, reason: "whitespace" };
  }
  if (!SCHEME.test(raw)) {
    return { ok: false, reason: "scheme" };
  }

  const authority = raw.slice(raw.indexOf("://") + 3);
  for (const char of authority) {
    if (char === "/" || char === "\\") {
      return { ok: false, reason: "path" };
    }
    if (char === "?") {
      return { ok: false, reason: "query" };
    }
    if (char === "#") {
      return { ok: false, reason: "fragment" };
    }
  }

  if (authority.includes("@")) {
    return { ok: false, reason: "credentials" };
  }
  if (authority.length === 0) {
    return { ok: false, reason: "unparsable" };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "unparsable" };
  }

  if (url.origin === "null") {
    return { ok: false, reason: "unparsable" };
  }

  return { ok: true, origin: url.origin };
}
