import { getPageInstagram } from "@/lib/ads/discovery";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; pageId: string }> },
) {
  const { id, pageId } = await context.params;
  return getPageInstagram(id, pageId, true)(request);
}
