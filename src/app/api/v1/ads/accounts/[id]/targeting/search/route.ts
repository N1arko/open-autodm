import { searchTargeting } from "@/lib/ads/discovery";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return searchTargeting(id)(request);
}
