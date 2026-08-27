import { readdir, readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

const IMPORT_DECLARATION =
  /^\s*import\s+(?:type\s+)?[^;]*?\sfrom\s+["'][^"']+["'];/gms;

const SOCKET_HELPER_NAME =
  /\b(?:loopbackAgent|loopbackServer|createSocketTestApp)\b/;

async function socketFiles(root: string): Promise<readonly string[]> {
  const matches: string[] = [];
  for (const directory of ["src", "test"]) {
    const entries = await readdir(path.join(root, directory), {
      recursive: true,
    });
    for (const entry of entries) {
      if (!entry.endsWith(".test.ts")) continue;
      const source = await readFile(path.join(root, directory, entry), "utf8");
      let named = false;
      for (const declaration of source.matchAll(IMPORT_DECLARATION)) {
        if (SOCKET_HELPER_NAME.test(declaration[0])) {
          named = true;
          break;
        }
      }
      if (named)
        matches.push([directory, entry].join("/").replaceAll("\\", "/"));
    }
  }
  return matches.sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
}

describe("test/helpers/socket-budget.test counts files that reach test/helpers/agent.ts", () => {
  it("keeps the socket file count at seven", async () => {
    const files = await socketFiles(repositoryRoot);

    assert.equal(files.length, 7);
  });

  it("keeps the exact level-2 allow list", async () => {
    const files = await socketFiles(repositoryRoot);

    assert.deepEqual(files, [
      "src/http/server/app.handler-result.test.ts",
      "src/http/server/app.test.ts",
      "src/http/server/blob/show-blob.test.ts",
      "src/http/server/host.test.ts",
      "src/http/server/idempotency.test.ts",
      "src/http/server/shutdown-socket.test.ts",
      "test/helpers/agent.test.ts",
    ]);
  });
});
