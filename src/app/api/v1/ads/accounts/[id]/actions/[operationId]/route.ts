import { getOperation } from "@/lib/ads/manage";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; operationId: string }> },
) {
  const { id, operationId } = await context.params;
  return getOperation(id, operationId)(request);
}
