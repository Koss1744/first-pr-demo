#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Минимальный клиент GLPI REST API (GLPI 10.x, /apirest.php) для bootstrap-скриптов
Релиза 1 HOFI.

Без внешних зависимостей: только стандартная библиотека Python 3.8+.

Ключевые свойства (см. README.md, раздел «Защита от ошибки»):
  * dry-run по умолчанию — ни один запрос на изменение не уходит без apply=True;
  * идемпотентность — перед созданием объект ищется по ключам сопоставления;
  * allow-list типов объектов — скрипт физически не может тронуть ничего,
    что не перечислено в ALLOWED_ITEMTYPES;
  * лимит изменений за запуск — защита от «случайно создал 5000 категорий»;
  * DELETE запрещён на уровне транспорта, кроме явного режима отката;
  * журнал (ledger) в JSONL — единственный источник правды для отката.

Секреты берутся ТОЛЬКО из переменных окружения. В коде — плейсхолдеры.
"""

import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Белый список типов объектов. Всё, чего здесь нет, скрипт трогать не будет.
# Сознательно отсутствуют: Profile, ProfileRight, Entity, Rule*, User,
# Notification, NotificationTarget — эти объекты создаются/правятся руками
# (см. setup-release1.md, шаги 9, 14, 18).
# ---------------------------------------------------------------------------
ALLOWED_ITEMTYPES = frozenset({
    "Group",
    "ITILCategory",
    "Calendar",
    "CalendarSegment",
    "Holiday",
    "Calendar_Holiday",
    "SLM",
    "SLA",
    "TicketTemplate",
    "TicketTemplateMandatoryField",
    "TicketTemplateHiddenField",
    "TicketTemplatePredefinedField",
    "NotificationTemplate",
    "NotificationTemplateTranslation",
})

# Типы, которые скрипт читает для проверок, но никогда не изменяет.
READ_ONLY_ITEMTYPES = frozenset({
    "Profile", "Entity", "Config", "CronTask", "Notification", "User",
})

DRY_ID_PREFIX = "DRY-"


class GlpiError(RuntimeError):
    pass


class SafetyError(RuntimeError):
    """Сработала защита. Это не сбой связи — это отказ выполнять операцию."""


def is_dry_id(value):
    return isinstance(value, str) and value.startswith(DRY_ID_PREFIX)


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Ledger:
    """Журнал операций. Каждая строка — одна операция, JSON.

    Формат строки:
      {"ts", "instance", "run_id", "step", "itemtype", "action",
       "id", "match", "payload", "dry_run"}

    action: create | create-planned | update | update-planned | skip |
            delete | delete-planned | error
    """

    def __init__(self, path, instance, run_id):
        self.path = path
        self.instance = instance
        self.run_id = run_id
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)

    def write(self, **kwargs):
        record = {
            "ts": utc_now(),
            "instance": self.instance,
            "run_id": self.run_id,
        }
        record.update(kwargs)
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
        return record

    @staticmethod
    def read(path):
        records = []
        with open(path, "r", encoding="utf-8") as fh:
            for line_no, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError as exc:
                    raise GlpiError(
                        "Журнал %s повреждён, строка %d: %s" % (path, line_no, exc)
                    )
        return records


class GlpiClient:
    def __init__(
        self,
        base_url,
        app_token=None,
        user_token=None,
        login=None,
        password=None,
        apply_changes=False,
        ledger=None,
        max_changes=120,
        allow_update=False,
        allow_delete=False,
        verbose=True,
        timeout=30,
        ca_bundle=None,
    ):
        self.base_url = base_url.rstrip("/")
        self.app_token = app_token
        self.user_token = user_token
        self.login = login
        self.password = password
        self.apply_changes = apply_changes
        self.ledger = ledger
        self.max_changes = max_changes
        self.allow_update = allow_update
        self.allow_delete = allow_delete
        self.verbose = verbose
        self.timeout = timeout
        self.session_token = None
        self.changes = 0
        self.stats = {}
        self._dry_seq = 0
        self._ssl_context = ssl.create_default_context(cafile=ca_bundle) if ca_bundle else None

    # -- вывод ------------------------------------------------------------
    def log(self, level, message):
        prefix = {"info": "  ", "plan": "[PLAN] ", "do": "[APPLY]", "warn": "[WARN] ",
                  "err": "[ERROR]", "ok": "[OK]   ", "skip": "[SKIP] "}.get(level, "")
        print("%s %s" % (prefix, message), flush=True)

    def bump(self, action):
        self.stats[action] = self.stats.get(action, 0) + 1

    # -- транспорт --------------------------------------------------------
    def _headers(self, extra=None):
        headers = {"Content-Type": "application/json"}
        if self.app_token:
            headers["App-Token"] = self.app_token
        if self.session_token:
            headers["Session-Token"] = self.session_token
        if extra:
            headers.update(extra)
        return headers

    def _request(self, method, path, params=None, payload=None, extra_headers=None):
        if method in ("POST", "PUT", "DELETE") and not self.apply_changes:
            raise SafetyError(
                "Попытка %s без --apply. Это ошибка в коде скрипта, а не в данных." % method
            )
        if method == "DELETE" and not self.allow_delete:
            raise SafetyError(
                "DELETE запрещён в этом режиме. Удаление выполняет только rollback.py."
            )

        url = "%s/%s" % (self.base_url, path.lstrip("/"))
        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        data = None
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

        req = urllib.request.Request(url, data=data, method=method,
                                     headers=self._headers(extra_headers))
        try:
            kwargs = {"timeout": self.timeout}
            if self._ssl_context:
                kwargs["context"] = self._ssl_context
            with urllib.request.urlopen(req, **kwargs) as resp:
                body = resp.read().decode("utf-8")
                if not body:
                    return None
                try:
                    return json.loads(body)
                except json.JSONDecodeError:
                    return body
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise GlpiError("HTTP %s %s -> %s: %s" % (method, url, exc.code, body))
        except urllib.error.URLError as exc:
            raise GlpiError(
                "Нет связи с %s: %s. Скрипт запускают из сети заказчика — "
                "инстанс снаружи недоступен." % (url, exc)
            )

    # -- сессия -----------------------------------------------------------
    def init_session(self):
        headers = {}
        if self.user_token:
            headers["Authorization"] = "user_token " + self.user_token
        elif self.login and self.password:
            import base64
            raw = ("%s:%s" % (self.login, self.password)).encode("utf-8")
            headers["Authorization"] = "Basic " + base64.b64encode(raw).decode("ascii")
        else:
            raise GlpiError(
                "Не задан способ аутентификации: нужен GLPI_USER_TOKEN "
                "либо GLPI_LOGIN + GLPI_PASSWORD."
            )
        # initSession читает данные, поэтому обходим запрет на изменения.
        url = "%s/initSession" % self.base_url
        req = urllib.request.Request(url, method="GET", headers=self._headers(headers))
        try:
            kwargs = {"timeout": self.timeout}
            if self._ssl_context:
                kwargs["context"] = self._ssl_context
            with urllib.request.urlopen(req, **kwargs) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise GlpiError(
                "initSession не прошёл (HTTP %s): %s\n"
                "Проверьте: включён ли REST API (Настройка -> Основная конфигурация -> "
                "API), App-Token и user_token, а также список разрешённых IP." % (exc.code, body)
            )
        self.session_token = data.get("session_token")
        if not self.session_token:
            raise GlpiError("initSession вернул ответ без session_token: %s" % data)
        return self.session_token

    def kill_session(self):
        if not self.session_token:
            return
        url = "%s/killSession" % self.base_url
        req = urllib.request.Request(url, method="GET", headers=self._headers())
        try:
            kwargs = {"timeout": self.timeout}
            if self._ssl_context:
                kwargs["context"] = self._ssl_context
            urllib.request.urlopen(req, **kwargs).read()
        except Exception:
            pass
        finally:
            self.session_token = None

    # -- чтение -----------------------------------------------------------
    def get_item(self, itemtype, item_id, params=None):
        return self._request("GET", "%s/%s" % (itemtype, item_id), params=params)

    def get_children(self, itemtype, item_id, subtype, params=None):
        if is_dry_id(item_id):
            return []
        base = {"range": "0-999"}
        if params:
            base.update(params)
        result = self._request("GET", "%s/%s/%s" % (itemtype, item_id, subtype), params=base)
        return result if isinstance(result, list) else []

    def search_by(self, itemtype, field, value, extra_params=None):
        """GET /{itemtype}?searchText[field]=value. Поиск неточный (contains),
        точное сравнение делает вызывающий код."""
        params = {"searchText[%s]" % field: value, "range": "0-999",
                  "expand_dropdowns": "0"}
        if extra_params:
            params.update(extra_params)
        try:
            result = self._request("GET", itemtype, params=params)
        except GlpiError as exc:
            if "206" in str(exc) or "400" in str(exc):
                raise
            raise
        return result if isinstance(result, list) else []

    def list_search_options(self, itemtype):
        return self._request("GET", "listSearchOptions/%s" % itemtype) or {}

    def find(self, itemtype, match, search_field=None):
        """Ищет объект по словарю точных значений match.
        search_field — поле, по которому сужается выборка на стороне GLPI."""
        self._assert_known(itemtype, write=False)
        field = search_field or ("name" if "name" in match else list(match.keys())[0])
        value = match.get(field)
        if value is None or is_dry_id(value):
            return None
        candidates = self.search_by(itemtype, field, value)
        for cand in candidates:
            if all(self._eq(cand.get(k), v) for k, v in match.items()):
                return cand
        return None

    @staticmethod
    def _eq(actual, expected):
        if actual is None:
            return expected in (None, "", 0)
        if isinstance(expected, bool):
            return int(actual) == int(expected)
        if isinstance(expected, int):
            try:
                return int(actual) == expected
            except (TypeError, ValueError):
                return False
        return str(actual).strip() == str(expected).strip()

    # -- запись -----------------------------------------------------------
    def _assert_known(self, itemtype, write=True):
        if write:
            if itemtype not in ALLOWED_ITEMTYPES:
                raise SafetyError(
                    "Тип '%s' не в белом списке ALLOWED_ITEMTYPES — запись запрещена. "
                    "Если объект действительно нужен, он создаётся руками по "
                    "setup-release1.md." % itemtype
                )
        else:
            if itemtype not in ALLOWED_ITEMTYPES and itemtype not in READ_ONLY_ITEMTYPES:
                raise SafetyError("Тип '%s' не разрешён даже для чтения." % itemtype)

    def _guard_budget(self):
        if self.changes >= self.max_changes:
            raise SafetyError(
                "Достигнут лимит изменений за запуск (%d). Это защита от массовой "
                "операции под super-Admin. Проверьте данные; если объём законный — "
                "поднимите --max-changes осознанно." % self.max_changes
            )

    def ensure(self, itemtype, match, payload=None, step="", search_field=None,
               label=None, update_fields=None):
        """Идемпотентное создание. Возвращает (id, action).

        match   — поля для поиска существующего объекта (точное сравнение);
        payload — поля создаваемого объекта (включая match);
        update_fields — какие поля разрешено доводить до нужного значения
                        у уже существующего объекта (только с --allow-update).
        """
        self._assert_known(itemtype, write=True)
        payload = dict(payload or {})
        payload.update(match)
        label = label or payload.get("name") or json.dumps(match, ensure_ascii=False)

        existing = self.find(itemtype, match, search_field=search_field)
        if existing:
            item_id = existing.get("id")
            diff = {}
            for key in (update_fields or []):
                if key in payload and not self._eq(existing.get(key), payload[key]):
                    diff[key] = {"was": existing.get(key), "will": payload[key]}
            if diff and self.allow_update:
                return self._do_update(itemtype, item_id, payload, diff, step, label)
            if diff:
                self.log("warn", "%s '%s' (id=%s) отличается от эталона: %s. "
                                 "Запустите с --allow-update, если правка ожидаема."
                         % (itemtype, label, item_id, json.dumps(diff, ensure_ascii=False)))
            self.log("skip", "%s '%s' уже существует (id=%s)" % (itemtype, label, item_id))
            self.bump("skip")
            if self.ledger:
                self.ledger.write(step=step, itemtype=itemtype, action="skip",
                                  id=item_id, match=match, payload=None,
                                  dry_run=not self.apply_changes)
            return item_id, "skip"

        return self._do_create(itemtype, payload, match, step, label)

    def _do_create(self, itemtype, payload, match, step, label):
        self._guard_budget()
        if not self.apply_changes:
            self._dry_seq += 1
            fake_id = "%s%d" % (DRY_ID_PREFIX, self._dry_seq)
            self.changes += 1
            self.bump("create-planned")
            self.log("plan", "СОЗДАТЬ %s '%s' %s"
                     % (itemtype, label, json.dumps(payload, ensure_ascii=False)))
            if self.ledger:
                self.ledger.write(step=step, itemtype=itemtype, action="create-planned",
                                  id=fake_id, match=match, payload=payload, dry_run=True)
            return fake_id, "create-planned"

        result = self._request("POST", itemtype, payload={"input": payload})
        item_id = None
        if isinstance(result, dict):
            item_id = result.get("id")
        elif isinstance(result, list) and result:
            item_id = result[0].get("id")
        if item_id is None:
            raise GlpiError("POST %s не вернул id: %s" % (itemtype, result))
        self.changes += 1
        self.bump("create")
        self.log("do", "создан %s '%s' id=%s" % (itemtype, label, item_id))
        if self.ledger:
            self.ledger.write(step=step, itemtype=itemtype, action="create",
                              id=item_id, match=match, payload=payload, dry_run=False)
        time.sleep(0.05)
        return item_id, "create"

    def _do_update(self, itemtype, item_id, payload, diff, step, label):
        if is_dry_id(item_id):
            return item_id, "skip"
        self._guard_budget()
        patch = {"id": item_id}
        for key in diff:
            patch[key] = payload[key]
        if not self.apply_changes:
            self.changes += 1
            self.bump("update-planned")
            self.log("plan", "ИЗМЕНИТЬ %s '%s' (id=%s): %s"
                     % (itemtype, label, item_id, json.dumps(diff, ensure_ascii=False)))
            if self.ledger:
                self.ledger.write(step=step, itemtype=itemtype, action="update-planned",
                                  id=item_id, match=None, payload=patch,
                                  before=diff, dry_run=True)
            return item_id, "update-planned"
        self._request("PUT", "%s/%s" % (itemtype, item_id), payload={"input": patch})
        self.changes += 1
        self.bump("update")
        self.log("do", "изменён %s '%s' id=%s: %s"
                 % (itemtype, label, item_id, json.dumps(diff, ensure_ascii=False)))
        if self.ledger:
            self.ledger.write(step=step, itemtype=itemtype, action="update",
                              id=item_id, match=None, payload=patch,
                              before=diff, dry_run=False)
        return item_id, "update"

    def ensure_child(self, parent_itemtype, parent_id, itemtype, match, payload=None,
                     step="", label=None, update_fields=None):
        """Идемпотентное создание подчинённого объекта (сегмент календаря, поле
        шаблона, перевод уведомления). Существующие ищутся среди детей родителя:
        searchText по числовым связям работает неточно, а список детей — точен."""
        self._assert_known(itemtype, write=True)
        payload = dict(payload or {})
        payload.update(match)
        label = label or json.dumps(match, ensure_ascii=False)

        if not is_dry_id(parent_id):
            for child in self.get_children(parent_itemtype, parent_id, itemtype):
                if all(self._eq(child.get(k), v) for k, v in match.items()):
                    item_id = child.get("id")
                    diff = {}
                    for key in (update_fields or []):
                        if key in payload and not self._eq(child.get(key), payload[key]):
                            diff[key] = {"was": child.get(key), "will": payload[key]}
                    if diff and self.allow_update:
                        return self._do_update(itemtype, item_id, payload, diff, step, label)
                    if diff:
                        self.log("warn", "%s %s (id=%s) отличается: %s"
                                 % (itemtype, label, item_id,
                                    json.dumps(diff, ensure_ascii=False)))
                    self.log("skip", "%s %s уже существует (id=%s)"
                             % (itemtype, label, item_id))
                    self.bump("skip")
                    if self.ledger:
                        self.ledger.write(step=step, itemtype=itemtype, action="skip",
                                          id=item_id, match=match, payload=None,
                                          dry_run=not self.apply_changes)
                    return item_id, "skip"

        return self._do_create(itemtype, payload, match, step, label)

    def delete(self, itemtype, item_id, step="rollback", purge=True, label=""):
        """Удаление — только из rollback.py и только по конкретному id."""
        self._assert_known(itemtype, write=True)
        if is_dry_id(item_id):
            self.log("skip", "%s id=%s — запись из dry-run, удалять нечего"
                     % (itemtype, item_id))
            self.bump("skip")
            return "skip"
        try:
            int(item_id)
        except (TypeError, ValueError):
            raise SafetyError("Удаление возможно только по числовому id, получено %r" % item_id)
        self._guard_budget()
        if not self.apply_changes:
            self.changes += 1
            self.bump("delete-planned")
            self.log("plan", "УДАЛИТЬ %s id=%s %s" % (itemtype, item_id, label))
            if self.ledger:
                self.ledger.write(step=step, itemtype=itemtype, action="delete-planned",
                                  id=item_id, match=None, payload=None, dry_run=True)
            return "delete-planned"
        params = {"force_purge": "1"} if purge else None
        self._request("DELETE", "%s/%s" % (itemtype, item_id), params=params,
                      payload={"input": {"id": int(item_id)}})
        self.changes += 1
        self.bump("delete")
        self.log("do", "удалён %s id=%s %s" % (itemtype, item_id, label))
        if self.ledger:
            self.ledger.write(step=step, itemtype=itemtype, action="delete",
                              id=item_id, match=None, payload=None, dry_run=False)
        time.sleep(0.05)
        return "delete"

    # -- итоги ------------------------------------------------------------
    def summary(self):
        order = ["create", "create-planned", "update", "update-planned",
                 "delete", "delete-planned", "skip"]
        parts = ["%s=%d" % (k, self.stats[k]) for k in order if k in self.stats]
        return ", ".join(parts) if parts else "изменений нет"


def client_from_env(args, ledger):
    base_url = os.environ.get("GLPI_URL", "").strip()
    if not base_url:
        raise SafetyError(
            "Не задана переменная окружения GLPI_URL "
            "(пример: https://sd.hofi.su/apirest.php). См. .env.example."
        )
    host = urllib.parse.urlparse(base_url).hostname or ""
    if getattr(args, "confirm", None) != host:
        raise SafetyError(
            "Подтверждение инстанса не совпало: --confirm='%s', в GLPI_URL хост '%s'.\n"
            "Наберите имя инстанса вручную — это защита от запуска не на том контуре."
            % (getattr(args, "confirm", None), host)
        )
    return GlpiClient(
        base_url=base_url,
        app_token=os.environ.get("GLPI_APP_TOKEN") or None,
        user_token=os.environ.get("GLPI_USER_TOKEN") or None,
        login=os.environ.get("GLPI_LOGIN") or None,
        password=os.environ.get("GLPI_PASSWORD") or None,
        apply_changes=bool(getattr(args, "apply", False)),
        ledger=ledger,
        max_changes=getattr(args, "max_changes", 120),
        allow_update=bool(getattr(args, "allow_update", False)),
        ca_bundle=os.environ.get("GLPI_CA_BUNDLE") or None,
    )
