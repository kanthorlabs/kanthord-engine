import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { remoteTransport } from "./transport.ts";

describe("src/cli/repository/transport.test", () => {
  it("https and http urls yield http-basic", () => {
    assert.equal(remoteTransport("https://github.com/o/r.git"), "http-basic");
    assert.equal(remoteTransport("http://127.0.0.1:9/r.git"), "http-basic");
  });

  it("an ssh scheme and the scp-like spelling yield ssh", () => {
    assert.equal(remoteTransport("ssh://git@github.com/o/r.git"), "ssh");
    assert.equal(remoteTransport("git@github.com:o/r.git"), "ssh");
  });

  it("other schemes, a non-url and an empty string yield null", () => {
    assert.equal(remoteTransport("file:///tmp/r.git"), null);
    assert.equal(remoteTransport("rsync://h/r"), null);
    assert.equal(remoteTransport("not a url"), null);
    assert.equal(remoteTransport(""), null);
  });

  it("a user@host with no colon path yields null", () => {
    assert.equal(remoteTransport("git@github.com"), null);
  });
});
