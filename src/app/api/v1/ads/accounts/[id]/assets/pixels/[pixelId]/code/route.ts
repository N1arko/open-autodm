import { getPixelCode } from "@/lib/ads/manage";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; pixelId: string }> },
) {
  const { id, pixelId } = await context.params;
  return getPixelCode(id, pixelId)(request);
}
