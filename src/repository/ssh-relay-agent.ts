import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { CancellationContext, type Context } from "../kernel/context.ts";
import { asError } from "../kernel/errors.ts";
import type { SshRelayAccess } from "./contract.ts";
import { sshPublicKeyBlob, SshReader, SshWriter } from "./ssh-key.ts";

export const SshAgentMessage = {
  Failure: 5,
  RequestIdentities: 11,
  IdentitiesAnswer: 12,
  SignRequest: 13,
  SignResponse: 14,
  Extension: 27,
} as const;

export const AGENT_MESSAGE_BYTES_MAX = 262_144;
const LENGTH_BYTES = 4;
const EMPTY_MESSAGE = 0;
const TYPE_BYTES = 1;
const ONE_IDENTITY = 1;
const NO_BYTES = 0;
const IDENTITY_COMMENT = "";

export interface RelayAgent {
  close(): Promise<void>;
  lastError(): Error | null;
}

function frame(message: Buffer): Buffer {
  const length = Buffer.alloc(LENGTH_BYTES);
  length.writeUInt32BE(message.length);
  return Buffer.concat([length, message]);
}

const FAILURE = Buffer.from([SshAgentMessage.Failure]);

function signRequestOf(
  message: Buffer,
): { key: Buffer; data: Buffer; flags: number } | null {
  try {
    const reader = new SshReader(message.subarray(TYPE_BYTES));
    const key = reader.bytes();
    const data = reader.bytes();
    const flags = reader.uint32();
    if (reader.rest().length !== NO_BYTES) return null;
    return { key, data, flags };
  } catch {
    return null;
  }
}

async function answerOf(
  message: Buffer,
  access: SshRelayAccess,
  blob: Buffer,
  context: Context,
  record: (error: Error) => void,
): Promise<Buffer> {
  const type = message[0];
  if (
    type === SshAgentMessage.RequestIdentities &&
    message.length === TYPE_BYTES
  )
    return new SshWriter()
      .byte(SshAgentMessage.IdentitiesAnswer)
      .uint32(ONE_IDENTITY)
      .bytes(blob)
      .text(IDENTITY_COMMENT)
      .build();
  if (type !== SshAgentMessage.SignRequest) return FAILURE;
  const request = signRequestOf(message);
  if (request === null || !request.key.equals(blob)) return FAILURE;
  try {
    const signature = await access.relay(request.data, request.flags, context);
    return new SshWriter()
      .byte(SshAgentMessage.SignResponse)
      .bytes(signature)
      .build();
  } catch (error) {
    record(asError(error));
    return FAILURE;
  }
}

function serveConnection(
  connection: Socket,
  answer: (message: Buffer) => Promise<Buffer>,
): void {
  let pending = Buffer.alloc(NO_BYTES);
  let queue = Promise.resolve();
  connection.on("error", () => {});
  connection.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= LENGTH_BYTES) {
      const length = pending.readUInt32BE(0);
      if (length === EMPTY_MESSAGE || length > AGENT_MESSAGE_BYTES_MAX) {
        connection.destroy();
        return;
      }
      if (pending.length < LENGTH_BYTES + length) return;
      const message = Buffer.from(
        pending.subarray(LENGTH_BYTES, LENGTH_BYTES + length),
      );
      pending = pending.subarray(LENGTH_BYTES + length);
      queue = queue
        .then(async () => {
          const reply = await answer(message);
          if (!connection.destroyed) connection.write(frame(reply));
        })
        .catch(() => {
          connection.destroy();
        });
    }
  });
}

function closeServer(
  server: Server,
  connections: Set<Socket>,
  relayContext: CancellationContext,
): Promise<void> {
  relayContext.cancel();
  for (const connection of connections) connection.destroy();
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function serveRelayAgent(
  socket: string,
  access: SshRelayAccess,
  context: Context,
): Promise<RelayAgent> {
  assert.ok(socket);
  const blob = sshPublicKeyBlob(access.public_key);
  const connections = new Set<Socket>();
  const relayContext = new CancellationContext(context);
  let lastError: Error | null = null;
  const record = (error: Error) => {
    lastError = error;
  };
  const server = createServer((connection) => {
    connections.add(connection);
    connection.once("close", () => connections.delete(connection));
    serveConnection(connection, (message) =>
      answerOf(message, access, blob, relayContext, record),
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    relayContext.cancel();
    throw error;
  }
  return {
    close: () => closeServer(server, connections, relayContext),
    lastError: () => lastError,
  };
}
