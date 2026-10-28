import { mediaDetails } from "@/lib/engagement/api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
type Context={params:Promise<{id:string;mediaId:string}>};
export async function GET(request: Request, context: Context) {
 const p=await context.params;
 return mediaDetails(p.id,p.mediaId)(request);
}
