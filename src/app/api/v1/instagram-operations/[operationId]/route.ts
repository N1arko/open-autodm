import { cancelOperation, getOperation } from "@/lib/engagement/api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{operationId:string}>};
export async function GET(request: Request, context: Context) {
 const p=await context.params;
 return getOperation(p.operationId)(request);
}
export async function DELETE(request: Request, context: Context) {
 const p=await context.params;
 return cancelOperation(p.operationId)(request);
}
