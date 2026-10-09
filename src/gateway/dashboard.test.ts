import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayFixture } from "./test-support.ts";
import { HttpStatus } from "../kernel/http.ts";

const INDEX_HTML =
  "<!doctype html><html><head><title>kanthord</title></head></html>";
const INDEX_NAME = "index.html";
const BASE_PATH = "/s/kanthord";
const ROOT_INDEX_HTML =
  '<!doctype html><html><head><base href="/"><title>kanthord</title></head></html>';
const PREFIXED_INDEX_HTML =
  '<!doctype html><html><head><base href="/s/kanthord/"><title>kanthord</title></head></html>';
const HEADLESS_INDEX_HTML = "<!doctype html><title>kanthord</title>";
const ALLOWED_ORIGIN = "http://localhost:27182";
const SCRIPT = "export const ready = true;";
const ROUTE_NOT_FOUND = "gateway.routing.not_found";
const HOST_NOT_ALLOWED = "gateway.http.host_not_allowed";
const HTML_MEDIA_TYPE = "text/html; charset=utf-8";
const SCRIPT_MEDIA_TYPE = "text/javascript; charset=utf-8";
const JSON_MEDIA_TYPE = "application/json";
const NO_CACHE = "no-cache";
const EMPTY_BODY = "";

const encoder = new TextEncoder();
const embedded = new Map([
  [INDEX_NAME, INDEX_HTML],
  ["assets/index-abc.js", SCRIPT],
]);

function loadEmbedded(path: string): ArrayBuffer | undefined {
  const text = embedded.get(path);
  return text === undefined
    ? undefined
    : (encoder.encode(text).buffer.slice(0) as ArrayBuffer);
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

test("the embedded dashboard answers its root with an uncached index", async (t) => {
  const { request } = await gatewayFixture(t, { dashboard: loadEmbedded });
  const response = await request("/");
  assert.equal(response.status, HttpStatus.OK);
  assert.equal(response.headers.get("content-type"), HTML_MEDIA_TYPE);
  assert.equal(response.headers.get("cache-control"), NO_CACHE);
  assert.equal(await response.text(), ROOT_INDEX_HTML);
});

test("the embedded dashboard answers an asset with its media type", async (t) => {
  const { request } = await gatewayFixture(t, { dashboard: loadEmbedded });
  const response = await request("/assets/index-abc.js");
  assert.equal(response.status, HttpStatus.OK);
  assert.equal(response.headers.get("content-type"), SCRIPT_MEDIA_TYPE);
  assert.ok(!response.headers.has("cache-control"));
  assert.equal(await response.text(), SCRIPT);
});

test("a dashboard route with no asset answers the index", async (t) => {
  const { request } = await gatewayFixture(t, { dashboard: loadEmbedded });
  const response = await request("/mission/mission_01M4C5J3SA6W8RBBC92HA9SSDS");
  assert.equal(response.status, HttpStatus.OK);
  assert.equal(await response.text(), ROOT_INDEX_HTML);
});

test("a HEAD request to the dashboard answers headers without a body", async (t) => {
  const { request } = await gatewayFixture(t, { dashboard: loadEmbedded });
  const response = await request("/", { method: "HEAD" });
  assert.equal(response.status, HttpStatus.OK);
  assert.equal(response.headers.get("content-type"), HTML_MEDIA_TYPE);
  assert.equal(await response.text(), EMPTY_BODY);
});

test("an unknown API path keeps the route error beside the dashboard", async (t) => {
  const { request } = await gatewayFixture(t, { dashboard: loadEmbedded });
  for (const path of ["/api", "/api/unknown"]) {
    const response = await request(path);
    assert.equal(response.status, HttpStatus.NotFound);
    assert.equal(await errorCode(response), ROUTE_NOT_FOUND);
  }
});

test("a dashboard path answers no write method", async (t) => {
  const { request } = await gatewayFixture(t, { dashboard: loadEmbedded });
  const response = await request("/", { method: "POST" });
  assert.equal(response.status, HttpStatus.NotFound);
  assert.equal(await errorCode(response), ROUTE_NOT_FOUND);
});

test("the dashboard refuses a host outside the allowlist", async (t) => {
  const { gateway } = await gatewayFixture(t, { dashboard: loadEmbedded });
  const response = await gateway.app.request("/", {
    headers: { Host: "evil.example" },
  });
  assert.equal(response.status, HttpStatus.Forbidden);
  assert.equal(await errorCode(response), HOST_NOT_ALLOWED);
});

test("outside the single binary the dashboard paths answer the route error", async (t) => {
  const { request } = await gatewayFixture(t);
  const response = await request("/");
  assert.equal(response.status, HttpStatus.NotFound);
  assert.equal(await errorCode(response), ROUTE_NOT_FOUND);
});

test("the dashboard index injects the root base after the opening head tag", async (t) => {
  const { request } = await gatewayFixture(t, { dashboard: loadEmbedded });
  const response = await request("/index.html");
  assert.equal(response.status, HttpStatus.OK);
  assert.equal(await response.text(), ROOT_INDEX_HTML);
});

test("a dashboard index without a head element fails as an internal error", async (t) => {
  const { request } = await gatewayFixture(t, {
    dashboard: (path) =>
      path === INDEX_NAME
        ? (encoder.encode(HEADLESS_INDEX_HTML).buffer.slice(0) as ArrayBuffer)
        : undefined,
  });
  const response = await request("/");
  assert.equal(response.status, HttpStatus.InternalServerError);
});

test("a prefixed gateway answers an API route under the prefix", async (t) => {
  const { request } = await gatewayFixture(t, {
    dashboard: loadEmbedded,
    basePath: BASE_PATH,
  });
  const response = await request(`${BASE_PATH}/api/liveness`);
  assert.equal(response.status, HttpStatus.OK);
  assert.equal(response.headers.get("content-type"), JSON_MEDIA_TYPE);
});

test("a prefixed gateway answers a preflight against the unprefixed route path", async (t) => {
  const { request } = await gatewayFixture(t, {
    dashboard: loadEmbedded,
    basePath: BASE_PATH,
  });
  const headers = {
    Origin: ALLOWED_ORIGIN,
    "Access-Control-Request-Method": "GET",
  };
  const found = await request(`${BASE_PATH}/api/liveness`, {
    method: "OPTIONS",
    headers,
  });
  assert.equal(found.status, HttpStatus.NoContent);
  assert.equal(
    found.headers.get("access-control-allow-origin"),
    ALLOWED_ORIGIN,
  );
  const missing = await request(`${BASE_PATH}/api/unknown`, {
    method: "OPTIONS",
    headers,
  });
  assert.equal(missing.status, HttpStatus.NotFound);
  assert.equal(await errorCode(missing), ROUTE_NOT_FOUND);
});

test("a prefixed gateway answers its root with the prefixed base", async (t) => {
  const { request } = await gatewayFixture(t, {
    dashboard: loadEmbedded,
    basePath: BASE_PATH,
  });
  const response = await request(`${BASE_PATH}/`);
  assert.equal(response.status, HttpStatus.OK);
  assert.equal(response.headers.get("cache-control"), NO_CACHE);
  assert.equal(await response.text(), PREFIXED_INDEX_HTML);
});

test("a prefixed gateway answers an asset under the prefix", async (t) => {
  const { request } = await gatewayFixture(t, {
    dashboard: loadEmbedded,
    basePath: BASE_PATH,
  });
  const response = await request(`${BASE_PATH}/assets/index-abc.js`);
  assert.equal(response.status, HttpStatus.OK);
  assert.equal(response.headers.get("content-type"), SCRIPT_MEDIA_TYPE);
  assert.equal(await response.text(), SCRIPT);
});

test("a prefixed gateway answers a deep dashboard route with the prefixed index", async (t) => {
  const { request } = await gatewayFixture(t, {
    dashboard: loadEmbedded,
    basePath: BASE_PATH,
  });
  const response = await request(
    `${BASE_PATH}/mission/mission_01M4C5J3SA6W8RBBC92HA9SSDS`,
  );
  assert.equal(response.status, HttpStatus.OK);
  assert.equal(await response.text(), PREFIXED_INDEX_HTML);
});

test("a prefixed gateway answers a path outside the prefix with the route error", async (t) => {
  const { request } = await gatewayFixture(t, {
    dashboard: loadEmbedded,
    basePath: BASE_PATH,
  });
  for (const path of [
    "/",
    "/api/liveness",
    "/assets/index-abc.js",
    "/s/kanthordx/",
    "/s",
  ]) {
    const response = await request(path);
    assert.equal(response.status, HttpStatus.NotFound);
    assert.equal(await errorCode(response), ROUTE_NOT_FOUND);
  }
});

test("a prefixed gateway redirects the exact prefix to the prefix with a trailing slash", async (t) => {
  const { request } = await gatewayFixture(t, {
    dashboard: loadEmbedded,
    basePath: BASE_PATH,
  });
  const response = await request(`${BASE_PATH}?tab=missions`, {
    redirect: "manual",
  });
  assert.equal(response.status, HttpStatus.MovedPermanently);
  assert.equal(response.headers.get("location"), `${BASE_PATH}/?tab=missions`);
});

test("a prefixed gateway checks the host before the prefix", async (t) => {
  const { gateway } = await gatewayFixture(t, {
    dashboard: loadEmbedded,
    basePath: BASE_PATH,
  });
  const response = await gateway.app.request("/api/liveness", {
    headers: { Host: "evil.example" },
  });
  assert.equal(response.status, HttpStatus.Forbidden);
  assert.equal(await errorCode(response), HOST_NOT_ALLOWED);
});
