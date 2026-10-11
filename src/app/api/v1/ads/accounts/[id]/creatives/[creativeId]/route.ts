import { getCreative } from "@/lib/ads/discovery";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; creativeId: string }> },
) {
  const { id, creativeId } = await context.params;
  return getCreative(id, creativeId)(request);
}
