import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { RemoteUrlVerdict, UrlRefusal } from "./index.ts";
import { remoteUrlVerdict } from "./url.ts";

const accepted = [
  ["https://forge.test/o/r.git", "http-basic", "forge.test"],
  ["https://user@forge.test/r.git", "http-basic", "forge.test"],
  ["http://127.0.0.1:7999/r.git", "http-basic", "127.0.0.1"],
  ["http://localhost/r.git", "http-basic", "localhost"],
  ["http://[::1]:7999/r.git", "http-basic", "[::1]"],
  ["ssh://git@forge.test/o/r.git", "ssh", "forge.test"],
  ["ssh://git@forge.test:2222/r", "ssh", "forge.test"],
  ["git@forge.test:o/r.git", "ssh", "forge.test"],
  ["git@forge.test:/abs/r.git", "ssh", "forge.test"],
] as const;

const refused = [
  [
    "https://user:secret@forge.test/r.git",
    "password-in-url",
    "the url carries a password; store the secret in a credential",
  ],
  [
    "http://forge.test/r.git",
    "insecure-non-loopback",
    "plain HTTP is allowed only on a loopback host",
  ],
  [
    "http://127.0.0.1.evil.test/r.git",
    "insecure-non-loopback",
    "plain HTTP is allowed only on a loopback host",
  ],
  [
    "git://forge.test/r.git",
    "scheme-not-allowed",
    "the scheme git is not allowed",
  ],
  ["file:///srv/r.git", "scheme-not-allowed", "the scheme file is not allowed"],
  ["ext::sh -c whoami", "scheme-not-allowed", "the scheme ext is not allowed"],
  ["https://-forge.test/r.git", "option-like", "the host begins with a hyphen"],
  [
    "https://forge.test/-upload-pack.git",
    "option-like",
    "the path begins with a hyphen",
  ],
  ["git@-forge.test:r.git", "option-like", "the host begins with a hyphen"],
  ["git@forge.test:-r.git", "option-like", "the path begins with a hyphen"],
  [
    "https://forge.test/r\n.git",
    "control-character",
    "the url carries a control character",
  ],
  [
    "https://forge.test/r\t.git",
    "control-character",
    "the url carries a control character",
  ],
  [
    "ssh://git@forge.test/r\u007f.git",
    "control-character",
    "the url carries a control character",
  ],
  ["not a url at all", "malformed", "the url does not parse"],
  ["https://", "malformed", "the url does not parse"],
  ["https:///r.git", "malformed", "the url names no host"],
] as const;

const unionMembers = [
  "malformed",
  "scheme-not-allowed",
  "insecure-non-loopback",
  "password-in-url",
  "option-like",
  "control-character",
] as const satisfies readonly UrlRefusal[];

describe("src/services/git/url.test", () => {
  it("accepts the documented url table with its exact transport and host", () => {
    for (const [url, transport, host] of accepted) {
      assert.deepEqual(
        remoteUrlVerdict(url),
        { allowed: true, transport, host },
        url,
      );
    }
  });

  it("refuses each documented url by refusal and by exact reason", () => {
    for (const [url, refusal, reason] of refused) {
      const verdict = remoteUrlVerdict(url);
      assert.equal(verdict.allowed, false, url);
      if (verdict.allowed) continue;
      assert.equal(verdict.refusal, refusal, url);
      assert.equal(verdict.reason, reason, url);
    }
  });

  it("every UrlRefusal member appears in the refusal table", () => {
    const refusals = refused.map(([url]) => {
      const verdict = remoteUrlVerdict(url);
      if (verdict.allowed) {
        assert.fail(`expected a refusal for ${url}`);
      }
      return verdict.refusal;
    });
    const collected = [...new Set(refusals)].sort();
    assert.deepEqual(collected, [...unionMembers].sort());
  });

  it("the control-character scan precedes the password check", () => {
    const verdict = remoteUrlVerdict("https://user:secret@forge.test/r\n.git");
    assert.equal(verdict.allowed, false);
    if (!verdict.allowed) {
      assert.equal(verdict.refusal, "control-character");
    }
  });

  it("the password check precedes the loopback check", () => {
    const verdict = remoteUrlVerdict("http://user:secret@forge.test/r.git");
    assert.equal(verdict.allowed, false);
    if (!verdict.allowed) {
      assert.equal(verdict.refusal, "password-in-url");
    }
  });

  it("the option-like check precedes the loopback check", () => {
    const verdict = remoteUrlVerdict("http://-forge.test/r.git");
    assert.equal(verdict.allowed, false);
    if (!verdict.allowed) {
      assert.equal(verdict.refusal, "option-like");
    }
  });

  it("does not refuse a percent-encoded leading hyphen or a query string", () => {
    assert.equal(remoteUrlVerdict("https://forge.test/%2Dx.git").allowed, true);
    assert.equal(
      remoteUrlVerdict("https://forge.test/r.git?ref=main").allowed,
      true,
    );
  });

  it("treats a space as not a control character", () => {
    assert.equal(remoteUrlVerdict("https://forge.test/r .git").allowed, true);
  });

  it("src/services/git/url.ts carries no loopback literal, node: import or decoder", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "./url.ts"),
      "utf-8",
    );
    assert.equal(source.includes("127."), false);
    assert.equal(source.includes("localhost"), false);
    assert.equal(source.includes("node:"), false);
    assert.equal(source.includes("decodeURIComponent"), false);
  });
});
