import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { showBlobHandler } from "./show-blob.ts";
import type { BlobView } from "../../../queries/blob/show-blob.ts";

const content = Buffer.from("0123456789");
const hash = `sha256:${createHash("sha256").update(content).digest("hex")}`;

const record: BlobView = {
  hash,
  size: content.length,
  content,
  createdAt: 1700000000000,
};

async function handlerApp(
  showBlob: (input: { hash: string }) => BlobView | null,
) {
  return createTestApp({
    handlers: { "blob.show": showBlobHandler({ showBlob }) },
  });
}

describe("src/http/server/blob/show-blob.test", () => {
  it("answers 200 with the payload and the four fixed headers", async () => {
    const app = await handlerApp(() => record);
    const response = await app.get(`/v1/blob/${hash}`).buffer();

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, content);
    assert.equal(response.headers["accept-ranges"], "bytes");
    assert.equal(
      response.headers["cache-control"],
      "private, immutable, max-age=31536000",
    );
    assert.match(
      response.headers["content-type"] ?? "",
      /application\/octet-stream/,
    );
    assert.equal(response.headers.etag, `"${hash}"`);
  });

  it("calls showBlob exactly once with the hash including the prefix", async () => {
    let calls = 0;
    let recorded: { hash: string } | undefined;
    const app = await handlerApp((input) => {
      calls += 1;
      recorded = input;
      return record;
    });
    await app.get(`/v1/blob/${hash}`).buffer();

    assert.equal(calls, 1);
    assert.deepEqual(recorded, { hash });
  });

  it("Range: bytes=0-4 answers 206 with the first five bytes", async () => {
    const app = await handlerApp(() => record);
    const response = await app
      .get(`/v1/blob/${hash}`)
      .set("Range", "bytes=0-4")
      .buffer();

    assert.equal(response.status, 206);
    assert.deepEqual(response.body, Buffer.from("01234"));
    assert.equal(
      response.headers["content-range"] ?? "",
      `bytes 0-4/${content.length}`,
    );
    assert.equal(response.headers["accept-ranges"], "bytes");
    assert.equal(
      response.headers["cache-control"],
      "private, immutable, max-age=31536000",
    );
    assert.match(
      response.headers["content-type"] ?? "",
      /application\/octet-stream/,
    );
    assert.equal(response.headers.etag, `"${hash}"`);
  });

  it("Range: bytes=-3 answers 206 with the last three bytes", async () => {
    const app = await handlerApp(() => record);
    const response = await app
      .get(`/v1/blob/${hash}`)
      .set("Range", "bytes=-3")
      .buffer();

    assert.equal(response.status, 206);
    assert.deepEqual(response.body, Buffer.from("789"));
    assert.equal(
      response.headers["content-range"] ?? "",
      `bytes 7-9/${content.length}`,
    );
  });

  it("Range: bytes=5- answers 206 with the tail", async () => {
    const app = await handlerApp(() => record);
    const response = await app
      .get(`/v1/blob/${hash}`)
      .set("Range", "bytes=5-")
      .buffer();

    assert.equal(response.status, 206);
    assert.deepEqual(response.body, Buffer.from("56789"));
    assert.equal(
      response.headers["content-range"] ?? "",
      `bytes 5-9/${content.length}`,
    );
  });

  it("an unsatisfiable Range answers 200 with the whole payload and no content-range", async () => {
    const app = await handlerApp(() => record);
    const response = await app
      .get(`/v1/blob/${hash}`)
      .set("Range", "bytes=99-100")
      .buffer();

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, content);
    assert.equal(Object.hasOwn(response.headers, "content-range"), false);
  });

  it("an unparseable Range answers 200 with the whole payload and no content-range", async () => {
    const app = await handlerApp(() => record);
    const response = await app
      .get(`/v1/blob/${hash}`)
      .set("Range", "potato")
      .buffer();

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, content);
    assert.equal(Object.hasOwn(response.headers, "content-range"), false);
  });

  it("a showBlob returning null answers 404 naming the hash", async () => {
    const app = await handlerApp(() => null);
    const response = await app.get(`/v1/blob/${hash}`);

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
    assert.ok(String(response.body.error.message).includes(hash));
  });

  it("a malformed hash answers 404 and showBlob is never called", async () => {
    let calls = 0;
    const app = await handlerApp(() => {
      calls += 1;
      return record;
    });
    const response = await app.get("/v1/blob/notahash");

    assert.equal(response.status, 404);
    assert.equal(calls, 0);
  });

  it("an uppercase hex hash answers 404 and showBlob is never called", async () => {
    let calls = 0;
    const app = await handlerApp(() => {
      calls += 1;
      return record;
    });
    const uppercase = `sha256:${"A".repeat(64)}`;
    const response = await app.get(`/v1/blob/${uppercase}`);

    assert.equal(response.status, 404);
    assert.equal(calls, 0);
  });

  it("no token answers 401 and an Origin header answers 403", async () => {
    const app = await handlerApp(() => record);

    const noToken = await app.raw
      .get(`/v1/blob/${hash}`)
      .set("Host", "kanthord.test");
    assert.equal(noToken.status, 401);

    const origin = await app.raw
      .get(`/v1/blob/${hash}`)
      .set("Host", "kanthord.test")
      .set("Authorization", "Bearer test-token")
      .set("Origin", "https://evil.example");
    assert.equal(origin.status, 403);
  });

  it("a zero-byte blob answers 200 with an empty body, and Range: bytes=0-0 also answers 200", async () => {
    const empty: BlobView = {
      hash,
      size: 0,
      content: Buffer.alloc(0),
      createdAt: 1700000000000,
    };
    const app = await handlerApp(() => empty);

    const whole = await app.get(`/v1/blob/${hash}`).buffer();
    assert.equal(whole.status, 200);
    assert.deepEqual(whole.body, Buffer.alloc(0));

    const ranged = await app
      .get(`/v1/blob/${hash}`)
      .set("Range", "bytes=0-0")
      .buffer();
    assert.equal(ranged.status, 200);
    assert.deepEqual(ranged.body, Buffer.alloc(0));
  });
});
