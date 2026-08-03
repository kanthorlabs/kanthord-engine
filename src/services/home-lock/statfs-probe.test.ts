import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NETWORK_FILESYSTEM_MAGICS, StatfsProbe } from "./statfs-probe.ts";

describe("src/services/home-lock/statfs-probe.test", () => {
  it("NETWORK_FILESYSTEM_MAGICS deep-equals the ten expected values in order", () => {
    assert.deepEqual(
      NETWORK_FILESYSTEM_MAGICS,
      [
        0x6969, 0xff534d42, 0xfe534d42, 0x65735546, 0x01021997, 0x00c36400,
        0x0bd00bd0, 0x5346414f, 0x01161970, 0x7461636f,
      ],
    );
  });

  for (const magic of NETWORK_FILESYSTEM_MAGICS) {
    it(`platform "linux" with statfs returning 0x${magic.toString(16)} gives "network"`, () => {
      const probe = new StatfsProbe({
        platform: "linux",
        statfs: () => ({ type: magic }),
      });
      assert.equal(probe.classify("/some/path"), "network");
    });
  }

  it('platform "linux" with 0xef53 (ext4) gives "local"', () => {
    const probe = new StatfsProbe({
      platform: "linux",
      statfs: () => ({ type: 0xef53 }),
    });
    assert.equal(probe.classify("/some/path"), "local");
  });

  it('platform "linux" with 0x01021994 (tmpfs) gives "local"', () => {
    const probe = new StatfsProbe({
      platform: "linux",
      statfs: () => ({ type: 0x01021994 }),
    });
    assert.equal(probe.classify("/some/path"), "local");
  });

  it('platform "darwin" gives "unknown" and statfs is never called', () => {
    let callCount = 0;
    const probe = new StatfsProbe({
      platform: "darwin",
      statfs: () => {
        callCount++;
        return { type: 0 };
      },
    });
    assert.equal(probe.classify("/some/path"), "unknown");
    assert.equal(callCount, 0);
  });

  it('platform "win32" gives "unknown"', () => {
    let callCount = 0;
    const probe = new StatfsProbe({
      platform: "win32",
      statfs: () => {
        callCount++;
        return { type: 0 };
      },
    });
    assert.equal(probe.classify("/some/path"), "unknown");
    assert.equal(callCount, 0);
  });

  it('platform "linux" with statfs that throws propagates the throw', () => {
    const boom = new Error("EACCES");
    const probe = new StatfsProbe({
      platform: "linux",
      statfs: () => {
        throw boom;
      },
    });
    assert.throws(
      () => probe.classify("/some/path"),
      (err: unknown) => err === boom,
    );
  });
});
