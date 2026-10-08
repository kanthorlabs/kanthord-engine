import { getMimeType } from "hono/utils/mime";
import { HttpMethod, MediaType } from "../kernel/http.ts";

export type DashboardLoader = (path: string) => ArrayBuffer | undefined;

const API_PATH = "/api";
const DASHBOARD_INDEX = "index.html";
const HEAD_METHOD = "HEAD";

function isDashboardRequest(method: string, path: string): boolean {
  return (
    (method === HttpMethod.Get || method === HEAD_METHOD) &&
    path !== API_PATH &&
    !path.startsWith(`${API_PATH}/`)
  );
}

function assetResponse(
  method: string,
  name: string,
  asset: ArrayBuffer,
): Response {
  const headers = new Headers({
    "Content-Type": getMimeType(name) ?? MediaType.Binary,
  });
  if (name === DASHBOARD_INDEX) headers.set("Cache-Control", "no-cache");
  return new Response(method === HEAD_METHOD ? null : asset, { headers });
}

export function dashboardResponse(
  method: string,
  path: string,
  load: DashboardLoader,
): Response | undefined {
  if (!isDashboardRequest(method, path)) return undefined;
  const name = path.slice(1);
  const asset = name ? load(name) : undefined;
  if (asset) return assetResponse(method, name, asset);
  const index = load(DASHBOARD_INDEX);
  return index ? assetResponse(method, DASHBOARD_INDEX, index) : undefined;
}
