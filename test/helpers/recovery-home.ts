import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export const FIXTURE_REPOSITORY_ID = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const FIXTURE_PROVIDER_ID = "provider_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const FIXTURE_UPDATED_AT = 1700000000000;

export function seedFixtureRepository(
  homePath: string,
): Readonly<{ gitDir: string; lockPath: string }> {
  const gitDir = join(homePath, "repos", "fixture.git");
  const lockPath = join(gitDir, "refs", "heads", "main.lock");
  const database = new DatabaseSync(join(homePath, "kanthord.db"));
  try {
    database.exec("BEGIN");
    database
      .prepare(
        "INSERT INTO provider (id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        FIXTURE_PROVIDER_ID,
        "fixture",
        "git",
        null,
        new Uint8Array([1]),
        new Uint8Array(12),
        new Uint8Array(16),
        1,
        FIXTURE_UPDATED_AT,
      );
    database
      .prepare(
        "INSERT INTO repository (id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        FIXTURE_REPOSITORY_ID,
        "fixture",
        "https://example.invalid/fixture.git",
        FIXTURE_PROVIDER_ID,
        gitDir,
        "main",
        "kanthord/landing",
        "refs/heads/kanthord/publish",
        0,
        "ready",
        null,
        null,
        null,
        FIXTURE_UPDATED_AT,
      );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  fs.mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
  return { gitDir, lockPath };
}
