import { listResources } from "@/lib/ads/manage";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return listResources((await context.params).id, "catalogs")(request);
}
