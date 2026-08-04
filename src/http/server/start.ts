import type Koa from "koa";
import type { Server } from "node:http";

export type ListenInput = Readonly<{ bind: string; port: number }>;

export type ListeningServer = Readonly<{
  port: number;
  close(): Promise<void>;
}>;

export function listen(app: Koa, input: ListenInput): Promise<ListeningServer> {
  return new Promise((resolve, reject) => {
    const server: Server = app.listen(input.port, input.bind);
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
