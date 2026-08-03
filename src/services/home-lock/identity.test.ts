import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderIdentity, parseIdentity } from "./identity.ts";
import type { HomeIdentity } from "./index.ts";

const sample: HomeIdentity = {
  version: 1,
  pid: 16801,
  host: "devbox",
  startedAt: "2026-08-03T10:00:00.000Z",
  instanceId: "01JQ8Z4A2B",
};

describe("src/services/home-lock/identity.test", () => {
  it("renderIdentity exact byte-for-byte match with trailing newline", () => {
    const expected = [
      "{",
      '  "version": 1,',
      '  "pid": 16801,',
      '  "host": "devbox",',
      '  "startedAt": "2026-08-03T10:00:00.000Z",',
      '  "instanceId": "01JQ8Z4A2B"',
      "}",
      "",
    ].join("\n");
    assert.equal(renderIdentity(sample), expected);
  });

  it("different key order renders same bytes", () => {
    const shuffled: HomeIdentity = {
      instanceId: "01JQ8Z4A2B",
      host: "devbox",
      pid: 16801,
      startedAt: "2026-08-03T10:00:00.000Z",
      version: 1,
    };
    assert.equal(renderIdentity(shuffled), renderIdentity(sample));
  });

  it("parseIdentity(renderIdentity(x)) deep-equals x", () => {
    assert.deepEqual(parseIdentity(renderIdentity(sample)), sample);
  });

  for (const [label, input] of [
    ["empty string", ""],
    ["open brace only", "{"],
    ["empty object", "{}"],
    [
      "truncated prefix",
      '{\n  "version": 1,\n  "pid": 16801,\n  "host": "devbox"',
    ],
    [
      "version: 2",
      JSON.stringify({
        version: 2,
        pid: 16801,
        host: "devbox",
        startedAt: "2026-08-03T10:00:00.000Z",
        instanceId: "01JQ8Z4A2B",
      }),
    ],
    [
      "pid is string",
      JSON.stringify({
        version: 1,
        pid: "16801",
        host: "devbox",
        startedAt: "2026-08-03T10:00:00.000Z",
        instanceId: "01JQ8Z4A2B",
      }),
    ],
    [
      "host is empty",
      JSON.stringify({
        version: 1,
        pid: 16801,
        host: "",
        startedAt: "2026-08-03T10:00:00.000Z",
        instanceId: "01JQ8Z4A2B",
      }),
    ],
  ] as const) {
    it(`parseIdentity returns null for ${label}`, () => {
      assert.equal(parseIdentity(input), null);
    });
  }
});
