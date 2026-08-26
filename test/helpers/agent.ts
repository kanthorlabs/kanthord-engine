import { createServer } from "node:http";
import type { Server } from "node:http";
import request from "supertest";
import type Koa from "koa";
import type { Env, Hono } from "hono";

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

export type AgentResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: any;
  text: string;
}>;

export type AgentRequest = Promise<AgentResponse> & {
  set(name: string, value: string | readonly string[]): AgentRequest;
  send(body: unknown): AgentRequest;
  buffer(): AgentRequest;
};

export type Agent = Readonly<{
  get(path: string): AgentRequest;
  post(path: string): AgentRequest;
  put(path: string): AgentRequest;
  del(path: string): AgentRequest;
  delete(path: string): AgentRequest;
  options(path: string): AgentRequest;
}>;

export function fetchAgent<E extends Env>(app: Hono<E>): Agent {
  const build = (method: string, path: string): AgentRequest => {
    const headers = new Headers();
    let payload: Uint8Array | undefined;
    let dispatched: Promise<AgentResponse> | undefined;

    const translate = async (res: Response): Promise<AgentResponse> => {
      const joined = new Map<string, string[]>();
      for (const [name, value] of res.headers.entries()) {
        const known = joined.get(name);
        if (known === undefined) {
          joined.set(name, [value]);
        } else {
          known.push(value);
        }
      }
      const flat: Record<string, string> = {};
      for (const [name, values] of joined) {
        flat[name] = values.join(", ");
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const text = new TextDecoder().decode(bytes);
      const mediaType =
        (res.headers.get("content-type") ?? "")
          .split(";")[0]
          ?.trim()
          .toLowerCase() ?? "";
      let body: any;
      if (bytes.length === 0) {
        body = {};
      } else if (mediaType.endsWith("json")) {
        body = JSON.parse(text);
      } else {
        body = Buffer.from(bytes);
      }
      return { status: res.status, headers: flat, body, text };
    };

    const dispatch = (): Promise<AgentResponse> => {
      if (dispatched === undefined) {
        const init: RequestInit = {
          method,
          headers,
        };
        if (payload !== undefined && method !== "GET" && method !== "HEAD") {
          init.body = payload;
        }
        dispatched = Promise.resolve()
          .then(() => app.request(path, init))
          .then(translate);
      }
      return dispatched;
    };

    const built: AgentRequest = {
      then: <TResult1 = AgentResponse, TResult2 = never>(
        onfulfilled?:
          ((value: AgentResponse) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?:
          ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ): Promise<TResult1 | TResult2> =>
        dispatch().then(onfulfilled, onrejected),
      catch: <TResult = never>(
        onrejected?:
          ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
      ): Promise<AgentResponse | TResult> => dispatch().catch(onrejected),
      finally: (onfinally?: (() => void) | null): Promise<AgentResponse> =>
        dispatch().finally(onfinally),
      [Symbol.toStringTag]: "Promise",
      set: (name, value) => {
        const key = name.toLowerCase();
        if (typeof value === "string") {
          headers.set(key, value);
        } else {
          headers.delete(key);
          for (const element of value) {
            headers.append(key, element);
          }
        }
        return built;
      },
      send: (body) => {
        if (typeof body === "string") {
          payload = Buffer.from(body, "utf8");
        } else {
          payload = Buffer.from(JSON.stringify(body), "utf8");
          if (!headers.has("content-type")) {
            headers.set("content-type", "application/json");
          }
        }
        return built;
      },
      buffer: () => built,
    };
    return built;
  };

  return Object.freeze({
    get: (path) => build("GET", path),
    post: (path) => build("POST", path),
    put: (path) => build("PUT", path),
    del: (path) => build("DELETE", path),
    delete: (path) => build("DELETE", path),
    options: (path) => build("OPTIONS", path),
  });
}
