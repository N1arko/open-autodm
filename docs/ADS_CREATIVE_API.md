# Рекламные материалы, Direct и поиск

Этот контракт дополняет [управление рекламой](ADS_MANAGEMENT_API.md). База маршрутов: `/api/v1/ads/accounts/{connection-UUID}`. Авторизация — ключ владельца `adm_…` или разрешённая сессия владельца. Токен бота не подходит. Все ID Meta получаются через рекламные endpoints; Instagram Login остаётся отдельным подключением.

## География и каталог targeting

`GET /targeting/search?kind=cities&q=Florianopolis&country=BR`

`kind`: `cities`, `regions`, `countries`, `interests`, `behaviors`, `work_positions`, `user_device`, `user_os`, `locales`. `q` — 1–200 символов, `country` — необязательный код из двух заглавных букв, `cursor` — предыдущий `next_cursor`. Ответ: `{data,next_cursor,cached:false,fetched_at}`. География использует фиксированный Meta `/search?type=adgeolocation`, остальные категории — каталог кабинета `/targetingsearch`. Имена и размеры аудитории отражают ответ Meta. При ошибке каталог не подменяется пустым списком. Проверяйте страну, регион и тип результата: одно название может соответствовать нескольким местам.

Запись `targeting.geo_locations` и `excluded_geo_locations` принимает:

- `countries:["BR"]`;
- `regions:[{"key":"459"}]`;
- `cities:[{"key":"253249"}]` для выбора города без добавленного сервисом радиуса;
- `cities:[{"key":"253249","radius":10,"distance_unit":"kilometer"}]` для явного радиуса; у города целое положительное число и обязательная пара radius/unit;
- `custom_locations:[{"latitude":-27.6,"longitude":-48.5,"radius":5,"distance_unit":"kilometer"}]`;
- необязательные `location_types` из `home`, `recent`, `travel_in`, `frequently_in`.

Есть минимум один непустой список мест; максимум 100 элементов в каждом. Единицы — `kilometer`/`mile`, локальная верхняя граница радиуса — 1000. Допустимый минимум и сочетание типов мест устанавливает Meta validation. Внешний агент сам выбирает радиус по поручению владельца; сервис его не добавляет.

Для явного отключения расширения географии используйте:

```json
{
  "geo_locations":{"cities":[{"key":"253249"}]},
  "targeting_automation":{"advantage_audience":0,"individual_setting":{"geo":0}}
}
```

Это поля запроса. После изменения проверяйте свежее чтение группы и разрешённую Meta комбинацию targeting.

## Identity и полное чтение

| Метод | Результат |
| --- | --- |
| GET `/creatives/{Meta-creative-ID}` | Полный доступный creative с проверкой его `account_id` |
| GET `/assets/pages/{Page-ID}/instagram` | Связанный Instagram, профиль и `ig_id` для Direct-ссылки |
| GET `/assets/pages/{Page-ID}/instagram/media` | Медиа и подписи, 25 на страницу; дальше `cursor` |

Page должна присутствовать в `/assets/pages`. Если discovery её пропускает, передайте `creative_id={Meta-creative-ID}`: сервис проверит принадлежность creative выбранному кабинету и указанную в нём Page. Произвольный профиль по широкому токену этот маршрут не открывает. Meta всё равно должна разрешить чтение Page/Instagram. При отсутствии связи ответ содержит `instagram:null,discovery:"no_link_returned"`; это наблюдение конкретного ответа провайдера.

Рекламный `instagram_user_id` и `ig_id` — разные ID. Для moorselin проверено соответствие `17841413554207197` → `13657579806` 11 октября 2026. Эти ID приведены как датированное подтверждение; в работе запрашивайте текущую связь через API.

Чтение `/adsets` сохраняет географию, `location_types`, automation, flexible targeting, destination, promoted object, ставки, attribution, soft placement controls, learning/issue данные. `/ads` сохраняет доступные identity/story/CTA, `asset_feed_spec`, `media_sourcing_spec`, template, enhancements, multi-advertiser, review/issues. Отсутствующее поле означает отсутствие значения в ответе Meta. Нельзя считать отсутствие поля подтверждением `OPT_OUT`.

## Частная загрузка локального изображения

1. `POST /assets/images/uploads`, `multipart/form-data`, единственный `file`: JPEG или PNG, до 8 MiB. Сервис проверяет сигнатуру/размеры из заголовка, до 12000×12000 и 50 млн пикселей. Это не полное декодирование и не одобрение материала Meta.
2. Получите `id`, metadata (`sha256,width,height,mime,size,name`), `expires_at`, `state:staged`, `meta_uploaded:false`. Байты хранятся зашифрованными в частной таблице максимум час и удаляются в одной транзакции с успешным receipt импорта. Лимит — десять текущих staging-записей на подключение. Обслуживание worker удаляет истёкшие записи.
3. Подготовьте обычную durable операцию: `{"action":"image.upload","params":{"upload_id":"<UUID>"}}`, сохранив `Idempotency-Key` и `plan_hash`.
4. Выполните её один раз. Meta получает base64 `bytes` через `/act_{id}/adimages`. Публичный хостинг не нужен. Receipt содержит `hash`, размеры, `state:uploaded`, `eligibility:requires_creative_validation`.
5. Используйте hash в creative; проверьте Meta validation и состояние объявления.

`/actions/validate` для импорта изображения возвращает `image_validation_unavailable`. Prepare проверяет владельца, metadata и срок staging; execute повторяет проверку. Байты не попадают в план, receipt или HTTP-ответ. При неопределённом результате импорта действует общий `uncertain` guard. Повтор succeeded execute возвращает исходный receipt.

## Ручные шаблоны Direct

Это версионированные шаблоны **нашего сервиса**. Публичный API Saved Templates из Ads Manager и его UI-кнопка Switch to new version не подтверждены. Meta Page `welcome_message_flows` относится к другому partner-app CTX контракту; здесь он не используется.

| Метод | Запрос |
| --- | --- |
| POST `/chat-templates` | `{name,body}` → `{id,version:1,…}` |
| GET `/chat-templates` | Список; дальше `cursor={UUID}` |
| GET `/chat-templates/{UUID}?version=1` | Конкретная сохранённая версия; без version — текущая |
| PUT `/chat-templates/{UUID}` | `{name,body,expected_version}` → новая версия |
| DELETE `/chat-templates/{UUID}` | `{expected_version}` → архивирование с сохранением версий |

`body`:

```json
{
  "greeting":"oi ⟡\nme conta qual flash tu curtiu",
  "questions":[
    {"title":"quero reservar um flash","response":null},
    {"title":"quero saber o valor","response":null},
    {"title":"como funciona a reserva?","response":null}
  ],
  "ai_generated_icebreakers":false
}
```

Приветствие 1–1000 символов, до четырёх вопросов (title до 80), response — null либо явно выбранный текст до 1000 символов. Только `ai_generated_icebreakers:false` разрешён этим ручным контрактом. Сериализация отправляет VISUAL_EDITOR v2 и явные false-флаги AI и performance booster. Содержание вопросов/ответов проверяет Meta.

Изменение создаёт новую неизменяемую версию тела; старые остаются доступными. `expected_version` предотвращает потерю параллельного изменения (`409 template_version_changed`). Архивирование помечает запись; выбранные по явному номеру версии сохраняются. Оно не обновляет и не отключает существующую рекламу. Лимиты: 200 шаблонов на подключение, 100 версий на шаблон.

## Click-to-Instagram Direct creative

`creative.create` с `creative.kind:instagram_direct` требует:

- `page_id`, `instagram_user_id`, `instagram_legacy_id` из профиля (`ig_id`);
- `adset_id` — группа назначения, уже созданная в `PAUSED`;
- `media:{kind:"image",image_hash}` либо `{kind:"video",video_id,thumbnail_hash}`; все ресурсы принадлежат кабинету, видео готово;
- `message`, необязательный `title`;
- ровно одно из `welcome:{…}` или `template:{id:"<service-template-UUID>",version:1}`;
- явные `degrees_of_freedom_spec:{creative_features_spec:{…}}` и `contextual_multi_ads:{enroll_status:"OPT_OUT"|"OPT_IN"}`.

Сервис проверяет Page → Instagram → legacy ID и группу: `OUTCOME_ENGAGEMENT / CONVERSATIONS / INSTAGRAM_DIRECT / IMPRESSIONS`, совпадающую Page в promoted object. Другие Direct-комбинации этим первым контрактом не принимаются. CTA — `INSTAGRAM_MESSAGE`, `app_destination:INSTAGRAM_DIRECT`, Direct-ссылка содержит подтверждённый `ig_id`. Ручной destination сохраняется.

Подготовка читает выбранную версию шаблона, сохраняет её в dependencies и `effective_action`, затем выполняет точный Meta `validate_only`. Перед execute повторяет проверки. Обновление текущей версии шаблона не меняет уже подготовленный creative. Новая версия для существующего ad выбирается созданием нового creative и отдельным `ad.update`; сам шаблон ничего не публикует.

## Улучшения, padding и размещения

У всех creative kinds доступны `degrees_of_freedom_spec.creative_features_spec` и `contextual_multi_ads`. Каждый выбранный feature задаётся `{enroll_status:"OPT_OUT"|"OPT_IN"}`; `enhance_cta`/`text_optimizations` могут также содержать `customizations:{text_extraction:{enroll_status:…}}`. Реестр полей — `featureNames` в `src/lib/ads/creative.ts`. Неуказанные индивидуальные переключатели остаются политикой Meta. Для ручного оформления перечислите все относящиеся к материалу функции явно и проверьте readback. Deprecated `standard_enhancements` в новых запросах отвергается; Meta требует индивидуальные функции. SDK-поле само по себе не гарантирует доступность конкретной комбинации.

`media_sourcing_spec.images` принимает до десяти явно выбранных `{hash,source,opt_in_status,variant_types?}`. Источники ограничены наблюдаемыми `multi_media`, `padding`, `uncrop`, `recomposition`; статусы `opt_in`/`opt_out`, варианты `SQUARE`,`HORIZONTAL`,`VERTICAL`,`FULLSCREEN_VERTICAL`. Hash проверяется через библиотеку кабинета. Если padding-версия присутствует только в readback существующего creative, передайте `source_creative_id` внутри media sourcing: сервис докажет принадлежность creative кабинету и проверит выбранный hash среди его variants. Служебный proof ID не передаётся провайдеру. Отправляйте выбранные padding-версии и явные opt-out для нежелательных вариантов. Произвольная генерация новых Meta AI материалов этим маршрутом не выполняется. Внутренняя структура `related_media` доступна для чтения; универсальный переключатель её записи не подтверждён.

Image/video/Direct могут передавать ограниченный `asset_feed_spec`: до 10 уникальных image hashes либо video IDs, уникальные adlabels, bodies, titles, HTTPS link_urls, один CTA, `SINGLE_IMAGE`/`SINGLE_VIDEO`, `PLACEMENT`/`DEGREES_OF_FREEDOM`, rules с platforms/positions и ссылками на labels. Сервис проверяет ссылки, уникальность media, собственность каждого ресурса и публичность URLs. Основные message/title/link/media должны совпадать с основными значениями feed; это предотвращает скрытую подмену базового материала. Meta устанавливает допустимость сочетания с Direct и objective; проверка без успешной validation не даёт права создавать объект. Для Direct feed сервис формирует identity-only object_story_spec и CTA с legacy ID внутри asset feed; live validation такого варианта прошла. Каждый новый layout всё равно требует точной validation; см. [матрицу](ADS_PARITY_AUDIT.md).

У image и image-элементов asset feed доступен `image_crops`: ограниченные ключи формата `100x100`,`100x72`,`191x100`,`300x400`,`400x150`,`400x500`,`600x360`,`90x160`, каждая область `[[x1,y1],[x2,y2]]`. Координаты не преобразуются сервисом; проверяется положительная область, совместимость конкретного размера проверяет Meta. Padding готовится внешним редактором, затем загружается отдельным изображением. Наличие variants/crops не гарантирует сохранение рисунка при любых итоговых размещениях: проверяйте preview/readback.

`carousel` поддерживает `page_id`, optional `instagram_user_id`, `link`, `message`, optional CTA, 2–10 cards `{image_hash,link,title,description?}`. `multi_share_optimized` и `multi_share_end_card` требуют явного boolean. Изображения принадлежат кабинету; все назначения проверяются. Direct carousel в этом контракте не реализован.

## Rate limit и продолжение

429 содержит `Retry-After`, `retry_after_seconds`, `retry_scope`, `retry_source`, `retryable`. Сервис использует заголовок Retry-After, оценку Meta business usage или fallback 60 секунд. Оценка business usage переводится из минут и ограничена 24 часами. Короткий отказ до одной секунды для чтения/validation повторяется максимум один раз внутри общего deadline. Длительное ожидание выполняет вызывающий агент.

Если prepare получил 429 до сохранения операции, подождите указанный интервал и повторите **тот же запрос с тем же ключом**. Если execute завершился preflight `cancelled`, write не отправлялся: после ожидания нужна новая проверка и новый prepare/key. Definite provider write rejection сохраняется `failed`; автоматического POST retry нет. `uncertain` запрещает повторение, даже если ошибка также содержит сведения о rate limit.

Standalone `/actions/validate` возвращает `meta_validated:true`, но не резервирует проверенные данные. Обычный prepare status update может вернуть false: это проверка зависимостей/бюджета; Meta validation выполняется отдельно. Для Instagram creative она обязательна при prepare и снова при execute.

## Основание контракта

[Матрица возможностей и датированные проверки](ADS_PARITY_AUDIT.md) разделяет поля официального SDK, реальные ответы Meta и проверки нашей реализации. Перед выпуском примените `20261011000001_ads_creative_assets.sql`, обновите app и worker, проверьте права и свежие ответы. Этот документ не подтверждает, что локальные доработки уже развёрнуты на сервере.
