import { connectAdsAccount, listAdsAccounts } from "@/lib/ads/api";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = listAdsAccounts();
export const POST = connectAdsAccount();
