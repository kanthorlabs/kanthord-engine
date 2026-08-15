import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSecretFile } from "./secret-file.ts";

const tempDirs: string[] = [];

const makeDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "kanthord-secret-file-"));
  tempDirs.push(directory);
  return directory;
};

after(() => {
  for (const directory of tempDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("src/cli/secret-file.test", () => {
  it("a first write creates the file with mode 0600", () => {
    const directory = makeDirectory();
    const path = join(directory, "token.txt");
    const sink = createSecretFile(path);

    sink.write("");

    assert.equal(existsSync(path), true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(path, "utf8"), "");
  });

  it("a second write replaces the content, truncating a longer first value", () => {
    const directory = makeDirectory();
    const path = join(directory, "token.txt");
    const sink = createSecretFile(path);

    sink.write("a".repeat(10));
    sink.write("b");

    assert.equal(readFileSync(path, "utf8"), "b");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  it("write on a path that already existed before the sink was built throws EEXIST", () => {
    const directory = makeDirectory();
    const path = join(directory, "token.txt");
    writeFileSync(path, "existing", "utf8");
    const sink = createSecretFile(path);

    assert.throws(
      () => sink.write(""),
      (error: unknown) => {
        assert.equal((error as NodeJS.ErrnoException).code, "EEXIST");
        return true;
      },
    );
    assert.equal(readFileSync(path, "utf8"), "existing");
  });

  it("discard removes the file", () => {
    const directory = makeDirectory();
    const path = join(directory, "token.txt");
    const sink = createSecretFile(path);

    sink.write("secret");
    sink.discard();

    assert.equal(existsSync(path), false);
  });

  it("discard on a missing path does not throw, and is idempotent", () => {
    const directory = makeDirectory();
    const path = join(directory, "token.txt");

    assert.doesNotThrow(() => createSecretFile(path).discard());

    const sink = createSecretFile(path);
    sink.write("");
    sink.discard();
    assert.doesNotThrow(() => sink.discard());
  });
});
