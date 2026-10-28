import { type ExecutionTrace, SpanStatus } from "../tracking/contract.ts";
import { type UploadCheckFailure, UploadCheckSpan } from "./contract.ts";

const END_RECORD = "end";

export function uploadCheckSpan(
  trace: ExecutionTrace,
  failure: UploadCheckFailure,
  spanId: string,
) {
  return {
    record_id: `${spanId}:${END_RECORD}`,
    span_id: spanId,
    parent_span_id: trace.root_span_id,
    operation: UploadCheckSpan.Operation,
    start_time: failure.failed_at,
    end_time: failure.failed_at,
    status: SpanStatus.Error,
    attributes: {
      [UploadCheckSpan.AssetId]: failure.asset_id,
      [UploadCheckSpan.StorageBindingId]: failure.storage_binding_id,
      [UploadCheckSpan.ErrorType]: failure.code,
    },
  };
}
