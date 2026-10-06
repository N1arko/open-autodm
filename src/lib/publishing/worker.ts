import { decrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { transportStore, type TransportStore } from "@/lib/transport/store";
import { validateVideoUrl } from "./url";
import {
  PublishingMetaError,
  PUBLISH_TIMEOUT_MS,
  publishingMeta,
  type PublishingMeta,
} from "./meta";

interface Publication {
  id: string;
  claim_token: string;
  status: string;
  account_id: string;
  video_url: string;
  cover_url: string | null;
  caption: string;
  share_to_feed: boolean;
  container_id: string | null;
  media_id: string | null;
  attempts: number;
  metadata_attempts: number;
  lease_expires_at: string;
}
interface Context {
  publication: Publication;
  account: { instagram_user_id: string; access_token_encrypted: string };
}
export interface PublishingPorts {
  encryptionKey: string;
  meta: PublishingMeta;
  validateVideo(url: string): Promise<void>;
}
const log = createLogger("publishing");
async function run(
  store: TransportStore,
  ports: PublishingPorts,
  job: Publication,
) {
  const finish = (state: string, extra: Record<string, unknown> = {}) =>
    store.rpc<boolean>("publishing_finish", {
      p_id: job.id,
      p_token: job.claim_token,
      p_state: state,
      ...extra,
    });
  const context = await store.rpc<Context | null>("publishing_context", {
    p_id: job.id,
    p_token: job.claim_token,
  });
  if (!context) return;
  const p = context.publication;
  let token: string;
  try {
    token = decrypt(
      context.account.access_token_encrypted,
      ports.encryptionKey,
    );
  } catch {
    await finish(p.status === "published" ? "published" : "failed", {
      p_error: "token_decryption_failed",
      p_delay: 3600,
    });
    return;
  }
  if (p.status === "published" && p.media_id) {
    try {
      const link = await ports.meta.permalink(p.media_id, token);
      await finish("published", { p_permalink: link });
    } catch {
      await finish("published", {
        p_error: "permalink_unavailable",
        p_delay: Math.min(3600, 30 * 2 ** p.metadata_attempts),
      });
    }
    return;
  }
  if (!p.container_id) {
    let container: string;
    let urlError = "invalid_video_url";
    try {
      await ports.validateVideo(p.video_url);
      if (p.cover_url) {
        urlError = "invalid_cover_url";
        await ports.validateVideo(p.cover_url);
      }
      container = await ports.meta.create(
        context.account.instagram_user_id,
        p.video_url,
        p.caption,
        p.share_to_feed,
        token,
        p.cover_url ?? undefined,
      );
    } catch (error) {
      const meta = error instanceof PublishingMetaError ? error : null;
      await finish(meta?.retryable ? "processing" : "failed", {
        p_error: meta?.code ?? urlError,
        p_delay: Math.min(900, 15 * 2 ** Math.min(p.attempts, 6)),
      });
      return;
    }
    await finish("processing", { p_container: container, p_delay: 15 });
    return;
  }
  let status: string;
  try {
    status = await ports.meta.status(p.container_id, token);
  } catch (error) {
    const meta = error instanceof PublishingMetaError ? error : null;
    await finish(meta && !meta.retryable ? "failed" : "processing", {
      p_error: meta?.code ?? "meta_status_unavailable",
      p_delay: 60,
    });
    return;
  }
  if (status === "ERROR" || status === "EXPIRED") {
    await finish("failed", { p_error: `container_${status.toLowerCase()}` });
    return;
  }
  if (status === "PUBLISHED") {
    await finish("publication_unknown", {
      p_error: "container_already_published",
    });
    return;
  }
  if (status !== "FINISHED") {
    await finish("processing", { p_delay: 15 });
    return;
  }
  if (
    Date.parse(p.lease_expires_at) <
    Date.now() + PUBLISH_TIMEOUT_MS + 20_000
  ) {
    await finish("processing", { p_delay: 5 });
    return;
  }
  // Commit the publish marker before sending. A lost RPC response is not permission to send.
  if (
    !(await store.rpc<boolean>("publishing_begin_publish", {
      p_id: job.id,
      p_token: job.claim_token,
    }))
  )
    return;
  if (
    Date.parse(p.lease_expires_at) <
    Date.now() + PUBLISH_TIMEOUT_MS + 5_000
  ) {
    await finish("processing", { p_delay: 5 });
    return;
  }
  let media: string;
  try {
    media = await ports.meta.publish(
      context.account.instagram_user_id,
      p.container_id,
      token,
    );
  } catch (error) {
    const meta = error instanceof PublishingMetaError ? error : null;
    await finish(
      !meta || meta.uncertain
        ? "publication_unknown"
        : meta.retryable
          ? "processing"
          : "failed",
      {
        p_error: meta?.code ?? "meta_publish_outcome_unknown",
        p_delay: 900,
      },
    );
    return;
  }
  // Persist the media ID first. Permalink lookup is a separate durable read-only stage.
  await finish("published", { p_media: media, p_delay: 5 });
}
export async function drainPublications(
  store: TransportStore,
  ports: PublishingPorts,
  limit = 4,
) {
  const jobs = await store.rpc<Publication[]>("publishing_claim", {
    p_limit: limit,
  });
  const results = await Promise.allSettled(
    jobs.map((job) => run(store, ports, job)),
  );
  results.forEach((result, i) => {
    if (result.status === "rejected")
      log.warn(
        { publicationId: jobs[i]?.id },
        "Publication interrupted; lease retained",
      );
  });
  return jobs.length;
}
export const processPublicationJobs = (limit = 4) =>
  drainPublications(
    transportStore,
    {
      encryptionKey: getEnv().TOKEN_ENCRYPTION_KEY,
      meta: publishingMeta(),
      validateVideo: validateVideoUrl,
    },
    limit,
  );
