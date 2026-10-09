import { prepareAction, listOperations } from "@/lib/ads/manage";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return prepareAction(id)(request);
}
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return listOperations(id)(request);
}
