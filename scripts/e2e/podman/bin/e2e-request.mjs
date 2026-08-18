import { request } from "node:http";
import { connect } from "node:net";
import { readFileSync } from "node:fs";

function headersFor(input) {
  if (input.tokenFile === undefined) {
    return input.headers;
  }

  const headers = Object.fromEntries(
    Object.entries(input.headers).filter(
      ([key]) => key.toLowerCase() !== "authorization",
    ),
  );
  const token = readFileSync(input.tokenFile, "utf8").replace(/\r?\n$/, "");
  return { ...headers, Authorization: `Bearer ${token}` };
}

function issueWithNoHostHeader(hostname, port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, hostname, () => {
      const headerLines = Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}\r\n`)
        .join("");
      socket.write(`${method} ${path} HTTP/1.0\r\n${headerLines}\r\n`);
      if (body !== undefined) {
        socket.write(body);
      }
    });
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const separator = text.indexOf("\r\n\r\n");
      const head = separator === -1 ? text : text.slice(0, separator);
      const bodyText = separator === -1 ? "" : text.slice(separator + 4);
      const statusLine = head.split("\r\n")[0] ?? "";
      const status = Number(statusLine.split(" ")[1] ?? "0");
      resolve({ status, body: bodyText });
    });
  });
}

function issueWithHost(url, path, input) {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        method: input.method,
        hostname: url.hostname,
        port: url.port,
        path,
        headers: input.headers,
        setHost: true,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    if (input.body !== undefined) {
      outgoing.write(input.body);
    }
    outgoing.end();
  });
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", async () => {
  const input = JSON.parse(raw);
  const url = new URL(input.path, input.baseUrl);
  const path = `${url.pathname}${url.search}`;
  const headers = headersFor(input);

  const result = input.omitHost
    ? await issueWithNoHostHeader(
        url.hostname,
        Number(url.port),
        input.method,
        path,
        headers,
        input.body,
      )
    : await issueWithHost(url, path, { ...input, headers });

  process.stdout.write(`${String(result.status)}\n${result.body}`);
});
