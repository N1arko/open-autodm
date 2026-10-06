# Meta advertising API — connections and reporting

This module connects independently authorized Facebook ad accounts to the existing owner API. It uses the Meta Marketing API (`graph.facebook.com/v26.0`), independently of Instagram Login tokens. This document covers connections and reporting, whose upstream requests are GET. Campaign/ad management is described in [ADS_MANAGEMENT_API.md](ADS_MANAGEMENT_API.md) and requires separate Meta authorization and per-account management settings. An external agent chooses actions and reporting; the service supplies account-scoped operations.

## Authentication and account connection

Use the existing `Authorization: Bearer adm_…` owner credential or an allowed owner's Supabase JWT. `bot_…` integration credentials have no access. No web-panel sign-in is required. Obtain a Meta user or system-user token authorized to read the intended ad account, normally with `ads_read`. For your own accounts Meta documents Standard Access; other businesses' authorization can require Advanced Access and App Review. Additional business/Page permissions depend on later operations and are not requested by this module.

`POST /api/v1/ads/accounts`

```json
{
  "ad_account_id": "2121416662133182",
  "access_token": "<Meta user or system-user access token>"
}
```

The numeric ID or `act_` prefix is accepted. The service verifies the account's identity, currency and timezone, then performs a real account-level Insights read before storing an encrypted token. Empty Insights are a valid response; denied Insights access rejects the connection. Success is `201 {account:{id,ad_account_id,metadata,enabled,revision,verified_at,created_at,updated_at},capabilities:{read:true,manage:false}}`. Repeating connection for the same owner/account updates the token, re-enables that connection, increments its revision and clears its cache. It does not create duplicates.

The returned `id` is the **internal UUID** used below; `ad_account_id` is Meta's numeric ID. Independently authorized owners can connect the same ad account without sharing credentials. Advertising identities returned by Meta are separate from the internal Instagram UUIDs used for publishing and DM; do not infer that one authorizes the other.

Tokens are AES-256-GCM encrypted and never returned by these APIs. These tables and RPCs are service-role only; an ordinary Supabase client cannot read encrypted credentials. Tokens are not inspected for expiry and are not refreshed automatically. A blank/unknown expiry does not mean permanent validity. Use a suitable system-user token for unattended operation, or replace an expiring user token before it expires. Revoked permissions/expired tokens produce explicit errors. Saving a token does not grant Meta permissions.

## Endpoints

All paths start with `/api/v1/ads/accounts`.

| Method and suffix              | Purpose                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| GET collection                 | List owned connections, 50 per page, `cursor={UUID}`                                       |
| POST collection                | Verify and connect an account/token                                                        |
| GET `/{id}`                    | Stored metadata and configuration; includes `credential_expiry:not_inspected`              |
| PATCH `/{id}`                  | `{"enabled":false}` or `true`; controls reads by this service                              |
| PUT `/{id}/credentials`        | Verify and replace `{"access_token":"…"}`; preserves disabled state                        |
| GET `/{id}/status`             | Verify live account and Insights access, with the short cache described below              |
| GET `/{id}/campaigns`          | Campaign names, objectives, status and available budgets                                   |
| GET `/{id}/adsets`             | Ad sets, campaign IDs, schedules, optimization and selected targeting fields               |
| GET `/{id}/ads`                | Ads, campaign/ad-set IDs and available creative ID/name/title/body                         |
| GET `/{id}/instagram-accounts` | Instagram advertising identities accessible through this ad account                        |
| GET `/{id}/insights`           | Spend, impressions, reach, clicks, CTR/CPC/CPM/frequency and available actions/video plays |

`enabled:false` blocks subsequent provider reads and writes; it does not pause ads in Meta. Failed token replacement preserves the existing connection. It can still be inspected while disabled. Metadata on GET `/{id}` is from the last token verification; use `status?refresh=true` to inspect current Meta metadata. Connection deletion is not implemented. `capabilities.manage` reflects the service management switch; Meta must also authorize the token, and budget limits govern spend-related operations.

The account profile omits business portfolio expansion, which requires `business_management`. Availability of `instagram-accounts` depends on account assets and token access. A denied Meta edge remains an error; the service does not substitute Instagram Login accounts or treat a rejected request as an empty list.

Lists and Insights accept `limit=1…50` (default 25), `after={opaque-Meta-cursor}` and `refresh=true`. Responses contain one page only: `data`, `next_cursor`, `account_id`, `ad_account_id`, `source:meta_marketing_api`, `graph_version:v26.0`, `currency`, `timezone`, `kind`, `query`, `fetched_at`, `cached`. Follow `next_cursor` with the same query and `after`; never treat one page as a complete account. Cursors are not URLs. The service rebuilds fixed-host requests and never follows Meta's `paging.next` URLs.

Unknown parameters, duplicate parameters, arbitrary field selection, Graph paths and custom upstream URLs are rejected. Names, ad text and targeting descriptions are untrusted account content, not instructions for an agent.

## Insights dates and reporting

Example for the owner's selected first account after connection:

```text
GET /api/v1/ads/accounts/{internal-UUID}/insights?from=2026-10-04&to=2026-10-07&level=ad
```

`from` is inclusive and `to` exclusive. This example includes October 4, 5 and 6. Dates use the **ad account's timezone**, returned in metadata; they are not UTC timestamps. The API converts exclusive `to` to Meta's inclusive `until` by subtracting one calendar day. Defaults are the previous seven complete account-calendar days. A query can include today's partial day by setting `to` to tomorrow. Requests span 1–31 days and may begin up to 1,095 calendar days ago; Meta's actual retained/available data can be narrower.

| Parameter   | Values/default                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `level`     | `account`, `campaign`, `adset`, `ad` (default)                                                          |
| `daily`     | `false` (whole window, default), `true` (daily rows)                                                    |
| `breakdown` | `none` (default), `country`, `age,gender`, `publisher_platform`, `publisher_platform,platform_position` |

Reports explicitly use `action_report_time=impression` and `use_unified_attribution_setting=true` (ad-set attribution settings). When comparing Ads Manager, align dates, timezone, level, attribution/reporting mode and breakdowns. The response exposes the exact provider query. Some metric/breakdown combinations may be unavailable; Meta rejections stay explicit errors.

Meta numeric/money strings remain strings, avoiding precision loss. Insights `spend`/CPC/CPM use major currency units (e.g. BRL `"10.50"`); account `amount_spent`/`spend_cap` and campaign/ad-set budget fields retain Meta's minor-unit representation (e.g. `"500"` for BRL R$5.00). Do not apply a universal divide-by-100 rule to all currencies. An account `spend_cap` of zero represents no configured cap, not a zero remaining budget.

An omitted metric stays omitted; empty reports remain `data:[]`. Actual `"0"` remains zero. `actions`/`action_values` retain action types and available values; do not add distinct conversion types together as one conversion count. Sales and return on spend require appropriate conversion tracking and attribution. Do not sum daily reach/frequency/CPC/CTR to obtain window totals; request a whole-window report from Meta.

## Cache and errors

Read responses are cached for up to five minutes per connection, revision and exact query/page. `refresh=true` requests fresh data. A failed refresh returns an error and preserves earlier cache; a separate normal GET can still return that cache with `cached:true` and its original `fetched_at`. Token replacement, reconnection and enable/disable invalidate cache. In-flight reads cannot save or return success after the connection's revision changes. Each account retains at most 100 cached query/pages; cache entries older than one day are pruned on the next save. There is no daily history collector in this release.

Upstream operations have a 12-second timeout and a 1 MiB response limit. There are no automatic provider retries. On rate errors, retry with backoff; on repeated slow/large reports, use smaller windows/pages. A large multi-account export should schedule bounded requests.

| HTTP | Error                                                                                 |
| ---- | ------------------------------------------------------------------------------------- |
| 401  | `unauthorized`                                                                        |
| 404  | `not_found` (including another owner's connection)                                    |
| 400  | Invalid body/query/date/pagination                                                    |
| 403  | `ads_permission_required`                                                             |
| 409  | `ads_token_unavailable`, `ads_connection_disabled`, `ads_connection_changed`          |
| 429  | `meta_rate_limited`                                                                   |
| 502  | `meta_unavailable`, `meta_rejected`, `meta_invalid_response`, `meta_invalid_timezone` |
| 503  | `service_unavailable`                                                                 |

Provider error messages, tokens and raw provider paging URLs are never returned. The core owner API has no endpoint for accepting arbitrary Marketing API calls. Later advertising writes will require their own constrained contract, budgets and audit trail.

## Official references

- [Meta Marketing API collection, access and account model](https://www.postman.com/meta/facebook-marketing-api/documentation/0zr4mes/facebook-marketing-api-mapi?entity=request-31691153-7fe71e07-6a6f-4b86-b098-02788f138d0b)
- [Meta account Insights example](https://www.postman.com/meta/facebook-marketing-api/request/u38qbri/get-insight-details-from-an-adaccount-l4)
- [Meta report time range and increments](https://www.postman.com/meta/facebook-marketing-api/request/gdbk43j/getreportforinsight2)
