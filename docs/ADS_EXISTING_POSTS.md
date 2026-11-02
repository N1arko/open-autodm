# Реклама существующего Reel на посещения профиля

Используется рекламное подключение owner API и уже опубликованный Instagram media ID. Цепочка: `OUTCOME_TRAFFIC → INSTAGRAM_PROFILE → PROFILE_VISIT`, billing `IMPRESSIONS`, CTA `VIEW_INSTAGRAM_PROFILE`. Публикация сохраняется по `source_instagram_media_id`; загрузки нового видео и создания нового Instagram-поста в этом пути нет.

## Выбор объектов

Получите подключение через `/api/v1/ads/accounts` и прочитайте нужные ресурсы до конца пагинации. URL использует connection UUID; payload — числовые Meta IDs. Найдите исходное медиа через доступное чтение Instagram или `source_instagram_media_id` проверенного creative. Publishing UUID и `effective_instagram_media_id` рекламного экземпляра относятся к другим сущностям.

Сначала проверьте существующие ads/creatives и receipts поручения: готовая реклама может уже использовать нужный пост. Для новой кампании/группы примените [durable API](ADS_MANAGEMENT_API.md) с параметрами владельца. В группе нужен `promoted_object.page_id` и указанные выше objective/goal/destination/billing.

## Validate → prepare/execute

Отправьте в `POST /api/v1/ads/accounts/{connection-UUID}/actions/validate`:

```json
{
  "action":"creative.create",
  "params":{
    "name":"Existing Reel — profile visits",
    "validation_adset_id":"<Meta ad set ID>",
    "creative":{
      "kind":"instagram_post",
      "page_id":"<Meta Page ID>",
      "instagram_user_id":"<Meta Instagram ID>",
      "source_instagram_media_id":"<original published media ID>",
      "link":"https://www.instagram.com/your_username/",
      "call_to_action":"VIEW_INSTAGRAM_PROFILE",
      "contextual_multi_ads":{"enroll_status":"OPT_OUT"}
    }
  }
}
```

Для этой CTA обязательны Page, Instagram identity, source ID, контекст группы и точный HTTPS URL профиля. `page_id` у `instagram_post` служит проверяемым контекстом сервиса. Meta payload содержит исходный source ID, Instagram identity, `link_url`, CTA и явно переданные controls. Caption/message, новый media и `object_story_spec` для подмены публикации не формируются. Текст, обложка и порядок слайдов определяются исходной публикацией. [Creative controls](ADS_CREATIVE_API.md#улучшения-padding-и-размещения) сохраняются; совместимость конкретных controls проверяет Meta.

Сервис проверяет принадлежность ad set/campaign кабинету, их конфигурацию, Page → Instagram и URL профиля. Затем читает `GET /{source ID}` с `owner{id}`, media type/product type, permalink, timestamp и caption. Владелец source должен совпадать с указанным Instagram. После этого выполняются Meta `adcreatives validate_only` и `ads validate_only` с inline existing-post creative в данной группе.

Успех: `meta_validated:true`, `validation.scope:creative_and_adset`, `validation.adset_compatibility:validated`. Проверка не создаёт объектов. Отказ permissions/eligibility или недоступность обязательных метаданных блокирует запись.

После проверки отправьте тот же action в `POST /actions` со стабильным `Idempotency-Key`. Сохраните ID операции и `plan_hash`; выполните `POST /actions/{operation-ID}/execute` с точным hash. Prepare и execute заново читают зависимости и выполняют обе Meta validation. В плане сохраняются source identity/type/permalink/timestamp и hash подписи. Изменение этих данных, группы, разрешений или политики блокирует старый план.

`result.object_id` успешного receipt — ID рекламного creative. Материал сам по себе не включает рекламу. Статус `PAUSED` применяется к новым campaign/ad set/ad; Meta не предоставляет его для AdCreative.

## Объявление и отдельная активация

Используйте возвращённый creative ID:

```json
{"action":"ad.create","params":{"name":"Existing Reel ad","adset_id":"<Meta ad set ID>","creative_id":"<successful creative receipt ID>"}}
```

Пройдите validate → prepare/execute с отдельным ключом. Ad создаётся `PAUSED`; в профильной группе его совместимость проверяется при prepare и перед execute. Прочитайте результат и source identity. Включение — отдельный `ad.update` с `status:ACTIVE`, своим plan hash и подтверждением расходов по поручению владельца. Новые группу и кампанию включают отдельно, с кампанией последней. Review, доставка и расходы проверяются свежим readback/Insights.

Повтор того же ключа/action возвращает прежнюю операцию, успешного execute — прежний receipt без нового POST. `uncertain` или потерянный ответ требуют проверки реального результата. Автоматического повторного write нет. [Диагностика и лимиты](ADS_CREATIVE_API.md#диагностика-meta-и-rate-limit) применяются ко всему пути.

## Форматы и границы

| Source media | Допускаемый контракт | Подтверждение |
| --- | --- | --- |
| Опубликованный Reel | `REELS` + `VIDEO` | Живой Graph v26.0 validate_only; полный fixture flow |
| Фото ленты | `FEED` + `IMAGE` | Source-media контракт и fixtures; требуется точная Meta validation |
| Видео ленты | `FEED` + `VIDEO` | То же условие |
| Опубликованная карусель | `FEED` + `CAROUSEL_ALBUM` | Один исходный album ID; fixtures, placements/CTA проверяет Meta |
| Story, Live, неизвестный product type | Этот профильный путь не принимает их | `409 unsupported_instagram_post_format` либо отказ чтения провайдера |

Официальный SDK описывает [source_instagram_media_id и identity AdCreative](https://github.com/facebook/facebook-python-business-sdk/blob/efd8423a2e595ea8d4c04eb824ce113f2f1d68cd/facebook_business/adobjects/adcreative.py) и [IGMedia owner/media_type/media_product_type](https://github.com/facebook/facebook-python-business-sdk/blob/efd8423a2e595ea8d4c04eb824ce113f2f1d68cd/facebook_business/adobjects/igmedia.py). Наличие полей не устанавливает eligibility конкретного поста. Сервис допускает ограниченную матрицу выше и требует validation каждого случая. FEED-варианты проверены на fixtures; живой запуск всех форматов этим не подтверждён. Meta guides при исследовании отвечали 429; Reel дополнительно проверен на действующих данных.

Путь рассчитан на публикации выбранного Instagram-владельца. Partnership/branded-content authorization, реклама чужого поста, автоматическое получение согласия соавтора, изменения исходника и смена оптимизации в него не входят. Музыка, права, Trial eligibility, свойства аккаунта и ограничения placements определяются Meta. Marketing credential должен иметь grants для чтения source и рекламы; наличие Instagram Login само их не выдаёт.

Ошибки: `409 instagram_post_owner_mismatch`, `unsupported_instagram_post_format`, общие `profile_creative_configuration_mismatch`, `page_instagram_identity_mismatch`, `instagram_profile_destination_mismatch`; неверное тело — 400. Provider permission/rate/rejection сохраняют соответствующие коды. Первоначальный production `502` от 2 ноября без диагностики не позволяет задним числом установить точную причину.

## Проверка 2 ноября 2026

Локальный owner handler проверил source `18181361419431354` — Reel `DfPJkruCnm8` аккаунта @snippist: owner `17841419413695848`, Page `1397828260071694`, кабинет `2121416662133182`, группа `120252153520050304`. Прочитаны зависимости, обе Meta validation успешны. Рабочие creative `1413868103782246`, ad `120252153614980304`, исходная публикация и неиспользованный creative `1003686972776865` проверкой не изменялись. Перед зависимым действием сведения проверяются заново.
