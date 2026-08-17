import { nodeReportResponse } from "../../http/contract/outcome.ts";

export function printNodeReportView(
  stdout: (text: string) => void,
  body: unknown,
): void {
  const view = nodeReportResponse.parse(body);
  stdout(`kanthord: reported ${view.nodeId} ${view.state}\n`);
}
