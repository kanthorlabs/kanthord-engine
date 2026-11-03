import { INLINE_BYTES_MAX } from "../../mission/contract.ts";

export const ROUND_PATCH_SUBJECT = "Review round patch";
export const ROUND_PATCH_MEDIA_TYPE = "text/x-diff";
const CUT_TRAILER = Buffer.from(
  "\n[The patch exceeds 5 MiB and ends here.]\n",
  "utf8",
);
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION = 0x80;
const NO_BYTES = 0;

export function roundPatchName(round: number, binding: string): string {
  return `round-${round}-${binding}.patch`;
}

export function roundPatchContent(patch: string): Buffer {
  const bytes = Buffer.from(patch, "utf8");
  if (bytes.length <= INLINE_BYTES_MAX) return bytes;
  let end = INLINE_BYTES_MAX - CUT_TRAILER.length;
  while (
    end > NO_BYTES &&
    (bytes[end]! & UTF8_CONTINUATION_MASK) === UTF8_CONTINUATION
  )
    end--;
  return Buffer.concat([bytes.subarray(NO_BYTES, end), CUT_TRAILER]);
}
