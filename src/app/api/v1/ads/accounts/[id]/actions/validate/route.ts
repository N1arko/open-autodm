import { validateAction } from "@/lib/ads/manage";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return validateAction(id)(request);
}
