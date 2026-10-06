import { executeAction } from "@/lib/ads/manage";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; operationId: string }> },
) {
  const { id, operationId } = await context.params;
  return executeAction(id, operationId)(request);
}
