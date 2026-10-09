import { setRule } from "@/lib/ads/optimization";
export const runtime = "nodejs";
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string; ruleId: string }> },
) {
  const { id, ruleId } = await context.params;
  return setRule(id, ruleId)(request);
}
