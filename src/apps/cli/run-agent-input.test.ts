import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  buildPromptText,
  looksLikePath,
  partTexts,
  promptTextPathNotice,
  resolveInputValue,
} from "./run-agent-input.ts";
import type { AuthDevIno, InputContext } from "./run-agent-input.ts";

const PROMPT_PLACE = "cli.run.agent.prompt_place";
const AUTH_PLACE = "cli.run.agent.auth_place";
const PROMPT_MISSING = "cli.run.agent.prompt_missing";
const FILE_NOT_REGULAR = "cli.file.not_regular";
const FILE_ENCODING_INVALID = "cli.file.encoding_invalid";
const FIELD_PATH = "path";

let base: string;
const PI_DIR = "/nonexistent-pi-dir-for-input-tests";
const CONFIG_DIR = "/nonexistent-config-dir-for-input-tests";

before(() => {
  base = mkdtempSync(join(tmpdir(), "run-agent-input-test-"));
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

function ctx(
  currentDir: string = base,
  authDevIno: AuthDevIno | null = null,
): InputContext {
  return {
    currentDir,
    authDevIno,
    piDirectory: PI_DIR,
    configDirectories: [CONFIG_DIR],
  };
}

function assertDiagnostic(action: () => unknown, code: string): Diagnostic {
  let result: Diagnostic | undefined;
  assert.throws(action, (e: unknown) => {
    if (!(e instanceof Diagnostic)) return false;
    assert.equal(e.code, code);
    result = e;
    return true;
  });
  return result!;
}

describe("looksLikePath", () => {
  it("returns true for absolute path", () => {
    assert.ok(looksLikePath("/home/user/file.txt"));
  });

  it("returns true for ./ relative path", () => {
    assert.ok(looksLikePath("./file.txt"));
  });

  it("returns true for ../ relative path", () => {
    assert.ok(looksLikePath("../parent/file.txt"));
  });

  it("returns true for path with no whitespace and a slash", () => {
    assert.ok(looksLikePath("some/relative/path"));
  });

  it("returns true for a filename with an extension", () => {
    assert.ok(looksLikePath("README.md"));
    assert.ok(looksLikePath("script.sh"));
    assert.ok(looksLikePath("file.ts"));
  });

  it("returns false for a plain word with no slash or extension", () => {
    assert.ok(!looksLikePath("README"));
    assert.ok(!looksLikePath("fix the failing test"));
  });

  it("returns false when value contains a line break", () => {
    assert.ok(!looksLikePath("line1\nline2"));
    assert.ok(!looksLikePath("line1\rline2"));
  });

  it("returns false when value contains a NUL character", () => {
    assert.ok(!looksLikePath("file\0name"));
  });

  it("returns false when value exceeds 4096 bytes", () => {
    const long = "/home/" + "a".repeat(4100);
    assert.ok(!looksLikePath(long));
  });

  it("returns false for empty string", () => {
    assert.ok(!looksLikePath(""));
  });

  it("returns false when value has whitespace and a slash but no path prefix", () => {
    assert.ok(!looksLikePath("path with space/file.txt"));
  });

  it("extension must be 1 to 8 characters", () => {
    assert.ok(looksLikePath("file.a"));
    assert.ok(looksLikePath("file.abcdefgh"));
    assert.ok(!looksLikePath("file.toolonganextension"));
    assert.ok(!looksLikePath("file."));
  });
});

describe("resolveInputValue", () => {
  it("returns text directly for a non-path-like value", () => {
    const INLINE_TEXT = "fix the failing test";
    const result = resolveInputValue(INLINE_TEXT, ctx());
    assert.equal(result.text, INLINE_TEXT);
    assert.equal(result.notice, false);
  });

  it("reads an existing file for a path-like value", () => {
    const path = join(base, `file-${Date.now()}.md`);
    const FILE_CONTENT = "hello world";
    writeFileSync(path, FILE_CONTENT);
    const result = resolveInputValue(path, ctx());
    assert.equal(result.text, FILE_CONTENT);
    assert.equal(result.notice, false);
  });

  it("returns text with notice when path-like value has no entry", () => {
    const path = join(base, `absent-${Date.now()}.md`);
    const result = resolveInputValue(path, ctx());
    assert.equal(result.text, path);
    assert.equal(result.notice, true);
  });

  it("resolves relative path against currentDir", () => {
    const fileName = `relative-${Date.now()}.md`;
    const REL_CONTENT = "relative content";
    writeFileSync(join(base, fileName), REL_CONTENT);
    const result = resolveInputValue(`./${fileName}`, ctx());
    assert.equal(result.text, REL_CONTENT);
  });

  it("refuses a path under /dev (absolute path before link resolution)", () => {
    assertDiagnostic(() => resolveInputValue("/dev/null", ctx()), PROMPT_PLACE);
  });

  it("refuses a path under /proc (absolute path before link resolution)", () => {
    assertDiagnostic(
      () => resolveInputValue("/proc/self/environ", ctx()),
      PROMPT_PLACE,
    );
  });

  it("refuses a symlink whose real path is under /dev", () => {
    const link = join(base, `devlink-${Date.now()}`);
    symlinkSync("/dev/null", link);
    assertDiagnostic(() => resolveInputValue(link, ctx()), PROMPT_PLACE);
  });

  it("refuses the --auth file by device and inode", () => {
    const authFile = join(base, `auth-${Date.now()}.json`);
    writeFileSync(authFile, "{}", { mode: 0o600 });
    const authStat = statSync(authFile);
    const devIno: AuthDevIno = { dev: authStat.dev, ino: authStat.ino };
    const error = assertDiagnostic(
      () => resolveInputValue(authFile, ctx(base, devIno)),
      AUTH_PLACE,
    );
    assert.ok(error.fields.some(([k]) => k === FIELD_PATH));
  });

  it("refuses a file in the KanthorD config directory", () => {
    const configDir = join(base, `config-dir-${Date.now()}`);
    mkdirSync(configDir);
    const fileInConfig = join(configDir, "some-file.md");
    writeFileSync(fileInConfig, "config content");
    assertDiagnostic(
      () =>
        resolveInputValue(fileInConfig, {
          currentDir: base,
          authDevIno: null,
          piDirectory: PI_DIR,
          configDirectories: [CONFIG_DIR, configDir],
        }),
      AUTH_PLACE,
    );
  });

  it("refuses a file in the pi directory", () => {
    const piDir = join(base, `pi-dir-${Date.now()}`);
    mkdirSync(piDir);
    const fileInPi = join(piDir, "some-file.md");
    writeFileSync(fileInPi, "pi content");
    assertDiagnostic(
      () =>
        resolveInputValue(fileInPi, {
          currentDir: base,
          authDevIno: null,
          piDirectory: piDir,
          configDirectories: [CONFIG_DIR],
        }),
      AUTH_PLACE,
    );
  });

  it("refuses an existing entry that is not a regular file (directory)", () => {
    const dir = join(base, `promptdir-${Date.now()}`);
    mkdirSync(dir);
    assertDiagnostic(() => resolveInputValue(dir, ctx()), FILE_NOT_REGULAR);
  });

  it("refuses a file that is not valid UTF-8", () => {
    const path = join(base, `binary-${Date.now()}.txt`);
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0xfd]));
    assertDiagnostic(
      () => resolveInputValue(path, ctx()),
      FILE_ENCODING_INVALID,
    );
  });

  it("treats a path whose single component is 300 bytes as prompt text", () => {
    const longPart = `/${"a".repeat(300)}/file.txt`;
    const result = resolveInputValue(longPart, ctx());
    assert.equal(result.notice, true);
    assert.equal(result.text, longPart);
  });
});

describe("buildPromptText", () => {
  it("joins parts with blank line", () => {
    const JOINED = "part one\n\npart two";
    const result = buildPromptText(["part one", "part two"]);
    assert.equal(result, JOINED);
  });

  it("removes final line breaks from each part", () => {
    const STRIPPED = "line1\n\nline2";
    const result = buildPromptText(["line1\n", "line2\r\n"]);
    assert.equal(result, STRIPPED);
  });

  it("removes multiple trailing line breaks", () => {
    const HELLO = "hello";
    const result = buildPromptText(["hello\n\n\n"]);
    assert.equal(result, HELLO);
  });

  it("removes mixed trailing line breaks", () => {
    const TEXT = "text";
    const result = buildPromptText(["text\r\n\n"]);
    assert.equal(result, TEXT);
  });

  it("skips empty parts after line break removal", () => {
    const CONTENT = "actual content";
    const result = buildPromptText(["\n", CONTENT, "\r\n"]);
    assert.equal(result, CONTENT);
  });

  it("throws prompt_missing when all parts are empty after removal", () => {
    assertDiagnostic(() => buildPromptText(["\n", "\r\n", ""]), PROMPT_MISSING);
  });

  it("throws prompt_missing for empty parts array", () => {
    assertDiagnostic(() => buildPromptText([]), PROMPT_MISSING);
  });

  it("preserves internal line breaks", () => {
    const MULTILINE = "line1\nline2";
    const result = buildPromptText(["line1\nline2\n"]);
    assert.equal(result, MULTILINE);
  });
});

describe("partTexts", () => {
  it("removes final line breaks and drops a part with no text", () => {
    assert.deepEqual(partTexts(["one\n", "\r\n", "two\r\n\n"]), ["one", "two"]);
  });
});

describe("promptTextPathNotice", () => {
  it("gives one JSON line with the option and the index, and no value", () => {
    const NOTICE_INDEX = 3;
    const NOTICE_OPTION = "--prompt";
    const line = promptTextPathNotice(NOTICE_OPTION, NOTICE_INDEX);
    assert.ok(!line.includes("\n"));
    const notice = JSON.parse(line) as Record<string, unknown>;
    assert.deepEqual(Object.keys(notice), ["code", "msg", "option", "index"]);
    assert.equal(notice["option"], NOTICE_OPTION);
    assert.equal(notice["index"], NOTICE_INDEX);
  });
});
