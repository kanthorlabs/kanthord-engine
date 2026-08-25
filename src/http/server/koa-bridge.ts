import { getRequestListener } from "@hono/node-server";
import type { Hono } from "hono";
import Koa from "koa";

import type { AppEnv } from "./variables.ts";

export const BRIDGE_HOSTNAME = "kanthord.invalid";

export function koaFromHono(hono: Hono<AppEnv>): Koa {
  const listener = getRequestListener(hono.fetch, {
    overrideGlobalObjects: false,
    hostname: BRIDGE_HOSTNAME,
  });
  const app = new Koa();
  app.use(async (context) => {
    context.respond = false;
    await listener(context.req, context.res);
  });
  return app;
}
