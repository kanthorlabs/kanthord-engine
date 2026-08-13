import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { launchDaemon, killAll } from "../../../test/helpers/daemon.ts";
import { createTemporaryHome } from "../../../test/helpers/home.ts";
import { reservePort } from "../../../test/helpers/port.ts";

describe("src/services/config/startup.test", () => {
  it("the daemon with no masterKey and no masterKeyFile refuses before it listens and leaves no identity lock", async () => {
    const home = createTemporaryHome();
    after(async () => {
      await killAll();
      home.dispose();
    });

    const port = await reservePort();
    const configPath = home.writeConfig({
      masterKey: undefined,
      masterKeyFile: undefined,
      http: { port },
    });
    const proc = launchDaemon({ configPath, home: home.path });
    const exit = await proc.exited();
    assert.equal(exit.code, 1);
    assert.equal(proc.stdout(), "");
    assert.match(proc.stderr(), /^kanthord: config-refused:/);
    assert.equal(
      fs.existsSync(path.join(home.path, "daemon.lock.identity")),
      false,
      "the refusal must happen before the home lock publishes its identity",
    );
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/v1/health`),
      (error: unknown) =>
        (error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED",
    );
  });
});
