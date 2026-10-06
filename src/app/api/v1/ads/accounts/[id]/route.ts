import { getAdsAccount, updateAdsAccount } from "@/lib/ads/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  return getAdsAccount((await context.params).id)(request);
}
export async function PATCH(request: Request, context: Context) {
  return updateAdsAccount((await context.params).id)(request);
}
