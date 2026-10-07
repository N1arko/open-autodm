import { listRuleRuns } from "@/lib/ads/optimization";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; ruleId: string }> },
) {
  const { id, ruleId } = await context.params;
  return listRuleRuns(id, ruleId)(request);
}
