import { createServiceClient } from "@/lib/supabase/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const db = createServiceClient();
    const checks = await Promise.all([
      db.from("instagram_operations").select("id").limit(0),
      db.from("instagram_events").select("id").limit(0),
      db.from("instagram_materials").select("id").limit(0),
      db.from("bot_transport_jobs").select("id").limit(0),
      db.from("instagram_publications").select("id,media_type,items,child_container_ids,first_comment_operation_id,revision,trial_params").limit(0),
      db.from("instagram_insights_snapshots").select("id").limit(0),
      db.from("instagram_insights_settings").select("account_id").limit(0),
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
