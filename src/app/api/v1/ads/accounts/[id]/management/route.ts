import { getManagement, setManagement } from "@/lib/ads/manage";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return getManagement(id)(request);
}
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return setManagement(id)(request);
}
