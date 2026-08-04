import { createServer } from "node:http";
import type { Server } from "node:http";
import request from "supertest";
import type Koa from "koa";

const servers = new WeakMap<Koa, Promise<Server>>();

export function loopbackServer(app: Koa): Promise<Server> {
  const existing = servers.get(app);
  if (existing !== undefined) {
    return existing;
  }
  const listening = new Promise<Server>((resolve, reject) => {
    const server = createServer(app.callback());
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
  servers.set(app, listening);
  return listening;
}

export async function loopbackAgent(
  app: Koa,
): Promise<ReturnType<typeof request>> {
  return request(await loopbackServer(app));
}
