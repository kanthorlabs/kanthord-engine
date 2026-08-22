import { Buffer } from "node:buffer";

import type { Handler } from "../app.ts";
import { blobHash } from "../../../domain/blob.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidPathParameter } from "../invalid-request.ts";
import type { BlobView } from "../../../queries/blob/show-blob.ts";
import { parseRange } from "./range.ts";

export type ShowBlobHandlerDependencies = Readonly<{
  showBlob: (input: Readonly<{ hash: string }>) => BlobView | null;
}>;

export function showBlobHandler(
  dependencies: ShowBlobHandlerDependencies,
): Handler {
  return (context) => {
    const hash = context.parameters["hash"];
    if (hash === undefined) {
      throw invalidPathParameter("no blob hash in the request path", "hash");
    }
    if (!blobHash.safeParse(hash).success) {
      throw invalidPathParameter(`${hash} is not a blob hash`, "hash");
    }
    const record = dependencies.showBlob({ hash });
    if (record === null) {
      throw httpError("not-found", `no blob ${hash}`);
    }
    const content = Buffer.from(record.content);
    const headers = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, immutable, max-age=31536000",
      "Content-Type": "application/octet-stream",
      ETag: `"${record.hash}"`,
    };
    const range = parseRange(context.headers["range"], content.length);
    if (range === null) {
      return { status: 200, body: content, headers };
    }
    return {
      status: 206,
      body: content.subarray(range.start, range.end + 1),
      headers: {
        ...headers,
        "Content-Range": `bytes ${range.start}-${range.end}/${content.length}`,
      },
    };
  };
}
