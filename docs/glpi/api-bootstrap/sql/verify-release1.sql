-- Проверочные запросы к БД GLPI (только чтение) — Релиз 1 HOFI.
-- Выполняет администратор на сервере GLPI:
--   mysql -u <DB_USER> -p <DB_NAME> < verify-release1.sql
-- Ни одного INSERT/UPDATE/DELETE здесь нет и быть не должно: это средство
-- проверки, а не настройки. Настройка — только через интерфейс или API.
--
-- Имена таблиц приведены для GLPI 10.x. В 11.x часть таблиц переименована,
-- перед запуском сверьтесь со схемой конкретного инстанса.

SELECT '=== 1. Базовая конфигурация ===' AS check_name;
SELECT name, value
  FROM glpi_configs
 WHERE context = 'core'
   AND name IN ('version','url_base','timezone','use_notifications',
                'notifications_mailing','admin_email','admin_reply',
                'default_mailcollector_filesize_max','use_anonymous_helpdesk')
 ORDER BY name;

SELECT '=== 2. Cron: режим и состояние (mode 2 = внешний CLI) ===' AS check_name;
SELECT name,
       CASE state WHEN 0 THEN 'ВЫКЛЮЧЕНА' WHEN 1 THEN 'ожидание' ELSE 'выполняется' END AS state,
       CASE mode  WHEN 1 THEN 'GLPI (плохо)' WHEN 2 THEN 'CLI (правильно)' END AS mode,
       frequency, lastrun
  FROM glpi_crontasks
 WHERE name IN ('mailgate','slaticket','olaticket','queuednotification',
                'closeticket','watcher','syncldapusers')
 ORDER BY name;
-- Ожидание: все нужные задачи state=1, mode=CLI, lastrun свежее 10 минут.
-- mode=GLPI означает, что задача выполняется только когда кто-то открыл
-- интерфейс. Ночью и в выходные SLA и почта стоят.

SELECT '=== 3. Календарь и рабочие часы ===' AS check_name;
SELECT c.id, c.name, c.is_recursive,
       CASE s.day WHEN 0 THEN 'вс' WHEN 1 THEN 'пн' WHEN 2 THEN 'вт'
                  WHEN 3 THEN 'ср' WHEN 4 THEN 'чт' WHEN 5 THEN 'пт'
                  WHEN 6 THEN 'сб' END AS day_name,
       s.begin, s.end
  FROM glpi_calendars c
  LEFT JOIN glpi_calendarsegments s ON s.calendars_id = c.id
 ORDER BY c.name, s.day;
-- Ожидание: HOFI 5x9 -> пн..пт 09:00:00-18:00:00, ровно 5 строк.

SELECT '=== 4. Нерабочие дни, привязанные к календарю ===' AS check_name;
SELECT c.name AS calendar, h.name AS holiday, h.begin_date, h.end_date, h.is_perpetual
  FROM glpi_calendars_holidays ch
  JOIN glpi_calendars c ON c.id = ch.calendars_id
  JOIN glpi_holidays  h ON h.id = ch.holidays_id
 ORDER BY h.begin_date;

SELECT '=== 5. SLM и SLA ===' AS check_name;
SELECT m.name AS slm, cal.name AS calendar, s.name AS sla,
       CASE s.type WHEN 0 THEN 'TTO (реакция)' WHEN 1 THEN 'TTR (решение)' END AS sla_type,
       s.number_time, s.definition_time
  FROM glpi_slas s
  JOIN glpi_slms m  ON m.id = s.slms_id
  LEFT JOIN glpi_calendars cal ON cal.id = m.calendars_id
 ORDER BY m.name, s.type, s.name;
-- Ожидание: 6 строк, календарь у SLM заполнен. Пустой календарь = расчёт 24/7.

SELECT '=== 6. Категории без группы ответственных (должно быть пусто) ===' AS check_name;
SELECT id, completename, is_helpdeskvisible
  FROM glpi_itilcategories
 WHERE is_helpdeskvisible = 1
   AND (groups_id IS NULL OR groups_id = 0);

SELECT '=== 7. Родительские категории, видимые пользователю (должно быть пусто) ===' AS check_name;
SELECT p.id, p.completename
  FROM glpi_itilcategories p
 WHERE p.is_helpdeskvisible = 1
   AND EXISTS (SELECT 1 FROM glpi_itilcategories c WHERE c.itilcategories_id = p.id);

SELECT '=== 8. Дубликаты категорий (последствие повторного запуска мимо идемпотентности) ===' AS check_name;
SELECT completename, COUNT(*) AS cnt
  FROM glpi_itilcategories
 GROUP BY completename HAVING COUNT(*) > 1;

SELECT '=== 9. Группы исполнителей ===' AS check_name;
SELECT g.id, g.name, g.is_assign, g.is_watcher, g.is_recursive,
       (SELECT COUNT(*) FROM glpi_groups_users gu WHERE gu.groups_id = g.id) AS members
  FROM glpi_groups g
 ORDER BY g.name;
-- Ожидание: is_assign=1 и members > 0. Группа без людей — заявка «в никуда».

SELECT '=== 10. Шаблон заявки: обязательные / скрытые / предзаполненные поля ===' AS check_name;
SELECT t.name AS template, 'обязательное' AS kind, f.num, NULL AS value
  FROM glpi_tickettemplatemandatoryfields f JOIN glpi_tickettemplates t ON t.id = f.tickettemplates_id
UNION ALL
SELECT t.name, 'скрытое', f.num, NULL
  FROM glpi_tickettemplatehiddenfields f JOIN glpi_tickettemplates t ON t.id = f.tickettemplates_id
UNION ALL
SELECT t.name, 'по умолчанию', f.num, f.value
  FROM glpi_tickettemplatepredefinedfields f JOIN glpi_tickettemplates t ON t.id = f.tickettemplates_id
 ORDER BY 1, 2, 3;

SELECT '=== 11. Шаблон по умолчанию в сущности ===' AS check_name;
SELECT e.id, e.name, e.tickettemplates_id, t.name AS template, e.calendars_id, c.name AS calendar,
       e.autoclose_delay
  FROM glpi_entities e
  LEFT JOIN glpi_tickettemplates t ON t.id = e.tickettemplates_id
  LEFT JOIN glpi_calendars c ON c.id = e.calendars_id;
-- Ожидание для корневой сущности: шаблон HOFI Base, календарь HOFI 5x9,
-- autoclose_delay = 7. Значение -1 означает «наследовать», 0 — «отключено».

SELECT '=== 12. Профили: нештатные и интерфейс ===' AS check_name;
SELECT id, name, interface, is_default
  FROM glpi_profiles
 ORDER BY id;
-- Ожидание: штатные (id 1..7) с исходными именами, плюс HOFI L1 / HOFI IT /
-- HOFI Contractor / HOFI Service. is_default=1 ровно у Self-Service.

SELECT '=== 13. Носители Super-Admin (ожидается не более 2 поимённых) ===' AS check_name;
SELECT u.name AS login, u.realname, u.firstname, e.name AS entity, pu.is_recursive
  FROM glpi_profiles_users pu
  JOIN glpi_profiles p ON p.id = pu.profiles_id
  JOIN glpi_users u ON u.id = pu.users_id
  LEFT JOIN glpi_entities e ON e.id = pu.entities_id
 WHERE p.name = 'Super-Admin';

SELECT '=== 14. Правила: порядок выполнения ===' AS check_name;
SELECT sub_type, ranking, name, is_active,
       CASE is_recursive WHEN 1 THEN 'рекурсивно' ELSE '-' END AS recursive
  FROM glpi_rules
 WHERE sub_type IN ('RuleTicket','RuleRight','RuleMailCollector')
 ORDER BY sub_type, ranking;
-- Ожидание для RuleTicket: сначала маршрутизация по категориям,
-- затем правила SLA, ПОСЛЕДНИМ — резервное правило на SD-L1.

SELECT '=== 15. Уведомления: включённые события и шаблоны ===' AS check_name;
SELECT n.id, n.name, n.itemtype, n.event, n.is_active, t.name AS template
  FROM glpi_notifications n
  LEFT JOIN glpi_notifications_notificationtemplates nt ON nt.notifications_id = n.id
  LEFT JOIN glpi_notificationtemplates t ON t.id = nt.notificationtemplates_id
 ORDER BY n.itemtype, n.event;
-- Ожидание: активны только уведомления по Ticket, шаблон проставлен у каждого.
-- Уведомление без шаблона или без получателя молча не отправляется.

SELECT '=== 16. Антипетля: адрес отправителя против адреса сборщика ===' AS check_name;
SELECT (SELECT value FROM glpi_configs WHERE context='core' AND name='admin_email') AS sender_email,
       m.name AS collector, m.login AS collector_login, m.is_active
  FROM glpi_mailcollectors m;
-- Ожидание: sender_email НЕ совпадает с ящиком сборщика. Совпадение —
-- это цикл «уведомление -> сборщик -> новая заявка» (риск RR-6).

SELECT '=== 17. Очередь уведомлений: застрявшие письма ===' AS check_name;
SELECT COUNT(*) AS in_queue,
       MIN(create_time) AS oldest,
       SUM(CASE WHEN is_deleted = 1 THEN 1 ELSE 0 END) AS deleted
  FROM glpi_queuednotifications;
-- Растущая очередь при пустом lastrun у queuednotification = cron не работает.
