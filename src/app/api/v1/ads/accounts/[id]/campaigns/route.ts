import { listAdsObjects } from "@/lib/ads/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return listAdsObjects((await context.params).id, "campaigns")(request);
}
