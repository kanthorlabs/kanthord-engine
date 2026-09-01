import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";

import {
  decodeVerifyBlock,
  parseVerifyBlock,
  renderVerifyBlock,
  verifyBlock,
  VerifyBlockError,
} from "./verify-block.ts";

function assertInvalidPath(path: string): void {
  const result = verifyBlock.safeParse({ paths: [path], commands: [] });

  assert.strictEqual(result.success, false);
  if (result.success) {
    assert.fail("expected the verify path to be refused");
  }
  assert.deepStrictEqual(result.error.issues[0]?.path, ["paths", 0]);
}

function assertMalformedJson(text: string): void {
  assert.throws(
    () => parseVerifyBlock(text),
    (error) =>
      error instanceof VerifyBlockError &&
      error.code === "verify-json-malformed",
  );
}

describe("src/domain/verify-block.ts", () => {
  it("decodeVerifyBlock returns a block for valid JSON", () => {
    const text = '{"paths":["/src/test.ts"],"commands":["pnpm test"]}';

    assert.deepStrictEqual(decodeVerifyBlock(text), {
      ok: true,
      block: { paths: ["/src/test.ts"], commands: ["pnpm test"] },
    });
    assert.deepStrictEqual(parseVerifyBlock(text), {
      paths: ["/src/test.ts"],
      commands: ["pnpm test"],
    });
  });

  it("decodeVerifyBlock returns not ok for malformed JSON", () => {
    assert.deepStrictEqual(decodeVerifyBlock("{"), { ok: false });
  });

  it("decodeVerifyBlock returns not ok for an invalid verify block", () => {
    assert.deepStrictEqual(
      decodeVerifyBlock('{"paths":["a/../b"],"commands":[]}'),
      { ok: false },
    );
  });

  it("renders an empty block as canonical bytes", () => {
    assert.strictEqual(
      renderVerifyBlock({ paths: [], commands: [] }),
      '{"paths":[],"commands":[]}',
    );
  });

  it("sorts paths bytewise", () => {
    assert.strictEqual(
      renderVerifyBlock({ paths: ["/b/f.ts", "/a/f.ts"], commands: [] }),
      '{"paths":["/a/f.ts","/b/f.ts"],"commands":[]}',
    );
  });

  it("sorts non-ASCII paths by UTF-8 bytes", () => {
    const paths = ["/ñ/f.ts", "/a/f.ts"];
    const expected = [...paths].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
    const rendered = JSON.parse(renderVerifyBlock({ paths, commands: [] })) as {
      paths: unknown;
    };

    assert.deepStrictEqual(rendered.paths, expected);
  });

  it("refuses a duplicate path by error code", () => {
    assert.throws(
      () => renderVerifyBlock({ paths: ["/a", "/a"], commands: [] }),
      (error) =>
        error instanceof VerifyBlockError &&
        error.code === "verify-json-malformed",
    );
  });

  it("the submitted verify schema refuses duplicate paths", () => {
    const result = verifyBlock.safeParse({
      paths: ["/src/foo.ts", "/src/foo.ts"],
      commands: [],
    });

    assert.equal(result.success, false);
  });

  it("preserves duplicate commands in author order", () => {
    const rendered = renderVerifyBlock({
      paths: [],
      commands: ["b", "a", "b"],
    });

    assert.deepStrictEqual(parseVerifyBlock(rendered).commands, [
      "b",
      "a",
      "b",
    ]);
  });

  it("refuses a third key instead of stripping it", () => {
    const input = { paths: [], commands: [], extra: 1 };
    const result = verifyBlock.safeParse(input);

    assert.strictEqual(result.success, false);
  });

  it("accepts an absolute path", () => {
    const result = verifyBlock.safeParse({
      paths: ["/abs/src/foo.ts"],
      commands: [],
    });

    assert.strictEqual(result.success, true);
    if (!result.success) {
      assert.fail("expected the absolute path to be accepted");
    }
    assert.deepStrictEqual(result.data.paths, ["/abs/src/foo.ts"]);
  });

  it("refuses a relative path because verify paths are absolute", () => {
    assertInvalidPath("src/foo.ts");
  });

  it("refuses an empty path at its array position", () => {
    assertInvalidPath("");
  });

  it("refuses a NUL byte at its array position", () => {
    assertInvalidPath("/a\0b");
  });

  it("refuses an unpaired surrogate at its array position", () => {
    assertInvalidPath("/a\uD800b");
  });

  it("refuses a backslash at its array position", () => {
    assertInvalidPath("/a\\b");
  });

  it("refuses an empty segment at its array position", () => {
    assertInvalidPath("/a//b");
  });

  it("refuses a dot segment at its array position", () => {
    assertInvalidPath("/a/./b");
  });

  it("refuses a dot-dot segment at its array position", () => {
    assertInvalidPath("/a/../b");
  });

  it("refuses a trailing slash at its array position", () => {
    assertInvalidPath("/a/");
  });

  it("refuses invalid JSON by error code", () => {
    assertMalformedJson("{");
  });

  it("refuses an array by error code", () => {
    assertMalformedJson("[]");
  });

  it("refuses a missing commands key by error code", () => {
    assertMalformedJson('{"paths":[]}');
  });
});
