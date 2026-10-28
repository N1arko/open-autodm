import { inboxConversations } from "@/lib/engagement/api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=120;
type Context={params:Promise<{id:string}>};
export async function GET(r:Request,c:Context) {const p=await c.params;return inboxConversations(p.id)(r);}
