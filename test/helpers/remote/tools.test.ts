import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { isAbsolute, join } from "node:path";
import { minimumGitVersion, resolveTools, ToolError } from "./tools.ts";

describe("test/helpers/remote/tools.test", () => {
  it("resolves the five documented default paths when no override is passed", () => {
    const tools = resolveTools({});
    assert.equal(tools.paths.git, "/usr/bin/git");
    assert.equal(tools.paths.ssh, "/usr/bin/ssh");
    assert.equal(tools.paths.sshd, "/usr/sbin/sshd");
    assert.equal(tools.paths.sshKeyscan, "/usr/bin/ssh-keyscan");
    assert.equal(tools.paths.sshKeygen, "/usr/bin/ssh-keygen");
  });

  it("pins the five tool names as the complete path key set", () => {
    const tools = resolveTools({});
    assert.deepEqual(Object.keys(tools.paths), [
      "git",
      "ssh",
      "sshd",
      "sshKeyscan",
      "sshKeygen",
    ]);
  });

  it("reads an override path and keeps the other defaults", () => {
    const tools = resolveTools({ KANTHORD_TEST_GIT: "/usr/bin/git" });
    assert.equal(tools.paths.git, "/usr/bin/git");
  });

  it("records gitVersion as a bare major.minor.patch triple", () => {
    const tools = resolveTools({});
    assert.match(tools.gitVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(tools.gitVersion.includes(" "), false);
    assert.equal(tools.gitVersion.includes("("), false);
  });

  it("records sshVersion as the version without the OpenSSH_ prefix", () => {
    const tools = resolveTools({});
    assert.match(tools.sshVersion, /^\d+\.\d+/);
    assert.equal(tools.sshVersion.startsWith("OpenSSH_"), false);
  });

  it("resolves execPath absolutely and httpBackend as a file", () => {
    const tools = resolveTools({});
    assert.equal(isAbsolute(tools.execPath), true);
    assert.equal(fs.statSync(tools.httpBackend).isFile(), true);
  });

  it("throws ToolError naming the tool and its variable for a missing path", () => {
    assert.throws(
      () => resolveTools({ KANTHORD_TEST_SSHD: "/nonexistent/sshd" }),
      (error: unknown) => {
        if (!(error instanceof ToolError)) return false;
        assert.equal(error.tool, "sshd");
        assert.match(error.message, /\/nonexistent\/sshd/);
        assert.match(error.message, /KANTHORD_TEST_SSHD/);
        return true;
      },
    );
  });

  it("refuses a non-absolute configured path with is not absolute", () => {
    assert.throws(
      () => resolveTools({ KANTHORD_TEST_GIT: "relative/git" }),
      (error: unknown) => {
        if (!(error instanceof ToolError)) return false;
        assert.equal(error.tool, "git");
        assert.match(error.message, /is not absolute/);
        return true;
      },
    );
  });

  it("reports a missing git before a missing ssh, pinning iteration order", () => {
    assert.throws(
      () =>
        resolveTools({
          KANTHORD_TEST_GIT: "/nonexistent/x",
          KANTHORD_TEST_SSH: "/nonexistent/x",
        }),
      (error: unknown) => {
        if (!(error instanceof ToolError)) return false;
        assert.equal(error.tool, "git");
        return true;
      },
    );
  });

  it("pins minimumGitVersion and compares the version triple numerically", () => {
    assert.equal(minimumGitVersion, "2.34.0");

    const dir = fs.mkdtempSync(join(os.tmpdir(), "kanthord-tools-"));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const stub = join(dir, "git");
    fs.writeFileSync(
      stub,
      '#!/bin/sh\ncase "$1" in\n  --version) echo "git version 2.9.0" ;;\n  --exec-path) echo /usr/bin ;;\n  *) exit 1 ;;\nesac\n',
      { mode: 0o755 },
    );

    assert.throws(
      () => resolveTools({ KANTHORD_TEST_GIT: stub }),
      (error: unknown) => {
        if (!(error instanceof ToolError)) return false;
        assert.equal(error.tool, "git");
        assert.match(error.message, /below the tested minimum/);
        return true;
      },
    );
  });

  it("never hands out a mutable paths record", () => {
    const tools = resolveTools({});
    assert.throws(() => {
      (tools.paths as Record<string, string>).git = "x";
    });
  });

  it("refuses a git probe that exits non-zero even when it prints a valid version", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "kanthord-tool-probe-"));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const stub = join(dir, "git");
    fs.writeFileSync(stub, '#!/bin/sh\n/usr/bin/git "$@"\nexit 1\n', {
      mode: 0o755,
    });

    assert.throws(
      () => resolveTools({ KANTHORD_TEST_GIT: stub }),
      (error: unknown) => {
        if (!(error instanceof ToolError)) return false;
        assert.equal(error.tool, "git");
        return true;
      },
    );
  });

  it("resolves only the requested tool names, skipping validation of the rest", () => {
    const tools = resolveTools({ KANTHORD_TEST_SSHD: "/nonexistent/sshd" }, [
      "git",
    ]);
    assert.deepEqual(Object.keys(tools.paths), ["git"]);
    assert.equal(tools.paths.git, "/usr/bin/git");
    assert.match(tools.gitVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(isAbsolute(tools.execPath), true);
    assert.equal(fs.statSync(tools.httpBackend).isFile(), true);
  });

  it("narrows paths to exactly the requested tool names", () => {
    const tools = resolveTools({}, ["git"]);
    assert.deepEqual(tools.paths, { git: "/usr/bin/git" });
    assert.deepEqual(Object.keys(tools.paths), ["git"]);
  });

  it("narrows sshVersion to undefined, not the empty-string sentinel, when ssh was not requested", () => {
    const tools = resolveTools({}, ["git"]);
    assert.equal(tools.sshVersion, undefined);
  });

  it("still resolves all five paths and both versions with no names argument", () => {
    const tools = resolveTools({});
    assert.deepEqual(Object.keys(tools.paths), [
      "git",
      "ssh",
      "sshd",
      "sshKeyscan",
      "sshKeygen",
    ]);
    assert.match(tools.gitVersion, /^\d+\.\d+\.\d+$/);
    assert.match(tools.sshVersion, /^\d+\.\d+/);
  });

  it("refuses at the type level to read an unrequested tool's path", () => {
    const tools = resolveTools({}, ["git"]);
    // @ts-expect-error paths.ssh does not exist on a result narrowed to ["git"]
    const ssh: string = tools.paths.ssh;
    assert.equal(ssh, undefined);
  });

  it("refuses an ssh -V probe that exits non-zero even when it prints a valid version", () => {
    const dir = fs.mkdtempSync(join(os.tmpdir(), "kanthord-tool-probe-"));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const stub = join(dir, "ssh");
    fs.writeFileSync(
      stub,
      '#!/bin/sh\necho "OpenSSH_10.2p1, LibreSSL 3.3.6" >&2\nexit 1\n',
      { mode: 0o755 },
    );

    assert.throws(
      () => resolveTools({ KANTHORD_TEST_SSH: stub }),
      (error: unknown) => {
        if (!(error instanceof ToolError)) return false;
        assert.equal(error.tool, "ssh");
        return true;
      },
    );
  });
});
