# Проверки до настройки интеграций в GLPI

**Статус:** подготовлено к выполнению. Команды выполняет администратор
заказчика **с сервера GLPI** (если не указано иное) — именно оттуда пойдут
реальные запросы.

**Зачем:** отделить проблемы сети и учётных данных от проблем конфигурации
GLPI. Если `ldapsearch` не отвечает, настраивать каталог в интерфейсе
бессмысленно — результат будет тот же, но с менее понятным сообщением об
ошибке.

**Порядок диагностики (не менять):**
1. Сеть и порт → 2. Учётные данные → 3. Права сервисной учётки →
4. Конфигурация в GLPI → 5. Логи → 6. Автодействия.

**Правило обращения с паролями:** не писать пароль в командной строке
(он попадёт в `~/.bash_history` и в `ps`). Использовать интерактивный ввод
(`-W`), файл с правами 600 (`-y`) или переменную окружения, прочитанную
из защищённого источника.

```bash
# безопасный ввод пароля в переменную окружения на время сессии
read -rs -p "Пароль: " SVC_PASSWORD; export SVC_PASSWORD; echo
# по окончании работы
unset SVC_PASSWORD; history -c
```

Плейсхолдеры (`<LDAP_HOST>`, `<IMAP_PASSWORD>` и т.д.) заменяются реальными
значениями только в терминале, в документы они не возвращаются.

---

## 0. Базовые проверки сети (для всех интеграций)

```bash
# 0.1 Разрешение имени: отвечает ли DNS и тем ли адресом
getent hosts <HOST>
dig +short <HOST>

# 0.2 Доступность порта (любая из команд)
nc -zv <HOST> <PORT>
timeout 5 bash -c '</dev/tcp/<HOST>/<PORT>' && echo "порт открыт" || echo "порт закрыт/фильтруется"

# 0.3 Куда реально идёт трафик (если есть подозрение на прокси/NAT)
ip route get $(dig +short <HOST> | head -1)
```

| Результат | Значение |
|---|---|
| `nc` печатает `succeeded!` / `open` | TCP-соединение установлено; дальше проверяем протокол и учётные данные |
| Мгновенный `Connection refused` | на той стороне никто не слушает порт (сервис выключен или неверный порт) |
| Зависание до таймаута | пакеты гасит межсетевой экран — задача сетевого администратора, не GLPI |
| `Name or service not known` | не резолвится имя: DNS-сервер, `/etc/resolv.conf`, опечатка в FQDN |
| Резолвится в неожиданный адрес | split-DNS или запись в `/etc/hosts` — частая причина «в браузере работает, а с сервера нет» |

---

## 1. LDAP / Active Directory

Пакет: `ldap-utils` (Debian/Ubuntu) или `openldap-clients` (RHEL).

### 1.1. Порт и TLS

```bash
# LDAPS (636): сертификат, цепочка, срок действия
openssl s_client -connect <LDAP_HOST>:636 -servername <LDAP_HOST> -showcerts </dev/null

# STARTTLS на 389
openssl s_client -connect <LDAP_HOST>:389 -starttls ldap </dev/null
```

| Строка вывода | Значение |
|---|---|
| `Verify return code: 0 (ok)` | сертификат доверен, LDAPS можно использовать |
| `unable to get local issuer certificate (20/21)` | нет корневого сертификата внутреннего CA на сервере GLPI → положить `<LDAP_CA_CERT>` в системное хранилище (`/usr/local/share/ca-certificates/` + `update-ca-certificates`) |
| `Hostname mismatch` | в сертификате DC другое имя: подключаться по FQDN из сертификата |
| `certificate has expired` | просрочен сертификат DC — задача администратора домена |
| Соединение обрывается сразу | на 636 сервис не слушает: в домене не развёрнут LDAPS (нужен сертификат на DC) |

### 1.2. Bind сервисной учёткой

```bash
# Кто я: самая быстрая проверка учётных данных
ldapwhoami -x -H ldaps://<LDAP_HOST>:636 -D "<LDAP_BIND_DN>" -W

# То же для STARTTLS
ldapwhoami -x -ZZ -H ldap://<LDAP_HOST>:389 -D "<LDAP_BIND_DN>" -W
```

Успех — вывод вида `u:HOFI\svc-glpi`. В AD вместо DN допустим UPN:
`-D "svc-glpi@<AD_DOMAIN>"`.

| Ошибка | Причина |
|---|---|
| `ldap_bind: Invalid credentials (49)` | неверный пароль или DN. Подстрока `data 52e` — неверный пароль; `data 525` — нет такого пользователя; `data 532` — пароль истёк; `data 533` — учётка отключена; `data 775` — учётка заблокирована |
| `ldap_sasl_interactive_bind: Can't contact LDAP server (-1)` | не дошли до сервера (см. раздел 0) либо TLS не установился |
| `Confidentiality required (13)` | на DC включено требование шифрования (LDAP signing/channel binding): использовать LDAPS 636 или STARTTLS |
| `Strong(er) authentication required (8)` | то же: простой bind без шифрования запрещён политикой домена |

### 1.3. Проверка фильтра импорта

Тот же фильтр, что будет вписан в GLPI (см. `ldap-ad.md`, раздел 4):

```bash
ldapsearch -x -H ldaps://<LDAP_HOST>:636 \
  -D "<LDAP_BIND_DN>" -W \
  -b "<LDAP_BASE_DN>" \
  -E pr=1000/noprompt \
  "(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2))(mail=*)(sAMAccountName=*))" \
  sAMAccountName mail sn givenName department title telephoneNumber memberOf
```

Что смотреть:

```bash
# сколько записей вернулось (ожидаем порядок 100-500)
ldapsearch ... "<ФИЛЬТР>" dn | grep -c "^dn:"

# у скольких заполнен mail (должно совпадать с числом выше — фильтр это гарантирует)
ldapsearch ... "<ФИЛЬТР>" mail | grep -c "^mail:"
```

| Результат | Значение |
|---|---|
| Число записей ≈ числу сотрудников | фильтр корректен, можно переносить в GLPI **без изменений** |
| `numEntries: 0`, но bind успешен | неверный `<LDAP_BASE_DN>` (проверить регистр и порядок DC) или слишком узкий фильтр |
| Ровно 1000 записей | сработало ограничение выдачи AD → в GLPI обязательно включить постраничный поиск (`-E pr=1000` подтверждает, что он поддерживается) |
| `Size limit exceeded (4)` | то же ограничение: без paging AD не отдаст больше 1000 |
| Записей заметно больше ожидаемого | в область попали служебные OU/ящики-ресурсы → сузить BaseDN |
| `Operations error (1)` с примечанием про `In order to perform this operation a successful bind must be completed` | анонимный запрос к AD: не указан `-D`/`-W` |

### 1.4. Проверка конкретного пользователя и групп

```bash
# все атрибуты одного пользователя - чтобы сверить маппинг из ldap-ad.md
ldapsearch -x -H ldaps://<LDAP_HOST>:636 -D "<LDAP_BIND_DN>" -W \
  -b "<LDAP_BASE_DN>" "(sAMAccountName=<TEST_USER>)"

# членство в группах (значения для правил прав)
ldapsearch ... "(sAMAccountName=<TEST_USER>)" memberOf

# состав группы, на которую будет опираться правило
ldapsearch ... -b "<LDAP_BASE_DN>" "(&(objectClass=group)(cn=<AD_GROUP_GLPI_TECHNICIANS>))" member
```

Успех: у тестового пользователя заполнены `mail`, `sn`, `givenName`; DN
групп из `memberOf` совпадают с тем, что будет указано в правилах GLPI
посимвольно (регистр и пробелы в DN важны для регулярных выражений).

### 1.5. Проверка входа пользователя (не сервисной учётки)

```bash
# bind от имени обычного пользователя - подтверждает, что вход в GLPI сработает
ldapwhoami -x -H ldaps://<LDAP_HOST>:636 -D "<TEST_USER>@<AD_DOMAIN>" -W
```

Выполняет сам тестовый пользователь либо администратор с его согласия. Если
этот bind не проходит — вход в GLPI тоже не пройдёт, и причина не в GLPI.

---

## 2. IMAP (приём заявок)

### 2.1. Порт и TLS

```bash
# IMAPS (993)
openssl s_client -connect <IMAP_HOST>:993 -servername <IMAP_HOST> -crlf </dev/null

# IMAP + STARTTLS (143)
openssl s_client -connect <IMAP_HOST>:143 -starttls imap -crlf </dev/null
```

Успех: `Verify return code: 0 (ok)` и приветствие сервера
`* OK ... IMAP4rev1`. Ошибки сертификата читаются так же, как в 1.1.

### 2.2. Аутентификация и содержимое ящика

Интерактивная сессия (ввод команд вручную после установления TLS):

```bash
openssl s_client -connect <IMAP_HOST>:993 -servername <IMAP_HOST> -crlf
```

Далее построчно (пароль вводится в терминал и в историю shell не попадает):

```
a1 LOGIN <IMAP_LOGIN> <IMAP_PASSWORD>
a2 LIST "" "*"
a3 SELECT INBOX
a4 STATUS INBOX (MESSAGES UNSEEN)
a5 LOGOUT
```

| Ответ | Значение |
|---|---|
| `a1 OK ... LOGIN completed` | учётные данные верны, IMAP для ящика включён |
| `a1 NO [AUTHENTICATIONFAILED]` | неверный логин/пароль **или** логин нужен в другом формате (`DOMAIN\user` вместо `user@domain`) |
| `a1 NO LOGIN failed ... basic authentication is disabled` | Microsoft 365/Exchange с отключённым Basic Auth → OAuth (см. `mail-collector.md`, 6.4) |
| `a2` показывает `GLPI/accepted`, `GLPI/refused` | папки архива созданы, их имена можно вписывать в коллектор |
| `a2` не показывает нужных папок | папки не созданы либо у учётки нет к ним доступа |
| `a4` показывает большой `MESSAGES` | в ящике уже есть письма: включить «Собирать только непрочитанные», иначе GLPI создаст заявки по всей истории |
| `a3 NO Mailbox does not exist` | неверное имя папки (учитывать регистр и кодировку: кириллические имена папок не использовать) |

Проверка, что учётка **не видит чужие ящики** (требование минимальных прав):
в выводе `a2 LIST` должны быть только папки самого ящика поддержки.

### 2.3. Тестовое письмо-автоответ (проверка правил анти-петли)

Выполняется **после** создания правил из `mail-collector.md` (раздел 8.3) и
до объявления адреса пользователям. Пакет: `swaks`.

```bash
# 1. обычное письмо - должна появиться заявка
swaks --to <SUPPORT_MAILBOX> --from <TEST_USER>@<AD_DOMAIN> \
      --server <SMTP_HOST>:<SMTP_PORT> --tls \
      --auth-user <SMTP_LOGIN> --auth-password "$SMTP_PASSWORD" \
      --header "Subject: TEST-1 обычное письмо" \
      --body "Проверка приёма заявок"

# 2. письмо с Auto-Submitted - заявки быть НЕ должно
swaks --to <SUPPORT_MAILBOX> --from <TEST_USER>@<AD_DOMAIN> \
      --server <SMTP_HOST>:<SMTP_PORT> --tls \
      --auth-user <SMTP_LOGIN> --auth-password "$SMTP_PASSWORD" \
      --header "Subject: TEST-2 автоответ" \
      --header "Auto-Submitted: auto-replied" \
      --body "Это имитация автоответчика"

# 3. письмо с X-Auto-Response-Suppress - заявки быть НЕ должно
swaks --to <SUPPORT_MAILBOX> --from <TEST_USER>@<AD_DOMAIN> \
      --server <SMTP_HOST>:<SMTP_PORT> --tls \
      --auth-user <SMTP_LOGIN> --auth-password "$SMTP_PASSWORD" \
      --header "Subject: TEST-3 Out of Office: отпуск" \
      --header "X-Auto-Response-Suppress: All" \
      --body "Имитация OOF"

# 4. письмо от no-reply - заявки быть НЕ должно
swaks --to <SUPPORT_MAILBOX> --from noreply@<AD_DOMAIN> \
      --server <SMTP_HOST>:<SMTP_PORT> --tls \
      --auth-user <SMTP_LOGIN> --auth-password "$SMTP_PASSWORD" \
      --header "Subject: TEST-4 уведомление системы" \
      --body "Имитация технического отправителя"

# 5. ответ в существующую заявку (номер взять из теста 1)
swaks --to <SUPPORT_MAILBOX> --from <TEST_USER>@<AD_DOMAIN> \
      --server <SMTP_HOST>:<SMTP_PORT> --tls \
      --auth-user <SMTP_LOGIN> --auth-password "$SMTP_PASSWORD" \
      --header "Subject: [HOFI #0000123] TEST-1 обычное письмо" \
      --body "Дополнение к заявке"
```

Ожидаемый итог после запуска `mailgate`:

| Тест | Ожидание | Где проверить |
|---|---|---|
| 1 | создана заявка | список заявок |
| 2, 3, 4 | заявки нет, письмо в папке `<IMAP_FOLDER_REFUSED>` | «Отклонённые письма» + сама папка в ящике |
| 5 | фолоуап в заявке, новой заявки нет | карточка заявки |

Если тесты 2–4 создали заявки — правила не работают (порядок правил, опечатка
в регулярном выражении, правило неактивно). **Коллектор в продуктив не
выпускается**, пока тесты 2–4 не проходят: цена ошибки описана в
`mail-collector.md`, раздел 8.4.

---

## 3. SMTP (уведомления)

### 3.1. Порт и TLS

```bash
# STARTTLS на 587
openssl s_client -connect <SMTP_HOST>:587 -starttls smtp -crlf </dev/null

# SMTPS на 465
openssl s_client -connect <SMTP_HOST>:465 -servername <SMTP_HOST> -crlf </dev/null
```

Смотреть в выводе строку `250-STARTTLS` и список методов
`250-AUTH LOGIN PLAIN` — он показывает, поддерживает ли сервер
аутентификацию вообще (у внутренних релеев её может не быть, там работает
разрешение по IP).

### 3.2. Отправка тестового письма

```bash
swaks --to <IT_ADMIN_EMAIL> --from <SUPPORT_MAILBOX> \
      --server <SMTP_HOST>:<SMTP_PORT> --tls \
      --auth-user <SMTP_LOGIN> --auth-password "$SMTP_PASSWORD" \
      --header "Subject: GLPI SMTP check" \
      --body "Проверка отправки из контура GLPI"
```

Ключевой вариант — отправка **от имени ящика поддержки**: именно так будет
слать GLPI. Если письмо уходит от `<SMTP_LOGIN>`, но не уходит от
`<SUPPORT_MAILBOX>`, проблема в правах «отправлять от имени», а не в GLPI.

```bash
# анонимный внутренний релей (без аутентификации) - проверка разрешения по IP
swaks --to <IT_ADMIN_EMAIL> --from <SUPPORT_MAILBOX> --server <SMTP_HOST>:25
```

| Ответ сервера | Значение |
|---|---|
| `250 2.0.0 Ok: queued` | письмо принято к доставке — SMTP настраивать в GLPI можно |
| `535 5.7.8 Authentication credentials invalid` | неверный логин/пароль или отключён Basic Auth |
| `530 5.7.57 Client not authenticated` | сервер требует аутентификацию, а её не передали |
| `550 5.7.60 SendAs denied` / `550 Sender address rejected` | учётке не разрешено слать от `<SUPPORT_MAILBOX>` |
| `554 5.7.1 Relay access denied` | IP сервера GLPI не в списке разрешённых на релее |
| `421 4.7.0 Too many connections` | rate limit — признак того, что тесты запускались в цикле (или уже идёт петля) |

Проверить факт доставки: письмо должно прийти в `<IT_ADMIN_EMAIL>`, а в
заголовках полученного письма — увидеть путь `Received:` через
`<SMTP_HOST>`.

---

## 4. REST API

Подробности включения — [`api-enable.md`](api-enable.md). Здесь — минимальная
проверка доступности.

```bash
# 4.1 API включён и отвечает (ожидаем HTTP 400 с внятной ошибкой, а не 404/403)
curl -sS -i -X GET "<GLPI_URL>/apirest.php/initSession"

# 4.2 Полноценная сессия
curl -sS -X GET "<GLPI_URL>/apirest.php/initSession" \
  -H "Content-Type: application/json" \
  -H "App-Token: $GLPI_APP_TOKEN" \
  -u "$GLPI_LOGIN:$GLPI_PASSWORD"
```

| Ответ | Значение |
|---|---|
| `{"session_token":"..."}` | API включён, вход по логину/паролю разрешён, App-Token принят, IP разрешён |
| HTTP 400 `ERROR_LOGIN_PARAMETERS_MISSING` | API работает, но не переданы учётные данные — ожидаемо для 4.1 |
| HTTP 400 `ERROR_APP_TOKEN_PARAMETERS_MISSING` | не передан заголовок `App-Token` |
| HTTP 400 `ERROR_WRONG_APP_TOKEN_PARAMETER` | токен неверен **или** IP клиента вне диапазона, заданного клиенту API |
| HTTP 400 `ERROR_LOGIN_WITH_CREDENTIALS_DISABLED` | не включён «Вход с учётными данными» в настройках API |
| HTTP 401 `ERROR_GLPI_LOGIN` | неверный логин/пароль либо учётка неактивна |
| HTTP 404 | API отключён в настройках или неверный URL (`/apirest.php` против `/api.php`) |
| HTML страницы входа вместо JSON | запрос попал не на тот виртуальный хост / фронт-прокси не пробрасывает заголовки |
| Обрыв TLS | самоподписанный сертификат `<GLPI_URL>`: добавить CA в доверенные, **не** использовать `curl -k` в продуктивных скриптах |

---

## 5. Проверки на стороне сервера GLPI

Выполняются от пользователя веб-сервера (`www-data`/`apache`).

```bash
# 5.1 Наличие PHP-расширений, без которых интеграции не работают
php -m | grep -E '^(ldap|imap|openssl|mbstring|curl)$'

# 5.2 Сводка состояния инстанса: БД, кэш, почта, получатели
php /var/www/glpi/bin/console system:status

# 5.3 Права на каталоги, куда пишутся вложения и логи
ls -ld /var/www/glpi/files/_tmp /var/www/glpi/files/_log /var/www/glpi/files/_cron

# 5.4 Ручной прогон автодействий (CLI-режим)
php /var/www/glpi/front/cron.php

# 5.5 Свежие ошибки
tail -n 100 /var/www/glpi/files/_log/mailgate.log
tail -n 100 /var/www/glpi/files/_log/php-errors.log
```

| Симптом | Значение |
|---|---|
| Нет расширения `ldap` | форма каталога LDAP покажет «расширение отсутствует»; ставится пакет `php-ldap` + перезапуск PHP-FPM |
| Нет расширения `imap` | часть операций с папками недоступна; для GLPI 10 ставится `php-imap` |
| `files/_tmp` не доступен на запись | вложения из почты не импортируются (запись в `mailgate.log`) |
| `system:status` показывает получателей в ошибке | считать счётчик ошибок коллектора: проблема в разделе 2 |
| `front/cron.php` печатает ошибки блокировки | каталог `files/_lock` недоступен на запись либо cron запускается не тем пользователем |

---

## 6. Итоговый лист готовности

Настройка в интерфейсе GLPI начинается только когда все пункты — «да».

| # | Проверка | Раздел | Готово |
|---|---|---|---|
| 1 | С сервера GLPI открыт порт LDAP(S) до всех DC | 0, 1.1 | ☐ |
| 2 | `ldapwhoami` под сервисной учёткой проходит | 1.2 | ☐ |
| 3 | `ldapsearch` с боевым фильтром возвращает ожидаемое число пользователей | 1.3 | ☐ |
| 4 | У тестового пользователя заполнен `mail`, видны нужные `memberOf` | 1.4 | ☐ |
| 5 | Открыт порт IMAP, TLS доверен | 0, 2.1 | ☐ |
| 6 | `LOGIN` в ящик поддержки проходит, видны папки accepted/refused | 2.2 | ☐ |
| 7 | Открыт порт SMTP, тестовое письмо от `<SUPPORT_MAILBOX>` доставлено | 3 | ☐ |
| 8 | PHP-расширения на месте, каталоги доступны на запись | 5 | ☐ |
| 9 | Автодействия запускаются из CLI | 5.4 | ☐ |
| 10 | Правила анти-петли проверены письмами-автоответами | 2.3 | ☐ |

Пункт 10 выполняется после настройки коллектора, но **до** его вывода на
продуктив и до объявления адреса поддержки пользователям.

---

## 7. Секреты, используемые в проверках

Реальные значения не сохраняются ни в документах, ни в истории shell.

| Плейсхолдер | Где используется | Минимальные права |
|---|---|---|
| `<LDAP_BIND_PASSWORD>` | разделы 1.2–1.4 | чтение каталога, `Domain Users`, без интерактивного входа |
| `<IMAP_PASSWORD>` | раздел 2.2 | доступ только к ящику `<SUPPORT_MAILBOX>` |
| `<SMTP_PASSWORD>` | разделы 2.3, 3.2 | отправка от `<SUPPORT_MAILBOX>` |
| `$GLPI_APP_TOKEN` (`<APP_TOKEN>`) | раздел 4 | клиент API с ограничением по IP |
| `$GLPI_LOGIN` / `$GLPI_PASSWORD` | раздел 4 | учётная запись GLPI для автоматизации |

После завершения проверок: `unset SVC_PASSWORD SMTP_PASSWORD GLPI_PASSWORD
GLPI_APP_TOKEN` и очистка истории команд.
