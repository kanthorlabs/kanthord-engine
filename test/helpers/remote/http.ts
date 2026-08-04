import { createServer } from "node:http";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveTools, toolTimeoutMilliseconds } from "./tools.ts";
import type { Tools } from "./tools.ts";
import {
  fixtureObjectIds,
  pinnedGitConfigArguments,
  pinnedGitEnvironment,
} from "./seed.ts";
import type { SeedRoot } from "./seed.ts";

export type FixtureCredential = Readonly<{
  username: string;
  token: string;
  write: boolean;
}>;

export type HttpRequestRecord = Readonly<{
  method: string;
  path: string;
  status: number;
  username: string | null;
  headers: Readonly<Record<string, string>>;
  spawnedCgi: boolean;
}>;

export type HttpRemote = Readonly<{
  transport: "http-basic";
  port: number;
  origin: string;
  url(repository: string): string;
  authenticatedUrl(repository: string, credential: FixtureCredential): string;
  seed: SeedRoot;
  credentials: Readonly<Record<"reader" | "writer", FixtureCredential>>;
  wrongCredential: FixtureCredential;
  requestLog(): readonly HttpRequestRecord[];
  cgiSpawnCount(): number;
  dispose(): Promise<void>;
}>;

export const httpCredentials: Readonly<
  Record<"reader" | "writer", FixtureCredential>
> = {
  reader: { username: "reader", token: "r-tok", write: false },
  writer: { username: "writer", token: "w-tok", write: true },
};

export const httpWrongCredential: FixtureCredential = {
  username: "writer",
  token: "bad-tok",
  write: false,
};

type RequestRecord = {
  method: string;
  path: string;
  status: number;
  username: string | null;
  headers: Readonly<Record<string, string>>;
  spawnedCgi: boolean;
  stderr?: string;
  streamError?: string;
};

function parseAuthorization(
  headers: IncomingHttpHeaders,
): { username: string; token: string } | null {
  const header = headers["authorization"];
  if (typeof header !== "string") {
    return null;
  }
  const match = /^Basic\s+(.+)$/.exec(header);
  if (match === null) {
    return null;
  }
  const decoded = Buffer.from(match[1] ?? "", "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) {
    return null;
  }
  return {
    username: decoded.slice(0, separator),
    token: decoded.slice(separator + 1),
  };
}

function findCredential(
  username: string,
  token: string,
): FixtureCredential | null {
  const candidates: readonly FixtureCredential[] = [
    httpCredentials.reader,
    httpCredentials.writer,
  ];
  for (const credential of candidates) {
    if (credential.username === username && credential.token === token) {
      return credential;
    }
  }
  return null;
}

function normalizedHeaders(
  headers: IncomingHttpHeaders,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      result[name] = value[0] ?? "";
    } else if (value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return "";
}

function cgiEnvironment(
  tools: Tools,
  seed: SeedRoot,
  req: IncomingMessage,
  parsed: URL,
  matched: FixtureCredential | null,
): Record<string, string> {
  return {
    PATH: tools.execPath,
    LC_ALL: "C",
    GIT_PROJECT_ROOT: seed.path,
    GIT_HTTP_EXPORT_ALL: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    REQUEST_METHOD: req.method ?? "GET",
    PATH_INFO: parsed.pathname,
    QUERY_STRING: parsed.search.slice(1),
    CONTENT_TYPE: headerValue(req.headers, "content-type"),
    CONTENT_LENGTH: headerValue(req.headers, "content-length"),
    REMOTE_USER: matched === null ? "" : matched.username,
    REMOTE_ADDR: "127.0.0.1",
    SERVER_PROTOCOL: "HTTP/1.1",
    GATEWAY_INTERFACE: "CGI/1.1",
  };
}

function handleRequest(
  tools: Tools,
  seed: SeedRoot,
  records: RequestRecord[],
  liveChildren: Set<ChildProcess>,
  countSpawn: () => void,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  const isWriteRequest =
    parsed.pathname.endsWith("/git-receive-pack") ||
    parsed.searchParams.get("service") === "git-receive-pack";
  const presented = parseAuthorization(req.headers);
  const matched =
    presented === null
      ? null
      : findCredential(presented.username, presented.token);

  const record: RequestRecord = {
    method: req.method ?? "GET",
    path: req.url ?? "/",
    status: 0,
    username: presented === null ? null : presented.username,
    headers: normalizedHeaders(req.headers),
    spawnedCgi: false,
  };
  records.push(record);

  if (isWriteRequest) {
    if (matched === null || !matched.write) {
      record.status = 401;
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", 'Basic realm="kanthord-fixture"');
      res.end("unauthorized\n");
      return;
    }
  }

  record.spawnedCgi = true;
  countSpawn();
  const child = spawn(tools.httpBackend, [], {
    env: cgiEnvironment(tools, seed, req, parsed, matched),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: toolTimeoutMilliseconds,
    killSignal: "SIGKILL",
  });
  liveChildren.add(child);

  let stderrOutput = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrOutput += chunk.toString("utf8");
  });

  let responseEnded = false;
  const endResponse = (): void => {
    if (responseEnded) {
      return;
    }
    responseEnded = true;
    res.end();
  };

  child.on("error", (error: Error) => {
    record.status = 500;
    record.streamError = error.message;
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end("cgi failed\n");
    }
    endResponse();
  });
  child.once("close", (code) => {
    liveChildren.delete(child);
    if (code !== null && code !== 0 && stderrOutput.length > 0) {
      record.stderr = stderrOutput;
    }
  });

  let headDone = false;
  let headChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    if (headDone) {
      res.write(chunk);
      return;
    }
    headChunks.push(chunk);
    const total = Buffer.concat(headChunks);
    const headEnd = total.indexOf("\r\n\r\n");
    if (headEnd === -1) {
      return;
    }
    headDone = true;
    headChunks = [];
    let status = 200;
    for (const line of total
      .subarray(0, headEnd)
      .toString("utf8")
      .split("\r\n")) {
      const separator = line.indexOf(": ");
      if (separator === -1) {
        continue;
      }
      const name = line.slice(0, separator);
      const value = line.slice(separator + 2);
      if (name === "Status") {
        const parsedStatus = Number.parseInt(value, 10);
        if (Number.isFinite(parsedStatus)) {
          status = parsedStatus;
        }
      } else {
        res.setHeader(name, value);
      }
    }
    record.status = status;
    res.writeHead(status);
    const bodyStart = total.subarray(headEnd + 4);
    if (bodyStart.length > 0) {
      res.write(bodyStart);
    }
  });
  child.stdout.on("end", endResponse);

  child.stdin.on("error", (error: Error) => {
    record.streamError = error.message;
  });
  req.on("error", (error: Error) => {
    record.streamError = error.message;
  });
  req.pipe(child.stdin);
}

function basicHeader(credential: FixtureCredential): string {
  return (
    "Basic " +
    Buffer.from(`${credential.username}:${credential.token}`).toString("base64")
  );
}

function runGitAsync(
  binary: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      {
        env,
        encoding: "utf8",
        timeout: toolTimeoutMilliseconds,
        killSignal: "SIGKILL",
        maxBuffer: 8 * 1024 * 1024,
      },
      (error: Error | null, stdout: string | Buffer) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout.toString());
      },
    );
  });
}

export const httpAcceptanceChecks: readonly {
  name: string;
  run(subject: HttpRemote): Promise<void> | void;
}[] = [
  {
    name: "http: HEAD symref discovery",
    async run(subject) {
      const tools = resolveTools({});
      const output = await runGitAsync(
        tools.paths.git,
        [
          ...pinnedGitConfigArguments,
          "ls-remote",
          "--symref",
          subject.url("fixture.git"),
          "HEAD",
        ],
        { ...pinnedGitEnvironment, PATH: tools.execPath },
      );
      if (!output.includes(`ref: refs/heads/main\tHEAD`)) {
        throw new Error(
          "http acceptance: HEAD symref discovery is missing ref: refs/heads/main",
        );
      }
      if (!output.includes(`${fixtureObjectIds.commit2}\tHEAD`)) {
        throw new Error(
          "http acceptance: HEAD symref discovery is missing the commit2 object id",
        );
      }
    },
  },
  {
    name: "http: fetch writes the tracking ref",
    async run(subject) {
      const tools = resolveTools({});
      const dir = fs.mkdtempSync(join(tmpdir(), "kanthord-http-accept-"));
      const env = { ...pinnedGitEnvironment, PATH: tools.execPath };
      try {
        await runGitAsync(
          tools.paths.git,
          [...pinnedGitConfigArguments, "init", "--template=", dir],
          env,
        );
        await runGitAsync(
          tools.paths.git,
          [
            ...pinnedGitConfigArguments,
            "-C",
            dir,
            "remote",
            "add",
            "origin",
            subject.authenticatedUrl("fixture.git", subject.credentials.reader),
          ],
          env,
        );
        await runGitAsync(
          tools.paths.git,
          [
            ...pinnedGitConfigArguments,
            "-C",
            dir,
            "fetch",
            "--no-tags",
            "--prune",
            "origin",
          ],
          env,
        );
        const refs = await runGitAsync(
          tools.paths.git,
          [
            ...pinnedGitConfigArguments,
            "-C",
            dir,
            "for-each-ref",
            "--format=%(refname) %(objectname)",
          ],
          env,
        );
        if (
          !refs.includes(`refs/remotes/origin/main ${fixtureObjectIds.commit2}`)
        ) {
          throw new Error(
            "http acceptance: the fetch did not write the origin/main tracking ref",
          );
        }
        for (const line of refs.split("\n")) {
          if (line === "") {
            continue;
          }
          const name = line.split(" ")[0] ?? "";
          if (/^refs\/heads\//.test(name) || /^refs\/tags\//.test(name)) {
            throw new Error(
              "http acceptance: the fetch wrote a local heads or tags ref",
            );
          }
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: "http: receive-pack refuses a missing and a wrong credential",
    async run(subject) {
      const endpoint = `${subject.url("fixture.git")}/info/refs?service=git-receive-pack`;
      const responses = await Promise.all([
        fetch(endpoint),
        fetch(endpoint, {
          headers: { authorization: basicHeader(httpWrongCredential) },
        }),
        fetch(endpoint, {
          headers: { authorization: basicHeader(subject.credentials.reader) },
        }),
      ]);
      for (const [index, response] of responses.entries()) {
        if (response.status !== 401) {
          throw new Error(
            `http acceptance: receive-pack refused request ${index} answered ${response.status}`,
          );
        }
      }
    },
  },
  {
    name: "http: receive-pack admits a write credential",
    async run(subject) {
      const endpoint = `${subject.url("fixture.git")}/info/refs?service=git-receive-pack`;
      const response = await fetch(endpoint, {
        headers: { authorization: basicHeader(subject.credentials.writer) },
      });
      if (response.status !== 200) {
        throw new Error(
          `http acceptance: receive-pack write advertisement answered ${response.status}`,
        );
      }
      const body = await response.text();
      if (!body.startsWith("001f# service=git-receive-pack\n")) {
        throw new Error(
          "http acceptance: receive-pack advertisement body is not the fixture pkt-line",
        );
      }
    },
  },
];

export function startHttpRemote(
  tools: Tools,
  seed: SeedRoot,
): Promise<HttpRemote> {
  const records: RequestRecord[] = [];
  const liveChildren = new Set<ChildProcess>();
  let cgiSpawnCountValue = 0;

  const server = createServer((req, res) => {
    handleRequest(
      tools,
      seed,
      records,
      liveChildren,
      () => {
        cgiSpawnCountValue += 1;
      },
      req,
      res,
    );
  });

  return new Promise<HttpRemote>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("http fixture: server has no numeric address"));
        return;
      }
      const port = address.port;
      const origin = `http://127.0.0.1:${port}`;
      const remote: HttpRemote = {
        transport: "http-basic",
        port,
        origin,
        url(repository: string): string {
          return `${origin}/${repository}`;
        },
        authenticatedUrl(
          repository: string,
          credential: FixtureCredential,
        ): string {
          return `http://${credential.username}:${credential.token}@127.0.0.1:${port}/${repository}`;
        },
        seed,
        credentials: httpCredentials,
        wrongCredential: httpWrongCredential,
        requestLog(): readonly HttpRequestRecord[] {
          return records;
        },
        cgiSpawnCount(): number {
          return cgiSpawnCountValue;
        },
        dispose(): Promise<void> {
          for (const child of liveChildren) {
            child.kill("SIGKILL");
          }
          return new Promise<void>((resolveClose) => {
            server.closeAllConnections();
            server.close(() => resolveClose());
          });
        },
      };
      resolve(remote);
    });
  });
}
