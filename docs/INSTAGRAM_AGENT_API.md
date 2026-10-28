# Instagram API для агента

Расширение API владельца: профиль и права, отдельные медиа, комментарии, материалы,
журнал событий и чтение Direct. Используйте `Authorization: Bearer adm_…` либо JWT
владельца по [AGENT_API.md](AGENT_API.md). Доступ `bot_…` относится к транспорту
конкретного бота. Внутренний account UUID получайте через `GET /api/instagram/accounts`.
Каждый запрос проверяет владельца. Graph ID публикации, комментария и ID задания — разные сущности.

## Матрица возможностей на 28 октября 2026

Проверены код и официальные страницы Meta, обновлённые в том числе 20 октября 2026.
Instagram-модули используют **Instagram Login, graph.instagram.com, v26.0**.
Реклама использует отдельное Facebook/Marketing API подключение. Его наличие само по
себе не выдаёт Instagram-разрешения или Facebook Page credentials для новых действий.

| Статус | Возможность | Доступ и граница |
| --- | --- | --- |
| Уже реализовано | Direct-боты, асинхронные ответы, Reels/карусели/Stories с расписанием, Insights/снимки, Ads | Переиспользуются существующие контракты |
| Meta поддерживает; добавлено | Профиль, grants, подписки, отдельное медиа, дети карусели, лимит публикаций, tagged media | `instagram_business_basic`; некоторые поля/edges требуют дополнительных grants |
| Meta поддерживает; добавлено | Комментарии с пагинацией, первый комментарий, ответы, скрытие/возврат, удаление комментария, включение/выключение комментариев | Свои медиа; `instagram_business_manage_comments`; live-видео исключены из write-сценариев |
| Meta поддерживает; добавлено | IMAGE, alt text одиночного фото/фото-слайда, `thumb_offset`, `is_ai_generated` | `instagram_business_content_publish`; JPEG до 8 MiB; Stories только для Business |
| Добавлено в сервис | Редактирование caption/времени ещё не начатого задания; загрузка материалов; публикация → первый комментарий → проверка | Очередь, постоянные операции, receipts, изоляция владельцев |
| Meta поддерживает; добавлено | Живые разговоры Direct и детали сообщений; история нашего транспорта | `instagram_business_manage_messages`; детали последних 20 сообщений; ограничения папки Requests |
| Meta поддерживает; добавлено | Чтение событий комментариев, mentions и live comments | Журнал с момента выпуска; нужные поля должны быть подписаны у Meta |
| Требует отдельного подключения/согласия | Удаление опубликованного медиа, включая Story | Facebook Login + `instagram_basic,instagram_manage_contents`; текущий Instagram Login endpoint отсутствует |
| Требует отдельного подключения/реализации | Соавторы и collaborative media, ordered comments рекламы, branded content | Отдельные Facebook Login возможности/права; API этого выпуска их не выполняет |
| Meta поддерживает; вне этой итерации | Позиционные `user_tags`, ответы на внешние @mentions | Новые типизированные операции; текстовые @mentions в caption уже передаются |
| Официальный текущий контракт не предоставляет | Изменение caption/файла/обложки уже опубликованного медиа, нативный Reel-card репост в Story, link/poll/location stickers Stories, управление highlights, profile pins | Эти действия отсутствуют в API сервиса |
| Вне текущей схемы доступа | Произвольные комментарии под чужими постами, follow/unfollow, произвольные действия consumer-аккаунта | Доступные внешние @mentions имеют отдельный официальный сценарий; обходов авторизации нет |

Права ниже — требования. Реальную выдачу проверяйте `/capabilities`. Запрошенные OAuth
scopes и успешные локальные проверки не подтверждают grant. Standard Access применяется
к управляемым аккаунтам с ролью в приложении; для внешних клиентов нужны соответствующий
Advanced Access/App Review, а иногда Business Verification. Статус App Review по токену
не определяется. Сервис поддерживает многих владельцев и аккаунты без привязки к username.

Официальные источники: [модерация](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/comment-moderation/),
[comments](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-media/comments),
[comment](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-comment),
[publishing](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing/),
[container](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media),
[media](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/),
[mentions Instagram Login](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/mentions),
[Direct conversations](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/conversations-api/),
[официальная коллекция Meta](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api).

## Чтение и доступные действия

Все пути ниже начинаются с `/api/v1`. Ответы не кешируются. Наблюдения содержат
`fetched_at`, где уместно; счётчики/поля, которых Meta не вернула, остаются отсутствующими.

| Метод и путь | Результат |
| --- | --- |
| `GET /accounts/{id}/profile` | Свежий профиль, тип аккаунта, доступные счётчики |
| `GET /accounts/{id}/capabilities` | Текущие grants, подписки, поддерживаемые действия и ограничения |
| `GET /accounts/{id}/media` | Список медиа; существующий [Insights API](INSIGHTS_API.md) |
| `GET /accounts/{id}/media/{mediaId}` | Подпись, тип, ссылки и доступные счётчики; сначала подтверждается owner |
| `GET /accounts/{id}/media/{mediaId}/children` | Слайды карусели с пагинацией |
| `GET /accounts/{id}/stories` | Активные Stories; история заданий хранится отдельно |
| `GET /accounts/{id}/tags` | Медиа, в которых аккаунт отмечен; права на модерацию чужого медиа этим не выдаются |
| `GET /accounts/{id}/publishing-limit` | Свежий `quota_usage`/`config` Meta; значения лимита не фиксируются в клиенте |
| `GET /accounts/{id}/media/{mediaId}/comments` | Верхние комментарии |
| `GET /accounts/{id}/media/{mediaId}/comments/{commentId}` | Один комментарий с проверкой связи с медиа |
| `GET /accounts/{id}/media/{mediaId}/comments/{commentId}/replies` | Ответы на комментарий |

Graph-списки используют `limit=1..50` (по умолчанию 25) и `after={opaque cursor}`.
Следуйте `next_cursor` до null; ссылки `paging.next` провайдера не передаются клиенту и
не используются как произвольные адреса запроса. Отсутствие объекта в одной странице
не доказывает его отсутствие в аккаунте. Комментарии возвращаются в порядке Meta;
для chronological moderation используйте timestamps. Comment reads проверяют принадлежность
медиа, затем `comment.media.id`. API-scoped owner ID проверяется через `/me` того же токена.

`capabilities.actions` возвращает `granted`, `missing` или `unknown` для read, comments,
publishing, messages, insights. При сбое проверки grants значение остаётся `unknown`.
Это проверка permissions, а доступность конкретного действия окончательно определяет Meta.
`unknown` само по себе не требует повторного согласия: в рамках поручения владельца
проверьте нужный объект и выполните типизированную операцию. Явный permission-отказ Meta
укажет необходимость дополнительного grant/согласия.

## Постоянные операции комментариев

`POST /accounts/{id}/operations`, JSON, обязательный `Idempotency-Key` (1–128 символов
`A-Za-z0-9_.:-`). Поддерживаются ровно следующие формы:

```json
{"action":"comment.create","media_id":"<Graph media ID>","text":"Первый комментарий"}
{"action":"comment.reply","media_id":"<Graph media ID>","comment_id":"<Graph comment ID>","text":"Спасибо!"}
{"action":"comment.hide","media_id":"<Graph media ID>","comment_id":"<Graph comment ID>","hidden":true}
{"action":"comment.delete","media_id":"<Graph media ID>","comment_id":"<Graph comment ID>"}
{"action":"media.comments","media_id":"<Graph media ID>","enabled":false}
```

Для возврата комментария задайте `hidden:false`, для включения — `enabled:true`.
Текст допускает до 2200 символов. Валидация неизвестных полей/действий возвращает `400`.
Удобные POST-алиасы `/media/{mediaId}/comments` и
`/media/{mediaId}/comments/{commentId}/replies` принимают только `{"text":"…"}` и тот же
заголовок идемпотентности. Их ключи общие с `/operations`.

Ответ `202` содержит `id,account_id,action,input,status,receipt,error_code,attempts` и даты.
Состояние `queued` подтверждает сохранение. Worker перед внешним изменением проверяет
аккаунт, владельца медиа и связь комментария; чужой объект переводит операцию в `failed`.
Максимум 100 незавершённых операций на аккаунт. Несколько worker сериализуют операции
одного аккаунта; разные аккаунты продвигаются независимо.

| Метод и путь | Назначение |
| --- | --- |
| `POST /accounts/{id}/operations/validate` | Тот же JSON; проверка формы, владения и наблюдаемых grants. Внешнего write нет. Meta dry-run комментариев не предоставляет |
| `GET /accounts/{id}/operations?cursor={UUID}` | 50 операций, `next_cursor` |
| `GET /instagram-operations/{operationId}` | Постоянный статус и receipt |
| `DELETE /instagram-operations/{operationId}` | Отмена `queued/preparing`; `executing` и завершённые дают `409` |
| `POST /instagram-operations/{operationId}/reconcile` | Повторное чтение результата; внешнего write нет |

Состояния: `queued → preparing → executing → succeeded/failed/unknown`; возможна отмена
до `executing`. Известные временные/429 отказы возвращаются в очередь с backoff, максимум
12 попыток. Таймаут, разрыв, 5xx, неверный acknowledgement или авария после durable
`executing` дают **unknown**. Такие операции автоматически не отправляются повторно.
Вызов с прежним ключом возвращает прежнюю операцию; другой payload — `409`.

`receipt.acknowledged` означает успешный ответ Meta. Для создания/ответа сохраняется
`external_id`; он записывается **до** проверочного чтения. Затем устанавливается
`verified:true`, если прочитан ожидаемый комментарий/parent/text либо состояние модерации.
Ошибка проверки сохраняет успешный receipt с `verified:false`; повторный write не нужен.
Удаление имеет `verification:"delete_acknowledgement_only"`: сохранён ответ Meta, результат
отсутствия не подменяется выводом по общему provider error. Meta всегда показывает
собственные комментарии владельца даже после `hide=true` — учитывайте `verified`.

Для сверки успешной операции отправьте `{}` в `/reconcile`. Для неизвестного создания
сначала найдите комментарий через GET с пагинацией, затем передайте
`{"external_id":"<comment ID>"}`. Сервер проверит своё медиа, текст, parent, автора по
username аккаунта и время после начала операции. Это явное принятие найденного результата.
Без подтверждённого совпадения вернётся `409`. Unknown deletion требует ручного разбора;
повторное удаление автоматически не выполняется. Новым ключом нельзя обходить unknown.

## Публикация → первый комментарий

Существующий `POST /publications` принимает необязательный `first_comment`:

```json
{
  "account_id":"<internal UUID>",
  "video_url":"https://cdn.example.com/reel.mp4",
  "caption":"Новый ролик",
  "first_comment":"Подробности по ссылке в профиле",
  "publish_at":"2026-11-01T18:00:00-03:00"
}
```

Один запрос атомарно создаёт публикацию и зависимую `comment.create`, возвращает
`first_comment_operation_id`. Контейнеры создаются при наступлении срока. Комментарий
ждёт `published` с сохранённым `media_id`; публикация и комментарий имеют собственные
статусы/ошибки. Сбой комментария сохраняет успешную публикацию. `failed/cancelled` либо
`publication_unknown` публикации блокируют зависимый комментарий. Исторические задания
и повторы их enqueue не получают новых комментариев.

`GET /publications/{id}/workflow` объединяет публикацию и операцию. `state`:
`waiting_publication`, `waiting_comment`, `verification_pending`, `completed`, `needs_attention`.
Для `completed` с комментарием нужен `verified:true`. Это типизированный рецепт с постоянной
зависимостью; произвольного Graph proxy, произвольного кода и передачи Meta-токенов нет.
Другие последовательности выполняйте через явно типизированные операции с сохранением
их ID и чтением результата предыдущего шага.

Для `IMAGE` задайте `image_url`, необязательные `caption,alt_text,first_comment`.
`alt_text` до 1000 символов также допускается в IMAGE-слайдах `items` карусели.
`thumb_offset` — целые миллисекунды кадра обложки Reels (0..900000); `cover_url` имеет
приоритет у Meta. `is_ai_generated` передаётся родительскому контейнеру любого типа.
Все URL проходят существующую SSRF-проверку при enqueue и перед передачей Meta.
Stories не принимают первый комментарий, caption и alt text.

`PATCH /publications/{id}` принимает `{"revision":0,"caption":"…","publish_at":"…"}`.
Это атомарная правка `queued` без активного claim; stale revision и начатое задание дают
`409 publication_edit_conflict`. Версия увеличивается; первоначальные enqueue key/hash
сохраняются, повтор enqueue возвращает текущее задание. После потерянного ответа PATCH
прочитайте запись и revision. Для смены исходников отмените подготовленное задание и
создайте новое с новым ключом по поручению владельца.

Полный контракт: [PUBLISHING_API.md](PUBLISHING_API.md).

## Материалы через API

1. `POST /accounts/{id}/materials`, `Idempotency-Key`, JSON
   `{"mime":"video/mp4","size":12345678}`. JPEG до 8 MiB; MP4/MOV до 300 MiB.
2. Ответ содержит ID материала и `upload_url` на 2 часа, `upload_method:"PUT"`.
   Передайте **байты файла** по этому адресу с указанным `Content-Type`. Заголовок
   владельца и Meta-токен этому запросу не нужны. Хранилище приватное, перезапись отключена.
3. `POST /materials/{id}/complete` сверяет размер и MIME объекта; при несовпадении — `409`.
4. `GET /materials/{id}?expires_in=604800` выдаёт URL для Meta и `expires_at`.
   Допустимо 3600..604800 секунд (по умолчанию 7 дней). Подставьте URL в `video_url`,
   `image_url`, `cover_url` либо `items[].url`. Запас должен покрывать расписание и обработку.
5. `GET /accounts/{id}/materials?cursor={UUID}` возвращает библиотеку, 50 записей/страницу.

Повтор POST с тем же payload/key возвращает тот же объект и при необходимости новый
upload URL; другой payload даёт `409`. Одновременно разрешено 20 pending материалов на
аккаунт. Файлы сохраняются в bucket `instagram-materials`. Автоматического удаления этого
bucket нет, чтобы не повредить ожидающие публикации. Ограничения Storage тарифа могут
быть ниже 300 MiB; ошибки доступны как `storage_upload_unavailable`. Проверка `complete`
сверяет метаданные, декодирование и допустимость формата окончательно проверяет Meta.
Для расписания за пределами срока подписанного URL используйте устойчивый HTTPS URL
своего CDN либо подготовьте новый URL перед созданием задания.

## События и Direct

`GET /accounts/{id}/events?after=0&limit=50` возвращает последовательный журнал
`comments,mentions,live_comments`: `id,field,payload,occurred_at,received_at`.
`limit=1..100`, `next_cursor` показывает следующую страницу, `last_cursor` сохраняйте для
следующего опроса даже при `next_cursor:null`. События дедуплицируются и хранятся 30 дней.
Две документированные формы comment webhook нормализуются; журнал работает независимо
от привязки бота. Доступ определяется владельцем аккаунта.

Подписанные входящие webhook сначала сохраняются в существующий durable inbox; worker
записывает наблюдения и затем выполняет прежние сценарии. Для подписок используйте
`capabilities`, `GET /api/instagram/subscription-status/{accountId}` и явно вызванный
`POST /api/instagram/resubscribe/{accountId}`. Набор resubscribe теперь включает `mentions`.
`live_comments` журналируется при наличии подписки Meta; автоматически поле не добавляется.
Подписка приложения в Meta Dashboard и реальный grant проверяются отдельно. После
обновления кода подписки подключённых аккаунтов сами не изменяются.

Живой Direct:

- `GET /accounts/{id}/inbox/conversations?limit=25&after={cursor}` — разговоры Meta;
- `GET /accounts/{id}/inbox/conversations/{conversationId}/messages?limit=20&after={cursor}` —
  ID сообщений и доступные детали. Проверяется участие своего аккаунта. Graph conversation
  ID непрозрачный, он отличается от UUID разговора нашего транспорта.

Meta возвращает детали последних 20 сообщений; для более старых `details_available:false`
с ошибкой, без придуманного текста. Неактивные более 30 дней Requests могут отсутствовать.
Каждый ответ содержит `source:meta_live,fetched_at,cached:false`. Эта возможность читает
официальный Direct inbox без запуска AI-ответов.

Сохранённый транспорт:
`GET /accounts/{id}/conversations?cursor={UUID}` и
`GET /conversations/{conversationUUID}/messages?cursor={UUID}` — 50 записей/страницу;
`coverage:stored_bot_transport_only`. Для хронологии сортируйте `occurred_at`.
Ответы бота, причинность, окно доставки и неизвестный результат сохраняют
[BOT_API.md](BOT_API.md). Общего импорта всей истории в базу и произвольной отправки
от имени владельца этот выпуск не добавляет. Insights и Ads используют прежние API.

Ошибки: `401` credential, `404` чужой аккаунт/медиа/комментарий, `409` недоступность
аккаунта/конфликт состояния, `429` лимит, `502` Meta, `503` база. Тексты провайдера и
секреты не выдаются. Для каждой операции смотрите её постоянный `error_code` и receipt.


Датированный результат проверки действующей установки, включая недоступность перечисления
permissions у текущего подключения и сохранность очереди: [выпуск 28 октября 2026](releases/2026-10-28-instagram-agent.md).
