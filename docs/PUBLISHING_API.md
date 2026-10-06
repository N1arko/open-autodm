# Reels publishing API

An owner or authorized AI agent can publish an existing video to a connected Instagram professional account, immediately or at a specified time. The API creates a durable job; Instagram downloads and processes the video. No video transcoding or file upload is performed by this service.

## Prerequisites

- Apply all migrations, including `20261005000001_reel_publications.sql` and `20261006000001_reel_covers.sql`; run the VPS worker or the secured processing cron.
- Add `instagram_business_content_publish` to the Meta app and obtain the account's consent for that permission. Generate the authorization URL using `GET /api/instagram/connect?publishing=true`; this adds publishing to the existing basic, messages and comments scopes. The default connection remains messaging only. Previously connected accounts need renewed consent. Meta access/review/publication requirements still apply.
- Supply a direct, public HTTPS video URL (port 443), without embedded credentials or fragments. Private/reserved addresses are rejected independently of any internal bot webhook exceptions. The source must remain available when the scheduled job runs and until Instagram finishes processing it. An expiring signed URL must cover that whole interval.
- The video must meet [Meta's Reels publishing requirements](https://www.postman.com/meta/workspace/instagram/documentation/23987686-9386f468-7714-490f-9bfc-9442db5c8f00). Provider validation errors appear on the job. This service does not inspect video codecs before submitting it.

Use `Authorization: Bearer adm_<owner credential>` as described in [AGENT_API.md](AGENT_API.md). Owner session JWTs are also accepted. Integration `bot_…` credentials cannot publish or manage jobs.

## Create a publication

`POST /api/v1/publications` with `Content-Type: application/json` and a required `Idempotency-Key` (1–128 ASCII letters, numbers, `_`, `.`, `:`, `-`).

```json
{
  "account_id": "<internal Instagram account UUID>",
  "video_url": "https://cdn.example.com/video.mp4",
  "cover_url": "https://cdn.example.com/cover.jpg",
  "caption": "New track out now",
  "share_to_feed": true,
  "publish_at": "2026-12-01T18:00:00-03:00"
}
```

`account_id` comes from `GET /api/instagram/accounts`. `caption` defaults to empty and allows 2,200 Unicode characters. `share_to_feed` defaults to true. Omit `publish_at` to run immediately. Dates require `Z` or an explicit UTC offset; the service normalizes them to UTC. Scheduling is supported up to 366 days ahead; processing begins at the requested time, so the actual post may appear later while Instagram processes it. Do not create Instagram containers months in advance: they expire, so containers are created only when the job becomes due.

`cover_url` is optional. Supply a public HTTPS JPEG up to 8 MB, preferably 9:16, which remains available until processing completes. The URL follows the same address, port and credential restrictions as `video_url`, checked at enqueue and again by the worker. Invalid addresses return `400 invalid_cover_url`. Meta checks the actual image format and size. Without a cover URL, Instagram uses its default video thumbnail. Meta may crop the cover for the feed/profile grid. See [Meta's media reference and cover specifications](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media).

`202` returns a publication record with `id`, `account_id`, `video_url`, `cover_url` (null when absent), `caption`, `publish_at`, `share_to_feed`, `status`, `container_id`, `media_id`, `permalink`, `error_code`, attempts and timestamps. It acknowledges the queue, not a published post. Reusing the same key and payload returns the same record. Reusing a key with different content, including the cover URL, returns `409 idempotency_conflict`. Keep keys stable across HTTP retries; never generate a replacement key merely because a request timed out.

## Read and cancel

| Method and path                                            | Result                                                |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `GET /api/v1/publications/{id}`                            | Owner's job and current publishing result             |
| `GET /api/v1/publications?account_id={UUID}&cursor={UUID}` | Up to 50 jobs, optional account filter, `next_cursor` |
| `DELETE /api/v1/publications/{id}`                         | Cancel queued/processing job, preserving its record   |

Cancellation is idempotent. Once the publish request has started (`publishing`), cancellation returns `409 cannot_cancel`. Cancelling a processing job can leave an unused Instagram container; the worker is fenced from publishing it. Published posts are not deleted by this endpoint. Foreign accounts/jobs return `404`, invalid or bot credentials return `401`, inactive/expired accounts return `409 account_unavailable` on creation. Instance outages return `503`.

## Delivery states

| State                 | Meaning                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `queued`              | Scheduled or waiting for worker                                                              |
| `processing`          | Creating/checking the Instagram container; read status again later                           |
| `publishing`          | Durable marker saved before the external publish request                                     |
| `published`           | Meta returned a media ID; permalink is retrieved in a separate background stage              |
| `failed`              | Known rejection, invalid/expired video/container, unavailable account or processing deadline |
| `cancelled`           | Cancelled before publishing started                                                          |
| `publication_unknown` | Publish may have succeeded; inspect Instagram before creating any new job                    |

The worker serializes publication work for each account and uses expiring claims with fencing tokens. It retries container creation and status reads, and known transient/rate-limit rejections with backoff. If a worker crashes after starting a publish, or the publish response is lost, malformed or HTTP 5xx, the job is marked `publication_unknown` and is not automatically resubmitted. A creation retry may leave an unused container but does not publish twice. Account pause/expiry is checked again before the publish marker.

The publish request allows up to 60 seconds for Meta's acknowledgement; the worker checks that its two-minute lease has enough time remaining for the request and result persistence. Metadata reads and container requests retain 20-second deadlines. If the publish result remains uncertain, inspect the live account and confirm the exact media, caption and time before an administrator reconciles the record; never resubmit blindly.

The media ID is stored before permalink lookup. A temporary permalink failure retries only that read, up to eight attempts; `published` can therefore have `permalink:null` with a known `media_id`. Processing stops after 120 attempts or 23 hours past the requested time. Failures are exposed as sanitized error codes; access tokens, captions and video URLs are not logged by the publishing worker. History is retained until the account or owner is removed.

An agent should translate the user's timezone into an explicit offset, submit once, retain the returned job ID, then read status until `published`, `failed`, `cancelled` or `publication_unknown`. Request handling does not wait for Instagram processing. Notifications or recurring content generation are external agent responsibilities.

## Validation

`npm test`, `npm run test:integration`, `npm run typecheck`, `npm run build` cover real PostgreSQL migrations/RPCs, API ownership, scheduling, cancellation races, lease recovery, idempotency and HTTP-level fake Meta publishing. Those checks do not prove a live account grant or real Instagram publication; run a separate account-authorized pilot before relying on production publishing.
