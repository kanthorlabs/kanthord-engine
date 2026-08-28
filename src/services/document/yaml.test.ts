import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { YamlDocumentReader } from "./yaml.ts";
import { DocumentError } from "./index.ts";

function walkTsFiles(dir: string): readonly string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsFiles(path));
    } else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

describe("src/services/document/yaml.test", () => {
  const reader = new YamlDocumentReader();
  const source = '---\nid: "task_01A"\n---\nbody\n';

  it("parses frontmatter and body from a document", () => {
    assert.deepEqual(reader.read(source), {
      frontmatter: { id: "task_01A" },
      body: "body\n",
    });
  });

  it("parses a CRLF document to the identical result", () => {
    assert.deepEqual(reader.read('---\r\nid: "task_01A"\r\n---\r\nbody\r\n'), {
      frontmatter: { id: "task_01A" },
      body: "body\n",
    });
  });

  it("parses a lone-CR document to the identical result", () => {
    assert.deepEqual(reader.read('---\rid: "task_01A"\r---\rbody\r'), {
      frontmatter: { id: "task_01A" },
      body: "body\n",
    });
  });

  it("throws document-frontmatter-missing for a document with no opener", () => {
    assert.throws(
      () => reader.read('id: "task_01A"\n---\nbody\n'),
      (err) =>
        err instanceof DocumentError &&
        err.code === "document-frontmatter-missing",
    );
  });

  it("throws document-frontmatter-missing for an opener with no closer", () => {
    assert.throws(
      () => reader.read('---\nid: "task_01A"\n'),
      (err) =>
        err instanceof DocumentError &&
        err.code === "document-frontmatter-missing",
    );
  });

  it("returns an empty body for a closing delimiter as the last line", () => {
    assert.equal(reader.read('---\nid: "task_01A"\n---').body, "");
  });

  it("keeps a --- line inside the body after the closer", () => {
    assert.equal(
      reader.read("---\nid: x\n---\nbody\n---\nmore\n").body,
      "body\n---\nmore\n",
    );
  });

  it("throws document-frontmatter-unparsable carrying the parser message for broken YAML", () => {
    assert.throws(
      () => reader.read('---\nid: "unterminated\n---\nbody\n'),
      (err) =>
        err instanceof DocumentError &&
        err.code === "document-frontmatter-unparsable" &&
        err.message.includes("Missing closing"),
    );
  });

  it("throws document-frontmatter-not-a-map for a list, a scalar and nothing", () => {
    for (const text of [
      "---\n- a\n- b\n---\nbody\n",
      "---\njust a string\n---\nbody\n",
      "---\n---\nbody\n",
    ]) {
      assert.throws(
        () => reader.read(text),
        (err) =>
          err instanceof DocumentError &&
          err.code === "document-frontmatter-not-a-map",
      );
    }
  });

  it("parses unquoted, single-quoted and double-quoted values to the same string", () => {
    const expected = { id: "task_01A" };
    assert.deepEqual(
      reader.read('---\nid: "task_01A"\n---\nbody\n').frontmatter,
      expected,
    );
    assert.deepEqual(
      reader.read("---\nid: 'task_01A'\n---\nbody\n").frontmatter,
      expected,
    );
    assert.deepEqual(
      reader.read("---\nid: task_01A\n---\nbody\n").frontmatter,
      expected,
    );
  });

  it("parses flow and block depends_on to the same list", () => {
    const expected = { depends_on: ["a.md", "b.md"] };
    assert.deepEqual(
      reader.read("---\ndepends_on: [a.md, b.md]\n---\nbody\n").frontmatter,
      expected,
    );
    assert.deepEqual(
      reader.read("---\ndepends_on:\n  - a.md\n  - b.md\n---\nbody\n")
        .frontmatter,
      expected,
    );
  });

  it("parses an anchor and alias without throwing", () => {
    assert.deepEqual(
      reader.read("---\na: &x 1\nb: *x\n---\nbody\n").frontmatter,
      {
        a: 1,
        b: 1,
      },
    );
  });

  it("returns identical results across two reads", () => {
    assert.deepEqual(reader.read(source), reader.read(source));
  });

  it("yaml is imported only in the allow-listed modules", () => {
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const srcDir = fileURLToPath(new URL("../../", import.meta.url));
    const offenders: string[] = [];
    for (const file of walkTsFiles(srcDir)) {
      const content = fs.readFileSync(file, "utf8");
      if (content.match(/from\s+["']yaml["']/)) {
        offenders.push(relative(repositoryRoot, file).replaceAll("\\", "/"));
      }
    }
    assert.deepEqual(offenders.sort(), [
      "src/http/contract/openapi-source.ts",
      "src/http/contract/openapi.ts",
      "src/services/document/yaml.ts",
    ]);
  });
});
