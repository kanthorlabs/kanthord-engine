import type { Transaction } from "../kernel/store.ts";
import {
  AssetKind,
  CODER_REPORT_SUBJECT,
  CONTENT_ENCODING,
} from "./contract.ts";
import { inlineSchema } from "./evidence-content-read.ts";
import { listEvidence, readAssets } from "./record-store.ts";

const PAGE_SIZE = 50;
const NO_CURSOR = null;

export function coderReportOf(
  tx: Transaction,
  nodeId: string,
  attempt: number,
): string | null {
  let after: string | null = NO_CURSOR;
  for (;;) {
    const page = listEvidence(tx, nodeId, attempt, after, PAGE_SIZE);
    const report = page.find((row) => row.subject === CODER_REPORT_SUBJECT);
    if (report) return inlineTextOf(tx, report.id);
    if (page.length < PAGE_SIZE) return null;
    after = page[page.length - 1]!.id;
  }
}

function inlineTextOf(tx: Transaction, evidenceId: string): string | null {
  const asset = readAssets(tx, evidenceId).find(
    (item) => item.kind === AssetKind.Produced,
  );
  if (!asset) return null;
  const inline = inlineSchema.safeParse(JSON.parse(asset.content));
  if (!inline.success) return null;
  return Buffer.from(inline.data.data, CONTENT_ENCODING).toString("utf8");
}
