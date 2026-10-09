import { getMimeType } from "hono/utils/mime";
import { HttpMethod, MediaType } from "../kernel/http.ts";
import { baseHref } from "./base-path.ts";

export type DashboardLoader = (path: string) => ArrayBuffer | undefined;

const API_PATH = "/api";
const DASHBOARD_INDEX = "index.html";
const HEAD_METHOD = "HEAD";
const HEAD_OPEN_TAG = /<head(?:\s[^>]*)?>/i;

function isDashboardRequest(method: string, path: string): boolean {
  return (
    (method === HttpMethod.Get || method === HEAD_METHOD) &&
    path !== API_PATH &&
    !path.startsWith(`${API_PATH}/`)
  );
}

function indexWithBase(index: ArrayBuffer, basePath: string): ArrayBuffer {
  const html = new TextDecoder().decode(index);
  const head = HEAD_OPEN_TAG.exec(html);
  if (!head) throw new Error("dashboard index has no head element");
  const end = head.index + head[0].length;
  const injected = `${html.slice(0, end)}<base href="${baseHref(basePath)}">${html.slice(end)}`;
  return new TextEncoder().encode(injected).buffer as ArrayBuffer;
}

function assetResponse(
  method: string,
  name: string,
  asset: ArrayBuffer,
  basePath: string,
): Response {
  const headers = new Headers({
    "Content-Type": getMimeType(name) ?? MediaType.Binary,
  });
  if (name === DASHBOARD_INDEX) headers.set("Cache-Control", "no-cache");
  const body =
    name === DASHBOARD_INDEX ? indexWithBase(asset, basePath) : asset;
  return new Response(method === HEAD_METHOD ? null : body, { headers });
}

export function dashboardResponse(
  method: string,
  path: string,
  basePath: string,
  load: DashboardLoader,
): Response | undefined {
  if (!isDashboardRequest(method, path)) return undefined;
  const name = path.slice(1);
  const asset = name ? load(name) : undefined;
  if (asset) return assetResponse(method, name, asset, basePath);
  const index = load(DASHBOARD_INDEX);
  return index
    ? assetResponse(method, DASHBOARD_INDEX, index, basePath)
    : undefined;
}
