import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { background } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import type { SshRelayAccess } from "./contract.ts";
import {
  SshReader,
  SshWriter,
  generateSshKey,
  sshPublicKeyBlob,
} from "./ssh-key.ts";
import { relayedSignature } from "./ssh-sign.ts";
import {
  AGENT_MESSAGE_BYTES_MAX,
  serveRelayAgent,
  SshAgentMessage,
} from "./ssh-relay-agent.ts";
import {
  SSH_AGENT_DIRECTORY_PREFIX,
  SSH_AGENT_SOCKET,
  withSshAgent,
} from "./ssh-agent.ts";
import {
  knownHostsKeyBlob,
  sshSignatureVerifies,
  userAuthenticationData,
} from "./test-sshd.ts";

const execFileAsync = promisify(execFile);
const HOST_KEY_LINE =
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n";
const PORT = 22;
const LENGTH_BYTES = 4;
const SESSION_BIND = "session-bind@openssh.com";
const ADD_IDENTITY = 17;
const RSA_SHA2_256 = 2;
const RSA_SHA2_512 = 4;
const NO_FLAGS = 0;
const ONE_IDENTITY = 1;
const DEADLINE_MS = 30_000;
const NO_RELAYS = 0;
const RELAY_REFUSED = "relay refused";
const EMPTY_FRAME = 0;
const BATCHED_REPLIES = 2;
const PRIVATE_KEY_MARKER = "PRIVATE";

delete process.env.SSH_AUTH_SOCK;
delete process.env.SSH_AGENT_PID;

interface Relayed {
  data: Buffer;
  flags: number;
}

function relayFixture(fail = false) {
  const key = generateSshKey("deploy");
  const keyAccess = {
    private_key: key.private_key,
    public_key: key.public_key,
    known_hosts: HOST_KEY_LINE,
    port: PORT,
  };
  const relayed: Relayed[] = [];
  const access: SshRelayAccess = {
    relay: async (data, flags) => {
      relayed.push({ data, flags });
      if (fail) throw new Error(RELAY_REFUSED);
      return relayedSignature(keyAccess, data);
    },
    public_key: key.public_key,
    known_hosts: HOST_KEY_LINE,
    port: PORT,
  };
  return {
    key,
    access,
    relayed,
    blob: sshPublicKeyBlob(key.public_key),
    hostKey: knownHostsKeyBlob(HOST_KEY_LINE),
  };
}

class AgentClient {
  private pending = Buffer.alloc(0);
  private readonly waiting: ((reply: Buffer) => void)[] = [];
  readonly closed: Promise<void>;
  readonly socket: Socket;
  constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => {
      this.pending = Buffer.concat([this.pending, chunk]);
      while (this.pending.length >= LENGTH_BYTES) {
        const length = this.pending.readUInt32BE(0);
        if (this.pending.length < LENGTH_BYTES + length) return;
        const reply = this.pending.subarray(
          LENGTH_BYTES,
          LENGTH_BYTES + length,
        );
        this.pending = this.pending.subarray(LENGTH_BYTES + length);
        this.waiting.shift()?.(Buffer.from(reply));
      }
    });
    this.closed = new Promise((resolve) =>
      socket.once("close", () => resolve()),
    );
  }
  static async open(t: TestContext, path: string): Promise<AgentClient> {
    const socket = connect(path);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    t.after(() => socket.destroy());
    return new AgentClient(socket);
  }
  writeRaw(bytes: Buffer): void {
    this.socket.write(bytes);
  }
  request(message: Buffer): Promise<Buffer> {
    const reply = new Promise<Buffer>((resolve) => this.waiting.push(resolve));
    this.socket.write(frame(message));
    return reply;
  }
}

function frame(message: Buffer): Buffer {
  const length = Buffer.alloc(LENGTH_BYTES);
  length.writeUInt32BE(message.length);
  return Buffer.concat([length, message]);
}

function identitiesRequest(): Buffer {
  return Buffer.from([SshAgentMessage.RequestIdentities]);
}

function signRequest(key: Buffer, data: Buffer, flags: number): Buffer {
  return new SshWriter()
    .byte(SshAgentMessage.SignRequest)
    .bytes(key)
    .bytes(data)
    .uint32(flags)
    .build();
}

function sessionBind(hostKey: Buffer): Buffer {
  return new SshWriter()
    .byte(SshAgentMessage.Extension)
    .text(SESSION_BIND)
    .bytes(hostKey)
    .bytes(Buffer.alloc(32))
    .bytes(Buffer.alloc(64))
    .byte(NO_FLAGS)
    .build();
}

function signatureOf(reply: Buffer): Buffer {
  assert.equal(reply[0], SshAgentMessage.SignResponse);
  return new SshReader(reply.subarray(1)).bytes();
}

async function served(t: TestContext, access: SshRelayAccess) {
  const path = join(temporary(t), SSH_AGENT_SOCKET);
  const agent = await serveRelayAgent(path, access, background);
  t.after(() => agent.close());
  return { path, agent };
}

test("the relay agent lists the setup public key and relays each sign request with its flags", async (t) => {
  const f = relayFixture();
  const { path } = await served(t, f.access);
  const client = await AgentClient.open(t, path);
  const identities = await client.request(identitiesRequest());
  const reader = new SshReader(identities.subarray(1));
  assert.equal(identities[0], SshAgentMessage.IdentitiesAnswer);
  assert.equal(reader.uint32(), ONE_IDENTITY);
  assert.ok(reader.bytes().equals(f.blob));
  for (const flags of [NO_FLAGS, RSA_SHA2_256, RSA_SHA2_512]) {
    const data = userAuthenticationData({ key: f.blob, hostKey: f.hostKey });
    const signature = signatureOf(
      await client.request(signRequest(f.blob, data, flags)),
    );
    assert.ok(sshSignatureVerifies(f.key.public_key, data, signature));
    assert.deepEqual(f.relayed.at(-1), { data, flags });
  }
});

test("session-bind answers SSH_AGENT_FAILURE and the connection keeps serving", async (t) => {
  const f = relayFixture();
  const { path } = await served(t, f.access);
  const client = await AgentClient.open(t, path);
  const bind = await client.request(sessionBind(f.hostKey));
  assert.deepEqual([...bind], [SshAgentMessage.Failure]);
  const data = userAuthenticationData({ key: f.blob, hostKey: f.hostKey });
  const signature = signatureOf(
    await client.request(signRequest(f.blob, data, NO_FLAGS)),
  );
  assert.ok(sshSignatureVerifies(f.key.public_key, data, signature));
});

test("another key, another message and a relay error answer SSH_AGENT_FAILURE, and the agent records the relay error", async (t) => {
  const f = relayFixture();
  const { path, agent } = await served(t, f.access);
  const client = await AgentClient.open(t, path);
  const other = sshPublicKeyBlob(generateSshKey("other").public_key);
  const data = userAuthenticationData({ key: other });
  const failure = [SshAgentMessage.Failure];
  assert.deepEqual(
    [...(await client.request(signRequest(other, data, NO_FLAGS)))],
    failure,
  );
  assert.equal(f.relayed.length, NO_RELAYS);
  assert.deepEqual(
    [...(await client.request(Buffer.from([ADD_IDENTITY])))],
    failure,
  );
  assert.deepEqual(
    [
      ...(await client.request(
        Buffer.from([SshAgentMessage.RequestIdentities, NO_FLAGS]),
      )),
    ],
    failure,
  );
  assert.equal(agent.lastError(), null);
  const failing = relayFixture(true);
  const second = await served(t, failing.access);
  const refused = await AgentClient.open(t, second.path);
  assert.equal(second.agent.lastError(), null);
  assert.deepEqual(
    [
      ...(await refused.request(
        signRequest(
          failing.blob,
          userAuthenticationData({ key: failing.blob }),
          NO_FLAGS,
        ),
      )),
    ],
    failure,
  );
  assert.equal(failing.relayed.length, ONE_IDENTITY);
  assert.equal(second.agent.lastError()?.message, RELAY_REFUSED);
});

test("split and batched frames answer in order", async (t) => {
  const f = relayFixture();
  const { path } = await served(t, f.access);
  const client = await AgentClient.open(t, path);
  const data = userAuthenticationData({ key: f.blob });
  const batch = Buffer.concat([
    frame(identitiesRequest()),
    frame(signRequest(f.blob, data, NO_FLAGS)),
  ]);
  const replies: Buffer[] = [];
  const done = new Promise<void>((resolve) => {
    let pending = Buffer.alloc(0);
    client.socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= LENGTH_BYTES) {
        const length = pending.readUInt32BE(0);
        if (pending.length < LENGTH_BYTES + length) return;
        replies.push(pending.subarray(LENGTH_BYTES, LENGTH_BYTES + length));
        pending = pending.subarray(LENGTH_BYTES + length);
        if (replies.length === BATCHED_REPLIES) resolve();
      }
    });
  });
  for (const byte of batch) client.writeRaw(Buffer.from([byte]));
  await done;
  assert.equal(replies[0]![0], SshAgentMessage.IdentitiesAnswer);
  assert.ok(
    sshSignatureVerifies(f.key.public_key, data, signatureOf(replies[1]!)),
  );
});

test("an empty frame or a frame above the limit closes the connection", async (t) => {
  const f = relayFixture();
  const { path } = await served(t, f.access);
  for (const length of [EMPTY_FRAME, AGENT_MESSAGE_BYTES_MAX + 1]) {
    const client = await AgentClient.open(t, path);
    const header = Buffer.alloc(LENGTH_BYTES);
    header.writeUInt32BE(length);
    client.writeRaw(header);
    await client.closed;
  }
});

test("ssh-add lists the relayed key through the agent socket", async (t) => {
  const f = relayFixture();
  const { path } = await served(t, f.access);
  const { stdout } = await execFileAsync("ssh-add", ["-L"], {
    env: { PATH: process.env.PATH, SSH_AUTH_SOCK: path },
  });
  assert.equal(
    stdout.trim().split(" ").slice(0, 2).join(" "),
    f.key.public_key.split(" ").slice(0, 2).join(" "),
  );
});

test("withSshAgent serves the relay socket only during its operation and writes no private key", async () => {
  const f = relayFixture();
  let socket = "";
  const listed = await withSshAgent(
    f.access,
    background,
    DEADLINE_MS,
    async (environment) => {
      const command = environment.GIT_SSH_COMMAND ?? "";
      const match = /IdentityAgent='([^']+)'/.exec(command);
      assert.ok(match?.[1]);
      socket = match[1];
      assert.ok((await stat(socket)).isSocket());
      const directory = join(socket, "..");
      for (const name of await readdir(directory)) {
        if (name === SSH_AGENT_SOCKET) continue;
        const text = await readFile(join(directory, name), "utf8");
        assert.equal(text.includes(PRIVATE_KEY_MARKER), false);
      }
      const { stdout } = await execFileAsync("ssh-add", ["-L"], {
        env: { PATH: process.env.PATH, SSH_AUTH_SOCK: socket },
      });
      return stdout;
    },
  );
  assert.ok(
    listed.startsWith(f.key.public_key.split(" ").slice(0, 2).join(" ")),
  );
  assert.ok(socket.includes(SSH_AGENT_DIRECTORY_PREFIX));
  await assert.rejects(stat(socket));
  await assert.rejects(stat(join(socket, "..")));
});

test("closing the relay agent cancels a relay call in flight", async (t) => {
  const f = relayFixture();
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const access: SshRelayAccess = {
    ...f.access,
    relay: async (_data, _flags, context) => {
      context.onCancel(() => cancelled.resolve());
      started.resolve();
      await cancelled.promise;
      throw new Error("relay cancelled");
    },
  };
  const path = join(temporary(t), SSH_AGENT_SOCKET);
  const agent = await serveRelayAgent(path, access, background);
  const client = await AgentClient.open(t, path);
  void client.request(
    signRequest(f.blob, userAuthenticationData({ key: f.blob }), NO_FLAGS),
  );
  await started.promise;
  await agent.close();
  await cancelled.promise;
  await client.closed;
});
