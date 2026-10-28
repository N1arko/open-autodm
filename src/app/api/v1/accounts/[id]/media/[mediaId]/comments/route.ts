import { commentWrite, enqueueAction, listComments } from "@/lib/engagement/api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{id:string;mediaId:string}>};
export async function GET(request: Request, context: Context) {
 const p=await context.params;
 return listComments(p.id,p.mediaId)(request);
}
export async function POST(request: Request, context: Context) {
 const p=await context.params;
 return commentWrite(request,p.id,p.mediaId,undefined);
}
