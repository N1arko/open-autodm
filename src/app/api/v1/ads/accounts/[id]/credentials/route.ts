import { rotateAdsToken } from "@/lib/ads/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function PUT(request: Request, context: Context) {
  return rotateAdsToken((await context.params).id)(request);
}
