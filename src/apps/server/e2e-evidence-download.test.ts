import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { MissionErrorCode } from "../../mission/contract.ts";
import { fakeS3, gatewayFixture } from "./test-support.ts";
import { seedEvidence } from "./evidence-test-support.ts";

const FIRST_OBJECT_BODY = "0123456789";
const OBJECT_SIZE = FIRST_OBJECT_BODY.length;
const SECOND_OBJECT_BODY = "abcdefghij";
const OBJECT_RANGE_QUERY = "?offset=2&length=3";
const OBJECT_RANGE_TEXT = "234";
const OBJECT_TAIL_QUERY = "?offset=8";
const OBJECT_TAIL_TEXT = "89";
const STORAGE_FAILURE_STATUS = 500;
const SIGNED_QUERY_MARKER = "X-Amz-";
const PRODUCED_TEXT = "ok";
const PRODUCED_SIZE = PRODUCED_TEXT.length;
const TIMEOUT = 300000;
const OCTET_STREAM = "application/octet-stream";
const NOSNIFF = "nosniff";
const TEXT_MEDIA_TYPE = "text/plain";
const RANGE_QUERY = "?offset=1&length=1";
const RANGE_TEXT = "k";

async function setup(t: TestContext) {
  const s3 = await fakeS3(t);
  const fixture = await gatewayFixture(t, {
    repositoryConnector: { gitLsRemote: async () => {} },
  });
  const [node] = await seedEvidence(
    t,
    fixture,
    [{ produced: [PRODUCED_TEXT], object: FIRST_OBJECT_BODY }],
    { s3 },
  );
  const { produced, object, repository, objectKey } = node!;
  const download = (assetId: string, query = "") =>
    fetch(
      `${fixture.endpoint}/api/mission/evidence/asset/${assetId}/content/download${query}`,
      { headers: { Authorization: `Bearer ${fixture.token}` } },
    );
  const overwriteObject = async () => {
    const put = await fetch(`${s3.endpoint}/${s3.bucket}/${objectKey!}`, {
      method: HttpMethod.Put,
      headers: { Authorization: "AWS4-HMAC-SHA256 e2e" },
      body: SECOND_OBJECT_BODY,
    });
    assert.equal(put.status, HttpStatus.OK);
    await put.arrayBuffer();
  };
  return {
    producedId: produced[0]!.assetId,
    repositoryId: repository.assetId,
    objectId: object!.assetId,
    s3,
    logs: fixture.logs,
    overwriteObject,
    download,
  };
}

test(
  "the evidence download answers produced bytes as an attachment and refuses a bad range or a repository asset",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t);
    await t.test("happy path: whole content and a range", async () => {
      const whole = await h.download(h.producedId);
      assert.equal(whole.status, HttpStatus.OK);
      assert.equal(await whole.text(), PRODUCED_TEXT);
      assert.equal(whole.headers.get("content-type"), OCTET_STREAM);
      assert.equal(whole.headers.get("x-content-type-options"), NOSNIFF);
      assert.equal(
        whole.headers.get("content-disposition"),
        `attachment; filename="${h.producedId}.txt"`,
      );
      assert.equal(whole.headers.get("x-evidence-media-type"), TEXT_MEDIA_TYPE);
      assert.equal(whole.headers.get("x-evidence-size"), String(PRODUCED_SIZE));
      const ranged = await h.download(h.producedId, RANGE_QUERY);
      assert.equal(ranged.status, HttpStatus.OK);
      assert.equal(await ranged.text(), RANGE_TEXT);
    });
    await t.test(
      "security, argument guard: an offset at the size answers 400",
      async () => {
        const response = await h.download(
          h.producedId,
          `?offset=${PRODUCED_SIZE}`,
        );
        assert.equal(response.status, HttpStatus.BadRequest);
        const body = (await response.json()) as { error: { code: string } };
        assert.equal(
          body.error.code,
          MissionErrorCode.EvidenceContentRangeInvalid,
        );
      },
    );
    await t.test(
      "security, refused path: a repository asset answers 409",
      async () => {
        const response = await h.download(h.repositoryId);
        assert.equal(response.status, HttpStatus.Conflict);
        const body = (await response.json()) as { error: { code: string } };
        assert.equal(
          body.error.code,
          MissionErrorCode.EvidenceContentRepository,
        );
      },
    );
    await t.test(
      "happy path: an object answers the recorded version, whole and by range",
      async () => {
        await h.overwriteObject();
        const whole = await h.download(h.objectId);
        assert.equal(whole.status, HttpStatus.OK);
        assert.equal(await whole.text(), FIRST_OBJECT_BODY);
        assert.equal(whole.headers.get("content-type"), OCTET_STREAM);
        assert.equal(whole.headers.get("x-evidence-size"), String(OBJECT_SIZE));
        const ranged = await h.download(h.objectId, OBJECT_RANGE_QUERY);
        assert.equal(ranged.status, HttpStatus.OK);
        assert.equal(await ranged.text(), OBJECT_RANGE_TEXT);
        const tail = await h.download(h.objectId, OBJECT_TAIL_QUERY);
        assert.equal(await tail.text(), OBJECT_TAIL_TEXT);
      },
    );
    await t.test(
      "security, redaction: a storage 500 answers 502 with no signed URL",
      async () => {
        h.s3.failNext(STORAGE_FAILURE_STATUS);
        const response = await h.download(h.objectId);
        assert.equal(response.status, HttpStatus.BadGateway);
        const text = await response.text();
        const body = JSON.parse(text) as { error: { code: string } };
        assert.equal(
          body.error.code,
          MissionErrorCode.EvidenceContentUnavailable,
        );
        assert.ok(!text.includes(SIGNED_QUERY_MARKER));
        for (const line of h.logs)
          assert.ok(!line.includes(SIGNED_QUERY_MARKER));
      },
    );
  },
);
