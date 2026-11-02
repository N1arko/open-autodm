# Existing-post реклама на профиль — 2 ноября 2026

В 11:09 America/Sao_Paulo (14:09 UTC) app и worker обновлены до runtime `9f75e68`,
общий image `sha256:30cd634d10afc4a558ac8717685e80ff7ab564cfc3fe3a3e7aa7473de0a4e136`.
Включены существующие Instagram posts/Reels с `VIEW_INSTAGRAM_PROFILE`, ранее подготовленные
профильная validation/диагностика и обработка usage/backoff. Код собран из актуальной
локальной базы `0416977`; publishing, Instagram operations, worker, зависимости и миграции
побайтово совпадают с прежним production `ce46e2f`. Общие advertising/HTTP error компоненты
обновлены по контракту. Миграций и новых runtime env нет.

Прошли 55 unit и 124 integration теста, typecheck, локальная и серверная build,
проверка ссылок и `git diff --check`. Audit на прежнем lockfile: 0 critical, 2 high,
7 moderate. High относятся к Zod 3 и транзитивному Undici 7; Zod исправляется предложенным
npm переходом на 4.x, который требует отдельной совместимой миграции всех схем.
Остальные находки относятся к Cloudflare tooling/glob/minimatch. Успешный аудит без
находок не заявляется; текущая GitHub CI использует обязательный `npm audit` и может
останавливаться на этом шаге. Зависимости данным выпуском не менялись.

После запуска прошли 13 проверок публичного `https://autodm.niar42.com`:

- health и авторизация/проверка обязательной Page в новом теле;
- exact existing-post `actions/validate`: source `18181361419431354`, Instagram
  `17841419413695848`, Page `1397828260071694`, кабинет `2121416662133182`, ad set
  `120252153520050304`; source owner/type проверены, обе Meta validation успешны;
- свежие кампании/ad sets/ads обоих подключённых кабинетов, все страницы;
- обе страницы публикаций: все 65 ID, входные параметры, исторические статусы,
  media/container IDs и сохранённая provider diagnostics совпали с исходным снимком.

Рабочий ad `120252153614980304` сохранил creative `1413868103782246`, исходный source ID
и `VIEW_INSTAGRAM_PROFILE`; readback показал status/effective_status `ACTIVE`.
Бюджет, аудитория, срок, статусы и creative IDs во всех проверенных объектах сохранены.
Новых боевых рекламных объектов, активаций или публичных публикаций проверки не создавали.
Real-write сценарии проверены на fake Meta, включая PAUSED, отдельную активацию,
повтор ключа/hash, смену source dependencies и `uncertain` без повторной записи.

Runtime `.env.local` сохранён по SHA-256, DATABASE_URL отсутствует в обоих контейнерах.
App/worker используют один image, без перезапусков и ошибок в логах при проверке.
Перед выпуском сверены 227 runtime-файлов прежней версии и 281 файл кандидата.
Для сборки освобождён старый неиспользуемый build cache; рабочие/rollback images,
volumes и данные соседних сервисов сохранены.

Архив отката: `/opt/open-autodm-releases/20261102-existing-reels/` — исходники с env,
проверенный `public-before.dump` PostgreSQL 17, прежний `.release.json` и ID image.
Предыдущий image: `open-autodm:rollback-20261102-existing-reels`. При откате восстановите
исходники/конфигурацию и согласованно пересоздайте app/worker из прежнего image.
Схема этим выпуском не менялась; восстановление базы требует отдельного поручения.

Матрица форматов и grants: [ADS_EXISTING_POSTS.md](../ADS_EXISTING_POSTS.md).
Живой validation подтверждён для указанного Reel. FEED image/video/carousel покрыты
контрактом/fixtures и требуют точной Meta validation каждого случая; Story/Live,
чужие и partnership posts вне этого профильного пути. Точная причина первоначального
502 без диагностики не устанавливалась задним числом.
