# Результаты рекламы для агента

Расширение существующего `GET /api/v1/ads/accounts/{connection-UUID}/insights` сохраняет прежние поля и добавляет Instagram results, стоимости и состояния доступности. Авторизация и даты — в [ADS_API.md](ADS_API.md). Расширение выпущено 12 октября 2026; действующую установку проверяйте по её ответу и серверному `.release.json`.

## Запрос и динамика

```text
GET /api/v1/ads/accounts/{UUID}/insights?from=2026-10-11&to=2026-10-13&level=campaign&campaign_id=120254181403080057&refresh=true
```

Дни: добавьте `daily=true`. Материалы кампании: `level=ad&campaign_id={Meta-ID}`. Группа: `level=adset&adset_id={Meta-ID}`. Одно объявление: `level=ad&ad_id={Meta-ID}`. `level=account` возвращает агрегат Meta кабинета или отфильтрованной части. Допускается один из `campaign_id`, `adset_id`, `ad_id` — числовой Meta ID; фиксированный фильтр `campaign.id`/`adset.id`/`ad.id` с `IN`. Произвольные filtering/fields/Graph paths закрыты.

`action_report_time=impression|conversion|mixed`, default `impression`; `use_unified_attribution_setting=true` сохраняет настройки ad sets. Период использует timezone кабинета, `from` включительно, `to` исключительно. Пример включает 11 и 12 октября. Whole-window строку и дневные строки запрашивайте отдельно.

`reporting.includes_partial_current_day` относится к периоду; `data[].report.period.includes_partial_current_day` — к конкретной строке. `reporting.observed_at` сохраняется с payload в cache. `fetched_at`, `cached`, `currency`, `timezone`, `next_cursor` сохраняются. Следующую страницу получите через `after={next_cursor}` с теми же параметрами.

Охват пользователей перекрывается между объявлениями и днями; их сумма не даёт campaign/account reach. Частоты, CTR и стоимости также не складываются. Report использует отдельные provider rows. В текущем дне расходы, результаты и задержанная атрибуция меняются; сверяйте времена наблюдения, окно, cache, attribution/report time и breakdown. Отдельные запросы могут дать разные снимки.

## Ответ

Исходные выбранные поля Meta остаются в `data[]`: базовые показатели, Instagram fields, `actions`, `action_values`, `unique_actions`, `cost_per_action_type`, `attribution_setting`, video arrays. Индивидуальные окна/измерения и неизвестные action types сохраняются, вложенные credentials исключаются.

Рядом расположен `data[].report`: `metrics`, `cost_per_result`, `messaging_actions`, `new_messaging_contacts`, `attribution_setting`, currency и period. Например:

```json
{
  "metrics": {
    "instagram_follows": {"value":"13","status":"available","source":{"field":"instagram_profile_follow","definition":"ad_attributed_profile_follows"}},
    "messaging_conversations_started": {"value":null,"status":"not_returned","reason":"provider_omitted","source":{"field":"actions","action_type":"onsite_conversion.messaging_conversation_started_7d","ui_mapping":"requires_account_verification"}}
  },
  "cost_per_result": {
    "instagram_follows": {"value":"2.798462","status":"available","source":{"field":"derived"},"formula":"spend / instagram_follows","precision":6}
  },
  "currency":"BRL"
}
```

| Статус | Значение |
| --- | --- |
| `available` | Возвращённое числовое значение; `"0"`/`"0.00"` сохраняются |
| `not_returned` | Запрошенное поле/action отсутствует или null; результат нулём не считается |
| `unsupported` | Meta явно признала конкретное имя Instagram-поля невалидным |
| `unavailable` | Неоднозначность, непригодные входы для расчёта или непроверенный UI mapping; указан reason |

`requested_fields` показывает намерение запроса, `provider_fields` — поля успешного запроса, `unsupported_fields` — исключённые после точного отказа. Только явный `400/code 100` с формулировкой о невалидном `instagram_profile_follow`/`instagram_profile_visits` допускает fallback: до двух исключений, общий deadline 30 секунд. Auth, permissions, rate, timeout и ошибки breakdowns остаются ошибками запроса и сохраняют прежний cache. Поля результата получаются одной успешной выборкой; fallback не склеивает страницы разных запросов. Доступность может различаться между кабинетами/уровнями/срезами; успешный запрос без значения имеет статус `not_returned`.

Готовый payload ограничен 1 MiB для cache; `413 ads_report_too_large` требует меньшего `limit`/периода. Неудачный большой отчёт сохраняет предыдущий cache.

## Источники показателей

| Показатель report | Источник |
| --- | --- |
| `instagram_follows` | Отдельное scalar поле `instagram_profile_follow` |
| `instagram_profile_visits` | Отдельное scalar поле `instagram_profile_visits` |
| all clicks/CTR/CPC, CPM, frequency, spend/reach/impressions | Базовые поля Meta, перечисленные в `reporting.metric_sources` |
| `link_clicks` | `actions[link_click].value`; matching cost из `cost_per_action_type` |
| `inline_link_clicks`, `inline_link_ctr` | Отдельные inline-поля; provider definition сохраняется, смешивание с actions не выполняется |
| `outbound_clicks` | `outbound_clicks[outbound_click]`, назначения вне Meta |
| reactions/saves/comments/shares/engagement/landing views | Точные action codes из `reporting.metric_sources`; gross/net и составные actions не складываются |
| plays/thruplays, 25/50/75/100% видео | Соответствующие video arrays; average watch time сохраняется исходным полем |
| started/replied conversations, first replies, welcome views, messaging subscriptions | Отдельные messaging action codes; UI mapping помечен для проверки |

Нативная стоимость выбирается по точному field/action type. При её отсутствии вычисляется `spend / result` в одной строке через decimal/BigInt, half-up до шести знаков. Деньги — major currency units; R$36,38 = `"36.38"`. При отсутствующем/неположительном знаменателе derived стоимость недоступна; явный Meta cost `"0"` сохраняется. Средние/проценты не становятся знаменателем цены результата.

`report.messaging_actions` сохраняет все возвращённые messaging/contact/subscribe events, включая новые codes. `onsite_conversion.messaging_first_reply` показан как first replies; `new_messaging_contacts` пока имеет `unavailable/ui_mapping_not_verified`. Автоматическое соответствие UI-столбцу New messaging contacts требует подтверждения Meta/UI. Аналогично `onsite_conversion.messaging_subscribe` — отдельный messaging action; он не заменяет `instagram_profile_follow`. Суффикс `_7d` в коде сам по себе не определяет выбранное окно атрибуции.

SDK описывает `actions` как AdsActionStats со строковым `action_type` и не даёт исчерпывающего словаря UI-столбцов. Во время исследования Meta reference/definitions возвращали 429; mapping отсутствующих messaging events в этом кабинете не подтверждён. Широкие UI-названия не объединяются автоматически в один count. Запрет доступа к Insights остаётся `403`.

## Общие подписчики профиля

Текущий `followers_count` берётся отдельно через `/assets/pages/{Page-ID}/instagram?creative_id={owned-creative-ID}` при доступном Page → IG и grants credential. Время — `fetched_at` этой профильной выборки. Разница двух сохранённых наблюдений — net изменение всего профиля с органикой и отписками; она не равна рекламным follows.

Для профильных follows/unfollows и истории используйте [Instagram Insights API](INSIGHTS_API.md): Instagram Login, OAuth consent `instagram_business_manage_insights`, доступные показатели/thresholds и включённый collector. Даты этого API используют UTC. Рекламное подключение само его не создаёт. У moorselin 12 октября 2026 профильный counter был 146; среди Instagram Login подключений аккаунта не было. Перед работой проверяйте свежий состав.

## Датированная проверка 12 октября 2026

Fresh Graph v26.0 GET за 11–12 октября, `America/Sao_Paulo`: campaign spend `36.38`, impressions 5247, reach 3374, all clicks 93, follows 13, profile visits 65, link clicks 27. Проверены ad/campaign/adset, daily rows, account aggregate и фиксированные filters/report time. В последующей account-level выборке follows вернулись, profile visits были пропущены: `not_returned` на этом уровне. Campaign/adset возвращали посещения. Более ранний UI snapshot имел 61 посещение; текущий день и момент чтения различались.

Messaging codes в свежих ответах отсутствовали; ноль и их UI mapping не подтверждены. Meta objects, бюджеты, targeting, статусы и профильные подключения этим аудитом не изменялись.

Собранный локальный owner API дополнительно проверен на действующих Meta/Supabase данных на всех четырёх уровнях и с daily rows. Снимок campaign в `2026-10-12T19:13:40Z`: spend `37.12`, impressions 5373, reach 3447, clicks all 96, follows 13, visits 65, link clicks 29, derived cost/follow `2.855385` BRL. Дневная строка 11 октября отмечена полной, строка 12 октября — частичной. Общая проверка: 36 unit + 84 integration теста, typecheck, production build, npm audit (0 уязвимостей). Миграции и новые env для расширения не нужны; app и worker обновляются до общего image по [DEPLOYMENT.md](DEPLOYMENT.md).

После выпуска runtime commit `b32629e` на `https://autodm.niar42.com` прошла 21 read-only проверка публичного API: четыре уровня Insights, daily, conversion report time, кеш, пагинация и отказы некорректным/неавторизованным запросам. Снимок campaign в `2026-10-12T19:33:59Z`: spend `37.87` BRL, follows 13, visits 67, link clicks 29, cost/follow `2.913077` BRL. Отсутствующие messaging events сохранили `not_returned`. Статусы, бюджеты, targeting и creative IDs в обоих рекламных кабинетах совпали со снимком до выпуска. Подробности выпуска и отката — в [DEPLOYMENT.md](DEPLOYMENT.md).

Схема: [Meta AdsInsights SDK v26.0.2](https://github.com/facebook/facebook-python-business-sdk/blob/efd8423a2e595ea8d4c04eb824ce113f2f1d68cd/facebook_business/adobjects/adsinsights.py), [AdsActionStats](https://github.com/facebook/facebook-python-business-sdk/blob/efd8423a2e595ea8d4c04eb824ce113f2f1d68cd/facebook_business/adobjects/adsactionstats.py), [параметры AdAccount Insights](https://github.com/facebook/facebook-python-business-sdk/blob/efd8423a2e595ea8d4c04eb824ce113f2f1d68cd/facebook_business/adobjects/adaccount.py). При следующих версиях сверяйте SDK и живые ответы.
