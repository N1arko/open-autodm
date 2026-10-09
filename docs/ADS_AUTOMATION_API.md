# Advertising resources and background optimization

Use the existing owner API credential and connection UUID. This extends [campaign management](ADS_MANAGEMENT_API.md). Integration credentials starting `bot_` cannot manage advertising. There is no requirement to log into the dashboard.

## Resource inventory

Owner GET endpoints under `/api/v1/ads/accounts/{connection-UUID}`:

| Path | Meaning |
| --- | --- |
| `/assets/pixels` | Pixels available to this ad account |
| `/assets/pixels/{Meta-pixel-ID}/code` | Installation code, after checking account access |
| `/assets/audiences` | Custom, website, engagement and lookalike audiences |
| `/assets/catalogs?business_id={ID}` | Catalogs owned by the linked business |
| `/assets/products?business_id={ID}&catalog_id={ID}` | Products in an owned catalog |
| `/assets/productsets?business_id={ID}&catalog_id={ID}` | Product sets in an owned catalog |
| `/credentials/status?refresh=true` | Live token validity, expiry and permission inspection |
| `/optimization/rules` | Rules, next execution, last error and enablement |
| `/optimization/rules/{rule-UUID}/runs` | Decision evidence, proposed actions and operation receipts |

Inventory pages contain at most 50 rows and return `next_cursor`; supply it as `after`. Rules and run histories use `cursor` instead. Unknown and duplicate query parameters are rejected. A business must own/manage the selected ad account; its catalog must appear in `owned_product_catalogs`. Product and set mutations additionally require membership in the supplied catalog. Shared/client catalogs are deliberately excluded from this first release. Reads do not grant write privileges.

## Resource mutations

Use the same `POST /actions` preparation, `Idempotency-Key` and `POST /actions/{operation-UUID}/execute` protocol as campaign management. Fresh membership is checked at preparation and again before execution. These actions do not activate ads or change advertising budgets. They require management enabled and actual owner authorization for the requested resource changes.

| Action | Parameters |
| --- | --- |
| `pixel.create` | `name` |
| `pixel.update` | top-level `object_id`; `name` |
| `audience.create` | `name`, `subtype`, optional `description`, `retention_days`, source/spec fields below |
| `audience.update` | `object_id`; any of `name`, `description`, `retention_days` |
| `audience.users.add` | `object_id`; `data_use_authorized:true`, `payload:{schema,data}` below |
| `catalog.create` | `business_id`, `name`, `vertical:"commerce"` |
| `catalog.update` | `object_id`; `business_id`, `name` |
| `product.create` | `business_id`, `catalog_id`, `retailer_id`, product fields below |
| `product.update` | `object_id`; `business_id`, `catalog_id`, editable product fields |
| `productset.create` | `business_id`, `catalog_id`, `name`, Meta `filter` expression |
| `productset.update` | `object_id`; `business_id`, `catalog_id`, `name` and/or `filter` |

Product fields: `name`, `description`, public HTTPS `image_url` and `url`, integer `price` in currency minor units, three-letter `currency`, `availability`, `condition`, `brand`, optional nonnegative `inventory`. Availability accepts `in stock`, `out of stock`, `preorder`, `available for order`, `discontinued`; condition accepts `new`, `refurbished`, `used`. Price and stock updates can affect ads already using the catalog; obtain an actual owner instruction first. This release does not create dynamic catalog ad templates, shops, scheduled feeds, lead forms, custom conversions, Conversions API event forwarding or business asset assignments. Pixel creation supplies an ID/code; installation and event verification on a particular website require a separate task naming that website.

Audience subtypes:

- `WEBSITE`: requires an account-accessible `pixel_id` and Meta `rule` expression.
- `LOOKALIKE`: requires account-owned `origin_audience_id` and `lookalike_spec:{country:"BR",ratio:0.01,type:"similarity"}`. Special-category restrictions still apply.
- `ENGAGEMENT`/`VIDEO`: requires a Meta `rule` expression describing the permitted source and event.
- `CUSTOM`: requires `customer_file_source` (`USER_PROVIDED_ONLY`, `PARTNER_PROVIDED_ONLY` or `BOTH_USER_AND_PARTNER_PROVIDED`). Meta may require the owner to accept its Custom Audience terms; the service never accepts them on behalf of the owner.

For `audience.users.add`, normalize and SHA-256-hash contact values locally using Meta's hashing specification. `schema` is `["EMAIL"]`, `["PHONE"]` or both, with matching rows of lowercase 64-character hex hashes; at most 40 rows per request within the 8 KiB API limit. Raw emails/phones are rejected. `data_use_authorized:true` must reflect the owner's actual instruction and the right to upload this particular data to Meta. This flag is not evidence of consent by itself. Hashes remain sensitive data: prepared operations/history store their exact payload in service-only SQL. Do not place payloads in public logs or reports. The receipt contains received/invalid counts; inspect them rather than assuming every row matched.

Meta **does not provide validate_only for these resource operations** in this integration. `/actions/validate` returns `400 resource_validation_unavailable`; it never substitutes a real creation for validation. A locally prepared plan confirms schema, scope and dependencies; Meta can still reject the actual write. Timeout/5xx/malformed acknowledgment remains `uncertain`; inspect the provider before any manual retry.

The endpoints/fields follow Meta's [official SDK](https://github.com/facebook/facebook-python-business-sdk/tree/main/facebook_business/adobjects). Ordinary pixel/audience calls use advertising permissions; business/catalog calls also require `business_management`, `catalog_management` and the relevant asset access. Permission review, business ownership and restrictions are Meta decisions.

## Durable background rules

The server worker polls every minute and evaluates due enabled rules. It does not call an LLM: an external AI agent translates the owner's strategy into explicit rules, reads the decision history and revises the configuration when instructed. Recurring free-form agent reasoning/creative experiments are separate orchestration. No default rules, campaigns, budget limits or paid advertising are enabled by deployment.

Create with `POST /optimization/rules`, replace the complete configuration with `PUT /optimization/rules/{rule-UUID}`:

```json
{
  "config": {
    "name": "Pause expensive purchases",
    "enabled": false,
    "mode": "observe",
    "level": "ad",
    "object_ids": ["<Meta ad ID>"],
    "window_days": 3,
    "interval_seconds": 3600,
    "cooldown_seconds": 86400,
    "max_changes_per_day": 1,
    "min_spend_minor": "3000",
    "min_impressions": 1000,
    "min_results": 3,
    "condition": {"metric":"cpa_minor","operator":"gt","threshold":1500,"action_type":"purchase"},
    "action": {"kind":"pause"}
  },
  "authorize_changes": false
}
```

These numbers are examples, not authorization or deployment defaults. `enabled:true,mode:"observe"` writes decision evidence and proposed actions only. `mode:"execute"` with enablement also requires `authorize_changes:true`, management enabled, and the owner's actual standing authorization for the exact rule. The flag does not prove a human approved the strategy. Budget rules additionally require an owner-set daily policy cap; their maximum cannot exceed that cap. Disabling a rule uses `PUT` with `enabled:false`; it prevents future automatic actions without pausing live advertising. Editing/disabling during an executing mutation is rejected until its receipt is committed.

Levels: `campaign`, `adset`, `ad`, with 1–25 explicit account-owned IDs per rule. Up to 100 rules per account. Supported conditions: `spend_minor`, `cpa_minor`, `roas`, `ctr`, `cpc_minor`, `frequency`, `clicks`, `impressions`; operators `gt`, `gte`, `lt`, `lte`. `cpa_minor` and `roas` require an explicit Meta `action_type`. ROAS uses revenue/spend, CTR uses Meta percent units. Unknown values and insufficient samples do not authorize changes. Zero conversions do not produce a fabricated infinite CPA; use a spend rule for a no-conversion guard. Insights use the preceding 1–30 complete days in the ad account's timezone, unified attribution and conversion report time, without breakdown duplication; late conversions can revise a later observation. Reports are read fresh, never from the five-minute service cache.

Actions:

- `{"kind":"pause"}` pauses an active campaign/adset/ad.
- `{"kind":"adjust_daily_budget","percent":20,"min_budget_minor":"1000","max_budget_minor":"5000"}` changes a campaign/adset daily budget. Percent is −50…+20, nonzero. It requires the selected object to have its own daily budget, rejects lifetime budgets, clamps within the rule bounds, and never reverses the requested direction when an external edit moved the budget outside the bounds. It never activates a paused object. Prefer campaign IDs for CBO, adset IDs for ABO.

Rules require minimum spend and impressions and may require minimum results. Cooldown is at least 24 hours per object, including across rule edits. The maximum changes limit counts reserved writes in the rolling previous 24 hours, including failed/ambiguous attempts; this avoids retries amplifying changes. Multiple workers claim a rule once with a six-minute lease. Long/incomplete inventories (over 500 aggregate rows) block optimization. Fresh account, policy, dependencies, campaign/ABO aggregate limits and rule revision/lease are checked before every write. Rule edits or disabling fence prepared actions. A conflicting manual action serializes with automation through the same operations lock.

An ambiguous execution disables that rule and records `automation_execution_uncertain`; a crashed worker's stale executing operation also disables its rule. There is no automatic resend or reactivation. Inspect the linked operation and Meta before explicitly enabling a revised rule. These limits apply to configured campaign budgets; they are **not an overall account spending cap or a guarantee of billed daily spend**. Changes outside this service still require monitoring.

## Durable access and credential health

`GET /credentials/status?refresh=true` returns live validity, token type, token/data-access expiry, `renewal_required_by`, scopes and named permissions. The worker stores a sanitized daily inspection, with a warning status seven days before the first applicable expiry. The endpoint normally reuses a snapshot under 24 hours old. Token rotation invalidates old metadata by connection revision. No token or app secret is returned. Unavailable inspection is explicit and is not treated as a valid token. No unsolicited messages are sent.

The credential replacement endpoint already accepts Meta system-user tokens: `PUT /credentials {"access_token":"…"}` verifies account/Insights access and encrypts the token. For durable operation, assign a system user the app, required account and relevant Page/Instagram/catalog/pixel assets, and request the required permissions. Choose no scheduled expiry only if Meta offers it. Token permissions and asset grants must be verified again before replacement and before the first paid launch.

Meta's [official Marketing API collection](https://www.postman.com/meta/facebook-marketing-api/documentation/0zr4mes/facebook-marketing-api-mapi?entity=request-31691153-7fe71e07-6a6f-4b86-b098-02788f138d0b) describes user and system-user tokens and their expiry options. The service does not manufacture or silently refresh an expired Facebook user token. Even a system-user token without a scheduled expiry can be revoked or lose permissions; credential monitoring and provider preflight remain necessary. Business/app association, system-user creation, extra scopes and persistent asset access are separate owner-approved Meta setup steps.

## Validation evidence

Local tests exercise the real ephemeral PostgreSQL migrations/RPCs, actual owner auth adapters and a local HTTP Graph fixture. They cover resource ownership/business/catalog membership, rechecking before write, payload redaction, explicit rule enablement, observations without writes, concurrent leases, cooldown/day quotas, budget caps, disable/edit fencing and uncertain-write cancellation. Fixture tests verify protocol behavior; they do not assert that Meta accepted production resource creation. Live deployment checks must separately confirm API health, anonymous rejection, credential status, inventory reads, empty rules and unchanged budgets/scheduled publications.
