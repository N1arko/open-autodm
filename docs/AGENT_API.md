# API Open-autoDM для ИИ-агента

Этот файл — точка входа для агента, который управляет подключёнными Instagram-аккаунтами.
Сервис предоставляет HTTP API владельца. Контракты находятся в этом репозитории;
собственный MCP-сервер с описаниями tools и OpenAPI-файл в репозитории отсутствуют.
Клиент с отдельной MCP-обёрткой должен получить эти контракты через её инструкции или ресурсы.

## Начало работы

1. Адрес установки и место хранения доступа определены в локальном `.local/AGENT_ACCESS.md`.
   Агент загружает управляющий ключ в окружение/хранилище клиента, без вывода значения.
2. `GET /api/health` проверяет доступность сервиса. `GET /api/instagram/accounts`
   возвращает `{accounts:[…]}`; нужный аккаунт выбирается по поручению владельца.
   Его `id` — внутренний UUID для `account_id` и `/accounts/{id}`.
3. `GET /api/v1/accounts/{id}/capabilities` возвращает текущие наблюдения о правах,
   подписках и профиле. `unknown` означает недоступность проверки списка permissions.
   При поручении владельца агент продолжает через нужный endpoint; явный permission-отказ
   Meta укажет необходимость дополнительного согласия. Запрошенные OAuth scopes не доказывают grant.
4. Таблица ниже ведёт к нужному сценарию. Агент сохраняет `Idempotency-Key`, ID заданий
   и операций, затем читает их результат. `202` подтверждает сохранение в очереди.

```sh
curl --fail-with-body "$AUTODM_URL/api/instagram/accounts" \
  -H "Authorization: Bearer $OWNER_API_TOKEN"
```

`AUTODM_URL` и `OWNER_API_TOKEN` уже заданы в окружении клиента. Даты, материалы,
тексты и параметры изменения берутся из поручения владельца. Примеры содержат образцы.

## Операции Instagram

Все HTTP-пути в этой таблице полные. Параметры и ограничения указаны в связанных разделах.

| Поручение | Endpoint или параметр | Контракт |
| --- | --- | --- |
| Опубликовать обычный Reel, фото, карусель или Story | `POST /api/v1/publications`; `media_type=REELS\|IMAGE\|CAROUSEL\|STORIES` | [Публикации](PUBLISHING_API.md) |
| Опубликовать пробный / тестовый / «скрытый» Reel | Тот же POST; `trial_params.graduation_strategy=MANUAL\|SS_PERFORMANCE` | [Пробные Reels](PUBLISHING_API.md#пробные-reels-trial-reels) |
| Добавить первый комментарий к новой публикации | `first_comment` в том же POST | [Публикация с комментарием](INSTAGRAM_AGENT_API.md#публикация--первый-комментарий) |
| Проверить оба шага | `GET /api/v1/publications/{id}/workflow` | [Сценарий ниже](#пробный-reel-по-расписанию-с-первым-комментарием) |
| Прочитать или изменить ожидающее задание | `GET/PATCH/DELETE /api/v1/publications/{id}`; для PATCH нужен `revision` | [Правка и отмена](PUBLISHING_API.md#read-and-cancel) |
| Комментировать уже опубликованное своё медиа или модерировать комментарий | `POST /api/v1/accounts/{id}/operations`; типизированный `action` | [Операции комментариев](INSTAGRAM_AGENT_API.md#постоянные-операции-комментариев) |
| Прочитать комментарии и ответы | `GET /api/v1/accounts/{id}/media/{mediaId}/comments` и `GET /api/v1/accounts/{id}/media/{mediaId}/comments/{commentId}/replies` | [Чтение объектов](INSTAGRAM_AGENT_API.md#чтение-и-доступные-действия) |
| Загрузить фото/видео через сервис | `POST /api/v1/accounts/{id}/materials` → upload → complete → URL | [Материалы](INSTAGRAM_AGENT_API.md#материалы-через-api) |
| Прочитать профиль, медиа или активные Stories | `/api/v1/accounts/{id}/profile`, `/api/v1/accounts/{id}/media`, `/api/v1/accounts/{id}/media/{mediaId}`, `/api/v1/accounts/{id}/stories` | [Чтение объектов](INSTAGRAM_AGENT_API.md#чтение-и-доступные-действия) |
| Прочитать живой Direct или события комментариев/упоминаний | `/api/v1/accounts/{id}/inbox/conversations`, `/api/v1/accounts/{id}/events` | [События и Direct](INSTAGRAM_AGENT_API.md#события-и-direct) |
| Получить статистику и сохранённые наблюдения | `/api/v1/accounts/{id}/insights` и связанные endpoints | [Insights](INSIGHTS_API.md) |
| Отправить ответ внешнего бота | `/api/v1/messages` с credential интеграции | [API ботов](BOT_API.md) |
| Прочитать или изменить рекламу | `/api/v1/ads/accounts` и endpoints выбранного подключения | [Чтение](ADS_API.md), [изменения](ADS_MANAGEMENT_API.md) |

Публикационный UUID используется в `/publications/{id}`. Числовой Meta `media_id` используется
для комментариев и media insights. Для опубликованного медиа применяется `comment.create`;
историческое задание публикации сохраняется. Списки читаются до `next_cursor:null` с тем
параметром курсора, который указан в контракте выбранного endpoint.

## Пробный Reel по расписанию с первым комментарием

Агент сначала определяет аккаунт, прямой HTTPS URL видео, подпись, время и стратегию Trial
из поручения владельца. Trial Reel публикуется для людей, которые не подписаны на аккаунт.
`MANUAL` оставляет переход к подписчикам ручным действием в приложении Instagram;
`SS_PERFORMANCE` разрешает Meta автоматический переход при хороших результатах.
Без `trial_params` создаётся обычный Reel. Выбор стратегии в API обязателен для Trial.

**Шаг 1.** Один `POST /api/v1/publications` с заголовками
`Authorization: Bearer …`, `Content-Type: application/json` и стабильным `Idempotency-Key`.
Значения примера заменяются данными поручения:

```json
{
  "account_id": "<internal Instagram UUID>",
  "media_type": "REELS",
  "video_url": "https://cdn.example.com/reel.mp4",
  "caption": "Текст подписи",
  "trial_params": { "graduation_strategy": "MANUAL" },
  "first_comment": "Текст первого комментария",
  "publish_at": "2026-12-01T18:00:00-03:00"
}
```

Для немедленного запуска поле `publish_at` опускается. Время по расписанию содержит `Z`
или явный UTC offset; источник должен оставаться доступным до завершения обработки Meta.
`first_comment` добавляется при поручении на комментарий. Ответ содержит `id` публикации
и `first_comment_operation_id` зависимой операции. Агент сохраняет оба ID.

**Шаг 2.** `GET /api/v1/publications/{id}/workflow` возвращает публикацию и первый комментарий.

| `state` | Действие агента |
| --- | --- |
| `waiting_publication` | Повторное чтение после наступления срока; worker готовит и публикует медиа |
| `waiting_comment` | Повторное чтение; media ID уже подтверждён, выполняется комментарий |
| `verification_pending` | Чтение receipt и read-only сверка `POST /api/v1/instagram-operations/{operationId}/reconcile` |
| `completed` | Весь запрошенный сценарий завершён; у первого комментария `receipt.verified:true` |
| `needs_attention` | Разбор конкретных `status/error_code` публикации и операции по их контрактам |

При `publication_unknown` или `first_comment.status=unknown` сначала проверяется внешний
результат. Смена ключа и повторная публикация способны создать дубль. `failed` комментария
сохраняет опубликованный Reel. `trial_params` описывает режим создания; текущую стадию
перехода Trial в обычный Reel этот API не определяет.

## Комментарий к уже опубликованному медиа

1. Агент получает свой `media_id` через список медиа либо запись успешной публикации.
2. Для поручения «первый комментарий» агент читает все страницы комментариев и проверяет,
   нет ли уже результата этого поручения, включая комментарий, оставленный вручную.
3. Новый комментарий создаётся через `POST /api/v1/accounts/{id}/operations`:

```json
{
  "action": "comment.create",
  "media_id": "<Graph media ID>",
  "text": "Текст комментария"
}
```

Запрос требует стабильного `Idempotency-Key`. Предварительный
`POST /api/v1/accounts/{id}/operations/validate` с тем же телом проверяет форму и владение;
внешнего write он не выполняет. Операция читается через
`GET /api/v1/instagram-operations/{operationId}`. Для создания/ответа проверяется
`status:succeeded`, `receipt.external_id` и `receipt.verified`. Детали сверки неизвестного
результата — в [контракте комментариев](INSTAGRAM_AGENT_API.md#постоянные-операции-комментариев).

## Авторизация владельца и интеграции

Управляющий ключ `adm_<64 hex>` принадлежит одному существующему пользователю Supabase Auth.
Каждый запрос проверяет владельца объекта и `APP_OWNER_EMAILS`. Удалённый или исключённый
владелец теряет доступ. Также поддерживается JWT сессии владельца.

Постоянный ключ включается настройками `OWNER_API_TOKEN_HASH` (SHA-256 полного ключа) и
`OWNER_API_USER_ID` (UUID пользователя). При создании нового ключа используются 32 случайных
байта; в runtime сохраняются hash и UUID, исходный ключ — в хранилище клиента. Замена hash
отзывает прежний ключ, очистка настроек отключает этот доступ. Автоматического срока действия
нет. Настройка существующей установки выполняется по отдельной задаче, с сохранением конфигурации.

Credential `bot_…` отправляет ответы и читает доставку своей интеграции. Управляющий `adm_…`
обслуживает API владельца; отправка bot-ответа требует credential интеграции. Ключи передаются
в Authorization и сохраняются вне Git, URL и публичных webhook payloads.

## Настройка установки и Instagram

| Метод и путь | Назначение |
| --- | --- |
| `GET /api/setup` | Состояние настройки Meta и callback/webhook адреса |
| `POST /api/setup` | Сохранение `metaAppId`, `metaAppSecret`, необязательного `metaFbAppSecret` |
| `GET /api/instagram/accounts` | Аккаунты и состояние токенов/паузы; `{accounts:[…]}` |
| `GET /api/instagram/connect` | Подписанная OAuth ссылка; `{url:"…"}` |
| `GET /api/instagram/subscription-status/{accountId}` | Подписки Meta аккаунта |
| `POST /api/instagram/resubscribe/{accountId}` | Повторная подписка webhook fields |
| `POST /api/instagram/refresh/{accountId}` | Продление ещё действующего Instagram-токена |
| `DELETE /api/instagram/disconnect/{accountId}` | Удаление подключения и зависимых записей |
| `GET /api/contacts?accountId={UUID}` | Сохранённые контакты |
| `GET /api/analytics?accountId={UUID}&from=YYYY-MM-DD&to=YYYY-MM-DD` | Статистика automation |
| `GET /api/debug/events` | События обработки |

Meta app и согласие владельца настраиваются у Meta. `connect?publishing=true` запрашивает
publishing scope, `connect?insights=true` — Insights; флаги можно сочетать. Генерация URL
сохраняет необходимость согласия владельца. После callback агент проверяет подключение
через `/api/instagram/accounts`. Истёкший или отозванный токен требует новой авторизации.
Callback возвращает пользователя в `/settings` независимо от способа создания ссылки.

Пример тела настройки Meta:

```json
{ "metaAppId": "123456789012345", "metaAppSecret": "<32 hex characters>" }
```

Ответ setup содержит `webhookUrl`, `webhookVerifyToken`, `oauthRedirectUri`. Установка с
постоянным worker уже выполняет фоновые задания; дополнительное расписание cron из wizard
ей не требуется. Порядок выпуска и миграций — в [DEPLOYMENT.md](DEPLOYMENT.md).

## Подключение внешнего бота

Агент выбирает HTTPS обработчик, затем создаёт интеграцию:
`POST /api/v1/integrations` с `{"name":"My bot","webhook_url":"https://bot.example.com/events"}`.
Возвращённые `id,token,webhook_secret` сохраняются во внешнем хранилище; секреты доступны
при создании и ротации. Привязка выполняется через
`PUT /api/v1/accounts/{accountId}/integration` с `{"integration_id":"<integration UUID>"}`.
GET того же пути возвращает `account_id,integration_id,revision`; без привязки — null/0.

| Метод и путь | Назначение |
| --- | --- |
| `GET /api/v1/integrations?cursor={UUID}` | Список интеграций; `{data:[…],next_cursor}` |
| `PATCH /api/v1/integrations/{id}` | Изменение `name,webhook_url,enabled` |
| `POST /api/v1/integrations/{id}/credentials` | Ротация ключа и секрета интеграции |
| `DELETE /api/v1/accounts/{accountId}/integration` | Отвязка бота с сохранением Instagram |
| `PATCH /api/v1/conversations/{id}` | `{"paused":true}` либо false |

Одна интеграция обслуживает несколько Instagram-аккаунтов; у аккаунта одна текущая
привязка. Реальное входящее DM, подписанное событие и ответ `sent` проверяются в рамках
поручения на подключение. Формат событий, причинность, окно отправки и `delivery_unknown` —
в [BOT_API.md](BOT_API.md). Модель, prompt и память настраиваются во внешнем обработчике.

## Реклама и статистика

Instagram Login и рекламные credentials относятся к разным подключениям. Рекламный UUID
получается через `/api/v1/ads/accounts`; Instagram account UUID для него не подходит.
Для изменений рекламы используются validate → durable plan → execute с точным plan hash;
новые campaign/ad set/ad создаются в PAUSED. Активация, бюджет, материал, аудитория и срок
следуют поручению владельца. Состояние рекламы подтверждается свежим чтением после receipt.

Контракты: [чтение рекламы](ADS_API.md), [управление](ADS_MANAGEMENT_API.md),
[материалы](ADS_CREATIVE_API.md), [ресурсы и правила](ADS_AUTOMATION_API.md),
[Instagram Insights](INSIGHTS_API.md). Ежедневный сбор Insights включается отдельно через
`PUT /api/v1/accounts/{id}/insights/settings`. Отсутствующие метрики сохраняются отсутствующими.
