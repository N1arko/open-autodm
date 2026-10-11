import {
  readTemplates,
  saveTemplate,
  archiveTemplate,
} from "@/lib/ads/templates";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string; templateId: string }> },
) {
  const { id, templateId } = await context.params;
  return readTemplates(id, templateId)(request);
}
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string; templateId: string }> },
) {
  const { id, templateId } = await context.params;
  return saveTemplate(id, templateId)(request);
}
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; templateId: string }> },
) {
  const { id, templateId } = await context.params;
  return archiveTemplate(id, templateId)(request);
}
