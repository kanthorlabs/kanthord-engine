import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
import { stopAfter } from "../../kernel/stop-test-support.ts";

const RESPONSE_ID_PREFIX = "resp_";
const ITEM_ID_PREFIX = "item_";
const CALL_ID_PREFIX = "call_";
const ASSISTANT_ROLE = "assistant";
const OUTPUT_TEXT_TYPE = "output_text";
const MESSAGE_TYPE = "message";
const FUNCTION_CALL_TYPE = "function_call";
const COMPLETED_STATUS = "completed";
const TYPEOF_STRING = "string";
const HTTP_ERROR_KIND = "http_error";
const TEXT_TURN_KIND = "text";
const NO_DELAY_MS = 0;

export type StubUsage = { input: number; output: number };

export type StubTextTurn = {
  kind: "text";
  text: string;
  usage?: StubUsage;
  delayMs?: number;
};

export type StubToolCall = { name: string; args: Record<string, unknown> };

export type StubToolCallTurn = {
  kind: "tool_calls";
  calls: StubToolCall[];
  usage?: StubUsage;
};

export type StubHttpErrorTurn = {
  kind: "http_error";
  status: number;
  body: string;
};

export type StubTurn = StubTextTurn | StubToolCallTurn | StubHttpErrorTurn;

export type StubRequestRecord = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};

export interface LlmStubOptions {
  fixedStatus?: { status: number; body: string };
}

export interface LlmStub {
  baseUrl: string;
  requests: StubRequestRecord[];
  connectionCount: () => number;
}

function sseEvent(event: object): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function completedEvent(
  responseId: string,
  usage: StubUsage | undefined,
): object {
  const response: Record<string, unknown> = {
    id: responseId,
    status: COMPLETED_STATUS,
  };
  if (usage !== undefined) {
    response["usage"] = {
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.input + usage.output,
    };
  }
  return { type: "response.completed", response };
}

function textTurnEvents(
  turn: StubTextTurn,
  index: number,
  testDir: string,
): string {
  const responseId = `${RESPONSE_ID_PREFIX}${index}`;
  const itemId = `${ITEM_ID_PREFIX}${index}`;
  const text = turn.text.replaceAll("$TEST", testDir);
  const item = {
    type: MESSAGE_TYPE,
    id: itemId,
    role: ASSISTANT_ROLE,
    status: COMPLETED_STATUS,
    content: [],
  };
  const doneItem = {
    ...item,
    content: [{ type: OUTPUT_TEXT_TYPE, text, annotations: [] }],
  };
  const events = [
    sseEvent({ type: "response.created", response: { id: responseId } }),
    sseEvent({
      type: "response.output_item.added",
      output_index: 0,
      item,
    }),
    sseEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: doneItem,
    }),
    sseEvent(completedEvent(responseId, turn.usage)),
  ];
  return events.join("");
}

function toolCallsTurnEvents(
  turn: StubToolCallTurn,
  index: number,
  testDir: string,
): string {
  const responseId = `${RESPONSE_ID_PREFIX}${index}`;
  const eventParts: string[] = [
    sseEvent({ type: "response.created", response: { id: responseId } }),
  ];
  turn.calls.forEach(({ name, args }, callIndex) => {
    const itemId = `${ITEM_ID_PREFIX}${index}_${callIndex}`;
    const callId = `${CALL_ID_PREFIX}${index}_${callIndex}`;
    const resolvedArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      resolvedArgs[k] =
        typeof v === TYPEOF_STRING
          ? (v as string).replaceAll("$TEST", testDir)
          : v;
    }
    const argsText = JSON.stringify(resolvedArgs);
    const item = {
      type: FUNCTION_CALL_TYPE,
      id: itemId,
      call_id: callId,
      name,
      arguments: "",
    };
    eventParts.push(
      sseEvent({
        type: "response.output_item.added",
        output_index: callIndex,
        item,
      }),
    );
    eventParts.push(
      sseEvent({
        type: "response.output_item.done",
        output_index: callIndex,
        item: { ...item, arguments: argsText },
      }),
    );
  });
  eventParts.push(sseEvent(completedEvent(responseId, turn.usage)));
  return eventParts.join("");
}

export async function llmStub(
  t: TestContext,
  turns: StubTurn[],
  testDir: string,
  options: LlmStubOptions = {},
): Promise<LlmStub> {
  const requests: StubRequestRecord[] = [];
  let callIndex = 0;
  let connections = 0;

  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as unknown;
      const headers = req.headers as Record<
        string,
        string | string[] | undefined
      >;
      requests.push({ headers, body });

      if (options.fixedStatus !== undefined) {
        const { status, body: fixedBody } = options.fixedStatus;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(fixedBody);
        return;
      }

      const turn = turns[callIndex];
      callIndex += 1;

      if (turn === undefined) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: "no more scripted turns" } }),
        );
        return;
      }

      if (turn.kind === HTTP_ERROR_KIND) {
        res.writeHead(turn.status, { "content-type": "application/json" });
        res.end(turn.body);
        return;
      }

      const turnIndex = callIndex - 1;
      const delayMs =
        turn.kind === TEXT_TURN_KIND
          ? (turn.delayMs ?? NO_DELAY_MS)
          : NO_DELAY_MS;
      const respond = (): void => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (turn.kind === TEXT_TURN_KIND) {
          res.end(textTurnEvents(turn, turnIndex, testDir));
        } else {
          res.end(toolCallsTurnEvents(turn, turnIndex, testDir));
        }
      };
      if (delayMs > NO_DELAY_MS) {
        const timer = setTimeout(respond, delayMs);
        res.on("close", () => {
          clearTimeout(timer);
        });
      } else {
        respond();
      }
    });
  });

  server.on("connection", () => {
    connections += 1;
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stopAfter(t, () => {
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    connectionCount: () => connections,
  };
}
