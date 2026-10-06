# Instagram Insights API

Owner agents can read connected professional accounts' metrics, audience breakdowns and media insights, then compare saved observations without signing into the dashboard.

## Access and setup

Use `Authorization: Bearer adm_<owner credential>` from [AGENT_API.md](AGENT_API.md); owner JWTs also work. `bot_…` credentials cannot use Insights. Each request checks account ownership. Media reads additionally verify Meta's `owner` against the account. When Instagram Login returns a different API-scoped `owner.id`, the same token's `/me` must return that `id` and the account's stored OAuth `user_id`; missing/mismatched ownership fails closed.

Apply `20261005000002_instagram_insights.sql`. Daily collection requires the persistent VPS worker; maintenance cron only prunes snapshots.

Add `instagram_business_manage_insights` to Meta and obtain account consent. `GET /api/instagram/connect?insights=true` generates the OAuth URL; combine with `publishing=true` for both optional scopes. Default OAuth scopes stay unchanged. Generating a URL does not grant permission/connect an account. Existing tokens need renewed consent; Meta access level and app review requirements apply.

## Endpoints

Internal account UUIDs come from `GET /api/instagram/accounts`.

| Method and path                                                    | Purpose                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `GET /api/v1/accounts/{id}/insights?from=YYYY-MM-DD&to=YYYY-MM-DD` | Windowed account totals and current follower/media counts        |
| `GET /api/v1/accounts/{id}/media?limit=25&after={cursor}`          | Owned media IDs, types, timestamps and permalinks; `next_cursor` |
| `GET /api/v1/accounts/{id}/media/{mediaId}/insights`               | Lifetime post/Reel metrics and metadata                          |
| `GET /api/v1/accounts/{id}/insights/audience`                      | Aggregate audience breakdown                                     |
| `GET /api/v1/accounts/{id}/insights/history`                       | Stored observations, 50 per page, `next_cursor`                  |
| `GET /api/v1/accounts/{id}/insights/settings`                      | Daily collection state, last success/error, next run             |
| `PUT /api/v1/accounts/{id}/insights/settings`                      | Replace daily collection configuration                           |

Account/media reads accept optional comma-separated `metrics` (allowlisted, order/duplicates normalized). `refresh=true` bypasses the 15-minute cache. A previous UTC observation day always refreshes. Live reads save/update one snapshot per day for each account/target/query. Provider failure preserves previous snapshots and returns an explicit error.

Account defaults: `views,reach,accounts_engaged,total_interactions,likes,comments,saves,shares,follows_and_unfollows`. Follows/unfollows are requested separately with `follow_type`; provider dimensions are preserved. `profile.followers_count` and `profile.media_count` are current counts at `profile_observed_at`, not historical window-end counts.

Media defaults: `views,reach,likes,comments,saved,shares,total_interactions,ig_reels_avg_watch_time,reposts`. Optional incompatible metrics are isolated while successful metrics remain available. Watch time is Reel-specific. Provider units/dimensions are preserved; no retention curve or undocumented unit conversion is invented. Lookup uses `media_type` (`VIDEO`, `IMAGE`, `CAROUSEL_ALBUM`), avoiding the Instagram Login `media_product_type` restriction.

Audience parameters: `metric=follower_demographics|engaged_audience_demographics`, `breakdown=country|city|age|gender`, `timeframe=this_month|this_week`. Defaults: follower demographics, country, this month. Meta follower/engagement thresholds apply; follower demographics and follows/unfollows require at least 100 followers.

## Dates, availability and history

Account dates are UTC calendar dates: `from` inclusive, `to` exclusive. Default is the preceding seven complete UTC days. Windows must be within the preceding 90 days; tomorrow as `to` includes today's partial window. Invalid dates, inverted/overlong ranges and unknown metrics return `400`. Upstream inclusive `until` is one second before the exclusive boundary.

```json
{
  "account_id": "<internal UUID>",
  "target_id": "<Instagram ID>",
  "query": {
    "kind": "account",
    "metrics": ["views"],
    "from": "2026-10-01",
    "to": "2026-10-05"
  },
  "metrics": [
    { "name": "views", "period": "day", "total_value": { "value": 1234 } }
  ],
  "unavailable_metrics": [],
  "source": "instagram_graph_api",
  "data_delay_hours": 48,
  "fetched_at": "2026-10-05T12:00:00Z",
  "cached": false
}
```

Validated `values` and `total_value.breakdowns` are preserved. `unavailable_metrics` reports `no_data` or `provider_rejected`; missing data never becomes zero. Genuine numeric zero stays zero. Auth `401`, foreign account/media `404`, unavailable/expired/paused account `409`, missing Insights permission `403`, rate limit `429`, provider failure `502`, database failure `503`. Provider text/tokens are not returned/logged by this module. Graph reads use a fixed host, Bearer headers, no redirects, deadlines and bounded bodies.

History filters: `kind=account|media|audience`, `media_id`, `from`, `to`, `cursor`. Dates filter **observation days**, not measurement windows. Default includes today and the preceding six days. Rows contain `id,kind,target_id,query,payload,collected_on,fetched_at`. Pagination is by UUID; sort by observation time for charts. Choose the latest observation of the same query/window rather than adding repeated measurements.

Media counts are lifetime totals; differences give change between observations. Compare average watch times directly. Daily unique reach cannot be summed into weekly unique reach: request the complete weekly window. Paid/organic coverage differs by metric; consult [account metrics](https://developers.facebook.com/documentation/instagram-platform/api-reference/instagram-user/insights) and [media metrics](https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights).

## Daily collection

PUT full replacement JSON:

```json
{ "enabled": true, "media_limit": 10, "retention_days": 90 }
```

`enabled` is required. `media_limit` defaults to 10 (0–50), `retention_days` to 90 (30–730). `media_limit:0` collects account/audience only. Collection starts disabled. Enable after consent: first run due immediately, then every 24 hours after success. Disabling invalidates the active claim. In-flight reads can finish; a cancelled worker cannot save results or change collection state.

Each run revisits the preceding three complete UTC days for delayed account metrics, saves current country audience data, and samples at most `media_limit` items from the first media page, excluding items older than 90 days. Other videos/dimensions remain accessible manually.

Up to two accounts are claimed concurrently, with five-minute leases and four-minute network deadlines. Multiple workers cannot claim the same active account. Read retries recover expired leases; same-day snapshots are upserted. Permission/account errors back off 24 hours; other errors six hours. Partial successful snapshots remain. Check `last_error` and `last_collected_at` for completeness. Outages are not backfilled beyond the three-day revisit window.

Maintenance removes history beyond account retention (90 days without settings). Disabling leaves retained history readable. Larger samples/retention consume more database space; choose bounds for account count and Supabase plan. No video files are stored.

## Verification

Tests cover real PostgreSQL migrations/RPCs, owner/PAT isolation, media ownership, partial metrics, dates, caching, pagination, daily collection, fencing, cleanup and safe errors against HTTP fake Meta. Real grants/Instagram measurements require a separate account-authorized pilot and comparison with its dashboard, allowing reporting delay.
