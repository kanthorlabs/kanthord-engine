import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import {
  fixtureObjectIds,
  pinnedGitConfigArguments,
  pinnedGitEnvironment,
  seedRepositories,
} from "./seed.ts";
import { resolveTools, toolTimeoutMilliseconds } from "./tools.ts";

const spawnGuard = {
  timeout: toolTimeoutMilliseconds,
  killSignal: "SIGKILL" as const,
  maxBuffer: 8 * 1024 * 1024,
};

describe("test/helpers/remote/seed.test", () => {
  const tools = resolveTools({});

  it("seeds a fixture whose refs/heads/main equals the commit2 literal", () => {
    const root = seedRepositories(tools);
    try {
      assert.equal(
        root.git("fixture.git", ["rev-parse", "refs/heads/main"]),
        fixtureObjectIds.commit2,
      );
    } finally {
      root.dispose();
    }
  });

  it("reports head and refs as the exact fixture record", () => {
    const root = seedRepositories(tools);
    try {
      const repository = root.repositories["fixture.git"];
      assert.ok(repository !== undefined);
      assert.equal(repository.head, fixtureObjectIds.commit2);
      assert.deepEqual(repository.refs, {
        "refs/heads/main": fixtureObjectIds.commit2,
        "refs/tags/v1": fixtureObjectIds.tagV1,
      });
    } finally {
      root.dispose();
    }
  });

  it("reports every object id with its exact git type", () => {
    const root = seedRepositories(tools);
    try {
      const expectedTypes: Readonly<Record<string, string>> = {
        blob1: "blob",
        tree1: "tree",
        commit1: "commit",
        blob2: "blob",
        tree2: "tree",
        commit2: "commit",
        tagV1: "tag",
      };
      for (const [key, type] of Object.entries(expectedTypes)) {
        const id = fixtureObjectIds[key];
        assert.ok(id !== undefined);
        assert.equal(root.git("fixture.git", ["cat-file", "-t", id]), type);
      }
    } finally {
      root.dispose();
    }
  });

  it("stores the first blob bytes exactly, trailing newline included", () => {
    const root = seedRepositories(tools);
    try {
      const blob1 = fixtureObjectIds.blob1;
      assert.ok(blob1 !== undefined);
      const bytes = execFileSync(
        tools.paths.git,
        [
          ...pinnedGitConfigArguments,
          "-C",
          join(root.path, "fixture.git"),
          "cat-file",
          "blob",
          blob1,
        ],
        {
          env: { ...pinnedGitEnvironment, PATH: tools.execPath },
          encoding: "utf8",
          ...spawnGuard,
        },
      );
      assert.equal(bytes, "kanthord fixture\n");
    } finally {
      root.dispose();
    }
  });

  it("pins the parent edge of commit2 to commit1", () => {
    const root = seedRepositories(tools);
    try {
      assert.equal(
        root.git("fixture.git", ["rev-parse", `${fixtureObjectIds.commit2}^`]),
        fixtureObjectIds.commit1,
      );
    } finally {
      root.dispose();
    }
  });

  it("resolves HEAD symbolically to refs/heads/main", () => {
    const root = seedRepositories(tools);
    try {
      assert.equal(
        root.git("fixture.git", ["symbolic-ref", "HEAD"]),
        "refs/heads/main",
      );
    } finally {
      root.dispose();
    }
  });

  it("lists refs in canonical order, main before the tag", () => {
    const root = seedRepositories(tools);
    try {
      const refs = root
        .git("fixture.git", ["for-each-ref", "--format=%(refname)"])
        .split("\n");
      assert.deepEqual(refs, ["refs/heads/main", "refs/tags/v1"]);
    } finally {
      root.dispose();
    }
  });

  it("reproduces identical refs from a second seed in a different directory", () => {
    const first = seedRepositories(tools);
    try {
      const second = seedRepositories(tools);
      try {
        assert.notEqual(first.path, second.path);
        const secondRepository = second.repositories["fixture.git"];
        const firstRepository = first.repositories["fixture.git"];
        assert.ok(secondRepository !== undefined);
        assert.ok(firstRepository !== undefined);
        assert.deepEqual(secondRepository.refs, firstRepository.refs);
      } finally {
        second.dispose();
      }
    } finally {
      first.dispose();
    }
  });

  it("keeps GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_COUNT, GIT_DEFAULT_HASH and GIT_TRACE keys out of the pinned environment", () => {
    const keys = Object.keys(pinnedGitEnvironment);
    for (const forbidden of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_CONFIG_COUNT",
      "GIT_DEFAULT_HASH",
    ]) {
      assert.equal(keys.includes(forbidden), false);
    }
    assert.equal(
      keys.some((key) => /^GIT_TRACE/.test(key)),
      false,
    );
  });

  it("seeds the seven sha1 literals even when GIT_DEFAULT_HASH=sha256 is injected", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "kanthord-remote-"));
    try {
      const repositoryPath = join(dir, "fixture.git");
      const environment = {
        ...pinnedGitEnvironment,
        PATH: tools.execPath,
        GIT_DEFAULT_HASH: "sha256",
      };
      execFileSync(
        tools.paths.git,
        [
          ...pinnedGitConfigArguments,
          "init",
          "--bare",
          "--quiet",
          "--template=",
          "--initial-branch=main",
          "--object-format=sha1",
          repositoryPath,
        ],
        {
          env: environment,
          encoding: "utf8",
          ...spawnGuard,
        },
      );
      const run = (args: readonly string[], input?: string): string =>
        execFileSync(
          tools.paths.git,
          [...pinnedGitConfigArguments, "-C", repositoryPath, ...args],
          {
            env: environment,
            encoding: "utf8",
            input,
            ...spawnGuard,
          },
        ).trim();

      const blob1 = run(["hash-object", "-w", "--stdin"], "kanthord fixture\n");
      const tree1 = run(["mktree"], `100644 blob ${blob1}\tREADME.md\n`);
      const commit1 = run(["commit-tree", tree1, "-m", "fixture: initial"]);
      const blob2 = run(
        ["hash-object", "-w", "--stdin"],
        "kanthord fixture second\n",
      );
      const tree2 = run(["mktree"], `100644 blob ${blob2}\tREADME.md\n`);
      const commit2 = run([
        "commit-tree",
        tree2,
        "-p",
        commit1,
        "-m",
        "fixture: second",
      ]);
      run(["update-ref", "refs/heads/main", commit2]);
      run(["symbolic-ref", "HEAD", "refs/heads/main"]);
      const tagV1 = run(
        ["mktag"],
        [
          `object ${commit2}`,
          "type commit",
          "tag v1",
          "tagger Kanthord Fixture <fixture@kanthord.invalid> 1700000000 +0000",
          "",
          "fixture tag",
          "",
        ].join("\n"),
      );
      run(["update-ref", "refs/tags/v1", tagV1]);

      assert.equal(blob1, fixtureObjectIds.blob1);
      assert.equal(tree1, fixtureObjectIds.tree1);
      assert.equal(commit1, fixtureObjectIds.commit1);
      assert.equal(blob2, fixtureObjectIds.blob2);
      assert.equal(tree2, fixtureObjectIds.tree2);
      assert.equal(commit2, fixtureObjectIds.commit2);
      assert.equal(tagV1, fixtureObjectIds.tagV1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps every fixture object id a 40-hex sha1 literal", () => {
    for (const id of Object.values(fixtureObjectIds)) {
      assert.match(id, /^[0-9a-f]{40}$/);
    }
  });

  it("ignores a hostile HOME .gitconfig while the pin holds and reads it when the pin drops", () => {
    const hostileHome = fs.mkdtempSync(join(os.tmpdir(), "kanthord-home-"));
    try {
      fs.writeFileSync(
        join(hostileHome, ".gitconfig"),
        "[core]\n\tautocrlf = true\n",
      );
      assert.throws(() =>
        execFileSync(tools.paths.git, ["config", "--get", "core.autocrlf"], {
          env: {
            ...pinnedGitEnvironment,
            PATH: tools.execPath,
            HOME: hostileHome,
          },
          encoding: "utf8",
          ...spawnGuard,
        }),
      );
      const { GIT_CONFIG_GLOBAL: _dropped, ...withoutGlobalPin } =
        pinnedGitEnvironment;
      const unpinned = execFileSync(
        tools.paths.git,
        ["config", "--get", "core.autocrlf"],
        {
          env: {
            ...withoutGlobalPin,
            PATH: tools.execPath,
            HOME: hostileHome,
          },
          encoding: "utf8",
          ...spawnGuard,
        },
      );
      assert.equal(unpinned.trim(), "true");
    } finally {
      fs.rmSync(hostileHome, { recursive: true, force: true });
    }
  });

  it("dispose removes the root and tolerates a second call", () => {
    const root = seedRepositories(tools);
    root.dispose();
    assert.equal(fs.existsSync(root.path), false);
    root.dispose();
  });

  it("disposes its temporary root when a git plumbing command fails", async () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "kanthord-seed-leak-"));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const marker = ".kanthord-seed-marker";
    const stub = join(dir, "git");
    fs.writeFileSync(
      stub,
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "hash-object" ]; then exit 1; fi; done\ncase "$*" in\n  *" init "*) ${tools.paths.git} "$@"; last=""; for a in "$@"; do last="$a"; done; /usr/bin/touch "$last/.kanthord-seed-marker" 2>/dev/null; exit 0 ;;\nesac\nexec ${tools.paths.git} "$@"\n`,
      { mode: 0o755 },
    );
    const failingTools = { ...tools, paths: { ...tools.paths, git: stub } };

    const markerPresent = (): boolean => {
      for (const entry of fs.readdirSync(os.tmpdir())) {
        if (!entry.startsWith("kanthord-remote-")) {
          continue;
        }
        if (fs.existsSync(join(os.tmpdir(), entry, "fixture.git", marker))) {
          return true;
        }
      }
      return false;
    };
    after(() => {
      for (const entry of fs.readdirSync(os.tmpdir())) {
        if (!entry.startsWith("kanthord-remote-")) {
          continue;
        }
        const root = join(os.tmpdir(), entry);
        if (fs.existsSync(join(root, "fixture.git", marker))) {
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    });

    assert.throws(() => seedRepositories(failingTools));

    const deadline = Date.now() + 2000;
    while (markerPresent() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(markerPresent(), false);
  });
});
