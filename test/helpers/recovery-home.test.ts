import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";

import { migrations } from "../../src/services/storage/migrations.ts";
import { SqliteStorage } from "../../src/services/storage/sqlite.ts";
import { createMockClock } from "./clock.ts";
import { createTemporaryHome } from "./home.ts";
import {
  FIXTURE_REPOSITORY_ID,
  seedFixtureRepository,
} from "./recovery-home.ts";

describe("test/helpers/recovery-home.test", () => {
  it("seedFixtureRepository inserts the fixture row into a migrated home and returns gitDir and lockPath", () => {
    const home = createTemporaryHome();
    try {
      const storage = new SqliteStorage({
        path: join(home.path, "kanthord.db"),
        clock: createMockClock({ start: 1700000000000 }),
        migrations,
      });
      storage.migrate();

      const seeded = seedFixtureRepository(home.path);
      assert.equal(seeded.gitDir, join(home.path, "repos", "fixture.git"));
      assert.equal(
        seeded.lockPath,
        join(home.path, "repos", "fixture.git", "refs", "heads", "main.lock"),
      );
      assert.ok(
        fs.existsSync(join(seeded.gitDir, "refs", "heads")),
        "refs/heads must exist for the lock to be planted into it",
      );

      const row = storage.transact((transaction) =>
        transaction.get("SELECT * FROM repository WHERE id = ?", [
          FIXTURE_REPOSITORY_ID,
        ]),
      ) as Readonly<Record<string, unknown>>;
      assert.equal(row.id, FIXTURE_REPOSITORY_ID);
      assert.equal(row.name, "fixture");
      assert.equal(row.home_path, seeded.gitDir);
      assert.equal(row.state, "ready");
      assert.equal(typeof row.credential_id, "string");

      const provider = storage.transact((transaction) =>
        transaction.get("SELECT id FROM provider WHERE id = ?", [
          row.credential_id,
        ]),
      );
      assert.ok(
        provider !== undefined,
        "the repository credential_id must reference a provider row",
      );
    } finally {
      home.dispose();
    }
  });
});
