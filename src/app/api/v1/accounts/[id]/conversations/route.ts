import { listConversations } from "@/lib/engagement/api";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(r:Request,c:{params:Promise<{id:string}>}) {return listConversations((await c.params).id)(r);}
