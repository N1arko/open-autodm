import { getInsightsSettings, setInsightsSettings } from "@/lib/insights/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return getInsightsSettings((await context.params).id)(request);
}
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return setInsightsSettings((await context.params).id)(request);
}
