import { getAccountInsights } from "@/lib/insights/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return getAccountInsights((await context.params).id)(request);
}
