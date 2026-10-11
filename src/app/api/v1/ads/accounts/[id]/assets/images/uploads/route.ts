import { stageImage } from "@/lib/ads/uploads";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return stageImage(id)(request);
}
