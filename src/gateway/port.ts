import { performance } from "node:perf_hooks";
import type { MessagePort } from "node:worker_threads";
import type { Logger } from "pino";
import { CancellationContext } from "../kernel/context.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  hasHttpRoute,
  type Operation,
  OperationLifetime,
} from "../kernel/operation.ts";
import { isString } from "../kernel/values.ts";
import { gatewayOperations } from "./contract.ts";
import { workerOperations } from "../worker/contract.ts";
import { schedulerOperations } from "../scheduler/contract.ts";
import { missionOperations } from "../mission/contract.ts";
import { trackingOperations } from "../tracking/contract.ts";
import { bodyLimitOf } from "./body-limit.ts";
import {
  type PortAnswer,
  type PortCall,
  portCallSchema,
  portCancelSchema,
} from "./client.ts";
import { failure, GatewayError } from "./errors.ts";
import type { RecordedResponse } from "./idempotency.ts";
import type { Invocation } from "./invocation.ts";
import { parseJSON } from "./json.ts";
import { resolveRequestId } from "./request-id.ts";

const UNMATCHED_ROUTE = "/*";

const operationsById = new Map<string, Operation>(
  [
    gatewayOperations,
    workerOperations,
    schedulerOperations,
    missionOperations,
    trackingOperations,
  ]
    .flatMap((operations) => Object.values<Operation>(operations))
    .map((operation) => [operation.id, operation]),
);

function absentRoute(requestId: string): RecordedResponse {
  return failure(
    new GatewayError(404, "gateway.routing.not_found", "Route not found."),
    requestId,
  );
}

function routedOperation(id: string): Operation | undefined {
  const operation = operationsById.get(id);
  return operation &&
    hasHttpRoute(operation) &&
    operation.lifetime !== OperationLifetime.Stream
    ? operation
    : undefined;
}

function queryOf(wire: PortCall["query"]): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(wire))
    Object.defineProperty(query, key, { value, enumerable: true });
  return query;
}

async function invokeCall(
  invocation: Invocation,
  credential: () => string | Promise<string>,
  operation: Operation,
  call: PortCall,
  requestId: string,
  context: CancellationContext,
  logger: Logger,
): Promise<RecordedResponse> {
  if (
    call.body !== null &&
    Buffer.byteLength(call.body) > bodyLimitOf(operation)
  )
    return failure(
      new GatewayError(
        413,
        "gateway.request.body_too_large",
        "Request body exceeds the route limit.",
      ),
      requestId,
    );
  let body: unknown = null;
  let rejection: GatewayError | undefined;
  if (operation.body) {
    try {
      body = parseJSON(call.body ?? "");
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      rejection = error;
    }
  } else if (call.body)
    rejection = new GatewayError(
      400,
      "gateway.request.unexpected_body",
      "This operation accepts no request body.",
    );
  const result = await invocation.invoke(
    operation.id,
    { params: call.params, query: queryOf(call.query), body },
    {
      authorization: `Bearer ${await credential()}`,
      idempotencyKey: call.idempotency_key,
      requestId,
      context,
      rejection,
      traceparent: call.traceparent,
      tracestate: call.tracestate,
      logger,
    },
  );
  if (result.status === HttpStatus.NoContent)
    return { status: result.status, body: null };
  if (operation.contentType && result.status === operation.status)
    return { status: result.status, body: String(result.body) };
  return result;
}

export function servePort(
  port: MessagePort,
  invocation: Invocation,
  credential: () => string | Promise<string>,
  logger: Logger,
): void {
  const contexts = new Map<string, CancellationContext>();
  const answer = (callId: string, response: RecordedResponse) => {
    const message: PortAnswer = { call_id: callId, ...response };
    try {
      port.postMessage(message);
    } catch {
      port.postMessage({
        call_id: callId,
        ...failure(
          new GatewayError(
            500,
            "gateway.invocation.invalid_response",
            "Operation returned an invalid response.",
          ),
          resolveRequestId(),
        ),
      } satisfies PortAnswer);
    }
  };
  const abandon = (callId: string, error: unknown) => {
    logger.error({ err: error, call_id: callId }, "Request abandoned");
    try {
      answer(callId, failure(error, resolveRequestId()));
    } catch (answerError) {
      logger.error({ err: answerError, call_id: callId }, "Answer failed");
    }
  };
  const serve = async (call: PortCall) => {
    const requestId = resolveRequestId();
    const operation = routedOperation(call.operation_id);
    const log = logger.child({
      request_id: requestId,
      method: operationsById.get(call.operation_id)?.method,
      route: operation?.path ?? UNMATCHED_ROUTE,
    });
    log.info("Request started");
    const start = performance.now();
    const context = new CancellationContext();
    contexts.set(call.call_id, context);
    let response: RecordedResponse;
    try {
      response = operation
        ? await invokeCall(
            invocation,
            credential,
            operation,
            call,
            requestId,
            context,
            logger,
          )
        : absentRoute(requestId);
    } catch (error) {
      if (!(error instanceof GatewayError))
        logger.error({ err: error, request_id: requestId }, "Request failed");
      response = failure(error, requestId);
    } finally {
      contexts.delete(call.call_id);
      context.cancel();
    }
    log.info(
      { status: response.status, latency: performance.now() - start },
      "Request finished",
    );
    answer(call.call_id, response);
  };
  port.on("message", (message: unknown) => {
    const cancel = portCancelSchema.safeParse(message);
    if (cancel.success) {
      contexts.get(cancel.data.call_id)?.cancel();
      return;
    }
    const call = portCallSchema.safeParse(message);
    if (call.success) {
      const callId = call.data.call_id;
      serve(call.data).catch((error: unknown) => abandon(callId, error));
      return;
    }
    const callId = (message as { call_id?: unknown } | null)?.call_id;
    if (isString(callId))
      answer(
        callId,
        failure(
          new GatewayError(
            400,
            "gateway.request.validation_failed",
            "Request validation failed.",
          ),
          resolveRequestId(),
        ),
      );
  });
  port.on("close", () => {
    for (const context of contexts.values()) context.cancel();
    contexts.clear();
  });
}
