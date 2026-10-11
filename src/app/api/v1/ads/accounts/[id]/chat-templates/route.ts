import { readTemplates, saveTemplate } from "@/lib/ads/templates";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return readTemplates(id)(request);
}
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return saveTemplate(id)(request);
}
