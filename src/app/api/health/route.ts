import { createServiceClient } from "@/lib/supabase/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const db = createServiceClient();
    const checks = await Promise.all([
      db.from("bot_transport_jobs").select("id").limit(0),
      db.from("instagram_publications").select("id").limit(0),
    ]);
    const error = checks.some((check) => check.error);
    return Response.json(
      { status: error ? "unavailable" : "ok" },
      { status: error ? 503 : 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
