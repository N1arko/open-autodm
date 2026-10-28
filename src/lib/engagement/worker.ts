import { createLogger } from "@/lib/logger";
import { ApiError } from "@/lib/transport/api";
import { actionSchema } from "./input";
import { EngagementError } from "./meta";
import {
  context,
  guard,
  verify,
  defaultEngagementPorts,
  type EngagementPorts,
} from "./service";
export interface Operation {
  id: string;
  user_id: string;
  account_id: string;
  action: string;
  input: Record<string, unknown>;
  claim_token: string;
  attempts: number;
  lease_expires_at: string;
}
const log = createLogger("instagram-operations");
async function run(job: Operation, p: EngagementPorts) {
  const finish = (
    state: string,
    error: string | null = null,
    receipt: unknown = null,
    delay = 60,
  ) =>
    p.store.rpc<boolean>("instagram_finish", {
      p_id: job.id,
      p_token: job.claim_token,
      p_state: state,
      p_error: error,
      p_receipt: receipt,
      p_delay: delay,
    });
  const parsed = actionSchema.safeParse({ ...job.input, action: job.action });
  if (!parsed.success) {
    await finish("failed", "invalid_action");
    return;
  }
  if (job.attempts > 12) {
    await finish("failed", "retry_exhausted");
    return;
  }
  const a = parsed.data;
  let token: string;
  try {
    const c = await context(job.user_id, job.account_id, p);
    token = c.token;
    await guard(a, c.account.instagram_user_id, token, p.meta);
  } catch (e) {
    const retry =
      e instanceof EngagementError
        ? e.retryable
        : e instanceof ApiError
          ? e.status === 429 || e.status >= 500
          : true;
    await finish(
      retry ? "queued" : "failed",
      e instanceof ApiError ? e.message : "preflight_unavailable",
      null,
      Math.min(3600, 60 * 2 ** job.attempts),
    );
    return;
  }
  if (
    !(await p.store.rpc<boolean>("instagram_begin", {
      p_id: job.id,
      p_token: job.claim_token,
    }))
  )
    return;
  let receipt: Record<string, unknown>;
  try {
    receipt = await p.meta.execute(a, token);
  } catch (e) {
    const known = e instanceof EngagementError && !e.uncertain;
    await finish(
      !known ? "unknown" : e.retryable ? "queued" : "failed",
      e instanceof EngagementError ? e.message : "meta_outcome_unknown",
      null,
      e instanceof EngagementError ? (e.retryAfterSeconds ?? 300) : 300,
    );
    return;
  }
  // Save the acknowledgement before any fallible read. A lost save acknowledgement never repeats the write.
  receipt = {
    ...receipt,
    verified: false,
    acknowledged_at: new Date().toISOString(),
  };
  if (!(await finish("succeeded", null, receipt))) return;
  try {
    const result = await verify(
      a,
      token,
      p.meta,
      typeof receipt.external_id === "string" ? receipt.external_id : undefined,
    );
    await p.store.rpc("instagram_reconcile", {
      p_user: job.user_id,
      p_id: job.id,
      p_receipt: {
        ...receipt,
        ...result,
        checked_at: new Date().toISOString(),
      },
    });
  } catch {
    /* Receipt remains available for explicit read-only reconciliation. */
  }
}
export async function drainInstagram(p = defaultEngagementPorts(), limit = 4) {
  const jobs = await p.store.rpc<Operation[]>("instagram_claim", {
    p_limit: limit,
  });
  const results = await Promise.allSettled(jobs.map((j) => run(j, p)));
  results.forEach((r, i) => {
    if (r.status === "rejected")
      log.warn(
        { operationId: jobs[i]?.id },
        "Instagram operation interrupted; lease retained",
      );
  });
  return jobs.length;
}
