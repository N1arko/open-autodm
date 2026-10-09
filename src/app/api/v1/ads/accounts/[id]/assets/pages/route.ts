import { listAssets } from "@/lib/ads/manage";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return listAssets(id, "pages")(request);
}
