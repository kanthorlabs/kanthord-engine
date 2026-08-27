import type { Server } from "node:http";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { Env, Hono } from "hono";

import { bindAuthority } from "../../../../domain/host-authority.ts";

export type ListenInput = Readonly<{ bind: string; port: number }>;

export type ListeningServer = Readonly<{
  port: number;
  close(): Promise<void>;
}>;

export function listen<E extends Env>(
  app: Hono<E>,
  input: ListenInput,
): Promise<ListeningServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(
      getRequestListener(app.fetch, {
        hostname: bindAuthority(input.bind),
        overrideGlobalObjects: false,
      }),
    );
    server.listen(input.port, input.bind);
    let closed = false;
    server.once("error", (error) => {
      reject(error);
    });
    server.once("listening", () => {
      const address = server.address();
      const port =
        address !== null && typeof address === "object"
          ? address.port
          : input.port;
      resolve({
        port,
        close() {
          return new Promise<void>((resolveClose) => {
            if (closed) {
              resolveClose();
              return;
            }
            closed = true;
            server.close(() => resolveClose());
          });
        },
      });
    });
  });
}
