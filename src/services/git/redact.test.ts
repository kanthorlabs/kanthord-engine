import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { stripUserinfo } from "./redact.ts";

describe("src/services/git/redact.test", () => {
  it("strips userinfo from an https diagnostic", () => {
    assert.equal(
      stripUserinfo(
        "fatal: unable to access 'https://user:tok@forge.test/r.git/'",
      ),
      "fatal: unable to access 'https://forge.test/r.git/'",
    );
  });

  it("strips the username from an ssh url", () => {
    assert.equal(
      stripUserinfo("ssh://git@forge.test/r.git"),
      "ssh://forge.test/r.git",
    );
  });

  it("strips a percent-encoded userinfo", () => {
    assert.equal(
      stripUserinfo("https://u%40x:t@forge.test/r"),
      "https://forge.test/r",
    );
  });

  it("strips both urls in one string", () => {
    assert.equal(
      stripUserinfo("a https://u1:p1@h/x and https://u2:p2@h/y b"),
      "a https://h/x and https://h/y b",
    );
  });

  it("leaves a url-free string unchanged", () => {
    assert.equal(stripUserinfo("no url here"), "no url here");
  });

  it("leaves the scp spelling unchanged", () => {
    assert.equal(
      stripUserinfo("git@forge.test:o/r.git"),
      "git@forge.test:o/r.git",
    );
  });
});
