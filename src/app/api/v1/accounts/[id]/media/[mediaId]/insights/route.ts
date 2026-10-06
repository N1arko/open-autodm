import { getMediaInsights } from "@/lib/insights/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; mediaId: string }> },
) {
  const { id, mediaId } = await context.params;
  return getMediaInsights(id, mediaId)(request);
}
