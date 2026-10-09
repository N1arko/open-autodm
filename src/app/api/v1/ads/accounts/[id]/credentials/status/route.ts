import { credentialStatus } from "@/lib/ads/credentials";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return credentialStatus((await context.params).id)(request);
}
