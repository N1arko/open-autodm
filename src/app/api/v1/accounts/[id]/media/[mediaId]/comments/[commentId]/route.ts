import { getComment } from "@/lib/engagement/api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{id:string;mediaId:string;commentId:string}>};
export async function GET(request: Request, context: Context) {
 const p=await context.params;
 return getComment(p.id,p.mediaId,p.commentId)(request);
}
