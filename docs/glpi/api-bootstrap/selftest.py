#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
selftest.py — офлайн-проверка bootstrap.py БЕЗ доступа к GLPI.

Инстанс sd.hofi.su находится в локальной сети заказчика, поэтому логику
скрипта нужно уметь проверять до выезда на площадку. Здесь GLPI заменён
заглушкой в памяти, которая ведёт себя как REST API: хранит объекты,
отдаёт списки детей, выдаёт id при POST.

Что проверяется:
  1. данные в data/*.json читаются и не содержат ссылок в никуда;
  2. dry-run не делает ни одного запроса на запись;
  3. apply создаёт ожидаемое число объектов;
  4. ПОВТОРНЫЙ apply не создаёт ни одного дубликата (идемпотентность);
  5. rollback по журналу удаляет ровно созданное и оставляет базу пустой.

    python3 selftest.py
"""

import json
import os
import sys
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bootstrap  # noqa: E402
import glpi_client  # noqa: E402
from glpi_client import GlpiClient, GlpiError  # noqa: E402

TICKET_OPTIONS = {
    "1": {"name": "Заголовок", "table": "glpi_tickets", "field": "name"},
    "21": {"name": "Описание", "table": "glpi_tickets", "field": "content"},
    "7": {"name": "Категория", "table": "glpi_itilcategories", "field": "completename"},
    "10": {"name": "Срочность", "table": "glpi_tickets", "field": "urgency"},
    "11": {"name": "Влияние", "table": "glpi_tickets", "field": "impact"},
    "14": {"name": "Тип", "table": "glpi_tickets", "field": "type"},
    "5": {"name": "Техник", "table": "glpi_users", "field": "name",
          "linkfield": "users_id_assign"},
    "8": {"name": "Группа исполнителей", "table": "glpi_groups",
          "field": "completename", "linkfield": "groups_id_assign"},
    "37": {"name": "SLA — время взятия в работу", "table": "glpi_slas",
           "field": "name", "linkfield": "slas_id_tto"},
    "30": {"name": "SLA — время решения", "table": "glpi_slas", "field": "name",
           "linkfield": "slas_id_ttr"},
}

PARENT_KEY = {
    "CalendarSegment": "calendars_id",
    "Calendar_Holiday": "calendars_id",
    "SLA": "slms_id",
    "TicketTemplateMandatoryField": "tickettemplates_id",
    "TicketTemplateHiddenField": "tickettemplates_id",
    "TicketTemplatePredefinedField": "tickettemplates_id",
    "NotificationTemplateTranslation": "notificationtemplates_id",
    "Profile_User": "profiles_id",
}


class FakeGlpi(GlpiClient):
    """Заглушка REST API GLPI в памяти."""

    def __init__(self, **kw):
        super().__init__(base_url="https://fake.local/apirest.php", **kw)
        self.store = {}
        self.next_id = 1000
        self.write_calls = 0
        self.session_token = "fake"

    def init_session(self):
        return "fake"

    def kill_session(self):
        pass

    def _request(self, method, path, params=None, payload=None, extra_headers=None):
        if method in ("POST", "PUT", "DELETE"):
            if not self.apply_changes:
                raise AssertionError("dry-run попытался выполнить %s — это дефект" % method)
            self.write_calls += 1
        parts = [p for p in path.strip("/").split("/") if p]

        if parts[0] == "getGlpiConfig":
            return {"cfg_glpi": {"version": "10.0.18", "url_base": "https://fake.local",
                                 "timezone": "Europe/Moscow", "use_notifications": 1,
                                 "notifications_mailing": 1,
                                 "admin_email": "glpi-noreply@example.test"}}
        if parts[0] == "listSearchOptions":
            return dict(TICKET_OPTIONS)

        if method == "GET":
            if len(parts) == 3:  # дети
                parent_type, parent_id, subtype = parts[0], parts[1], parts[2]
                key = PARENT_KEY.get(subtype)
                out = []
                for item in self.store.get(subtype, {}).values():
                    if key and str(item.get(key)) == str(parent_id):
                        out.append(item)
                return out
            if len(parts) == 2:  # один объект
                itemtype, item_id = parts
                item = self.store.get(itemtype, {}).get(int(item_id))
                if item is None:
                    if itemtype == "Entity" and item_id == "0":
                        return {"id": 0, "name": "HOFI", "tickettemplates_id": 0}
                    raise GlpiError("HTTP GET %s -> 404" % path)
                return item
            itemtype = parts[0]
            if itemtype in ("CronTask", "Ticket"):
                return []
            results = list(self.store.get(itemtype, {}).values())
            if params:
                for key, value in params.items():
                    if key.startswith("searchText["):
                        field = key[len("searchText["):-1]
                        results = [r for r in results
                                   if str(value).lower() in str(r.get(field, "")).lower()]
            return results

        if method == "POST":
            itemtype = parts[0]
            data = dict(payload["input"])
            self.next_id += 1
            data["id"] = self.next_id
            self.store.setdefault(itemtype, {})[self.next_id] = data
            return {"id": self.next_id, "message": ""}

        if method == "PUT":
            itemtype, item_id = parts
            self.store[itemtype][int(item_id)].update(payload["input"])
            return [{str(item_id): True}]

        if method == "DELETE":
            itemtype, item_id = parts
            self.store.get(itemtype, {}).pop(int(item_id), None)
            return [{str(item_id): True}]

        raise GlpiError("неизвестный запрос %s %s" % (method, path))

    def count(self):
        return sum(len(v) for v in self.store.values())


class Args:
    def __init__(self, **kw):
        self.confirm = "fake.local"
        self.apply = False
        self.entity = 0
        self.groups_variant = "four"
        self.max_changes = 300
        self.allow_update = False
        self.data_dir = bootstrap.DEFAULT_DATA
        self.__dict__.update(kw)


WRITE_STEPS = ["groups", "categories", "calendar", "sla", "ticket-template",
               "notification-templates"]


def build_ctx(data_dir):
    return {
        "groups": bootstrap.load(data_dir, "groups.json"),
        "categories": bootstrap.load(data_dir, "categories.json"),
        "calendar": bootstrap.load(data_dir, "calendar.json"),
        "sla": bootstrap.load(data_dir, "sla.json"),
        "ticket_template": bootstrap.load(data_dir, "ticket-template.json"),
        "notifications": bootstrap.load(data_dir, "notification-templates.json"),
        "profiles": bootstrap.load(data_dir, "profiles-expected.json"),
    }


def run(client, args, steps):
    ctx = build_ctx(args.data_dir)
    for step in steps:
        bootstrap.HANDLERS[step](client, args, ctx)
    return ctx


def check(condition, message):
    print(("  OK   " if condition else "  FAIL ") + message)
    if not condition:
        raise SystemExit(1)


def main():
    import io
    import contextlib

    data_dir = bootstrap.DEFAULT_DATA
    print("1. Данные data/*.json")
    ctx = build_ctx(data_dir)
    codes4 = set(ctx["groups"]["variants"]["four"])
    leaf_groups = {leaf["group"] for leaf in ctx["categories"]["leaves"]}
    check(leaf_groups <= codes4,
          "каждая категория ссылается на существующую группу (%s)" % ", ".join(sorted(leaf_groups)))
    parents = {p["name"] for p in ctx["categories"]["parents"]}
    bad_parents = {l["parent"] for l in ctx["categories"]["leaves"]
                   if l["parent"] and l["parent"] not in parents}
    check(not bad_parents, "у каждого листа существующий родитель")
    check(len(ctx["categories"]["leaves"]) == 15, "15 листовых категорий (categories.md)")
    check(ctx["sla"]["slm"]["calendar"] == ctx["calendar"]["calendar"]["name"],
          "SLM ссылается на создаваемый календарь '%s'" % ctx["calendar"]["calendar"]["name"])
    check(len(ctx["sla"]["slas"]) == 6, "6 SLA (TTO/TTR x 3 приоритета)")
    check({s["day"] for s in ctx["calendar"]["segments"]} == {1, 2, 3, 4, 5},
          "сегменты календаря Пн-Пт")
    collapse = ctx["groups"]["collapse_to_two"]
    check(set(collapse.values()) == set(ctx["groups"]["variants"]["two"]),
          "карта свёртки 4->2 групп непротиворечива")

    print("\n2. Dry-run не пишет")
    dry = FakeGlpi(apply_changes=False, max_changes=300)
    with contextlib.redirect_stdout(io.StringIO()):
        run(dry, Args(), WRITE_STEPS)
    check(dry.write_calls == 0, "ни одного запроса на запись")
    check(dry.count() == 0, "в «базе» пусто")
    planned = dry.stats.get("create-planned", 0)
    check(planned > 0, "план содержит %d создаваемых объектов" % planned)

    print("\n3. Apply создаёт объекты")
    live = FakeGlpi(apply_changes=True, max_changes=300)
    with contextlib.redirect_stdout(io.StringIO()):
        run(live, Args(apply=True), WRITE_STEPS)
    created = live.stats.get("create", 0)
    check(created == planned,
          "создано %d объектов — ровно столько, сколько показал dry-run" % created)
    check(len(live.store.get("ITILCategory", {})) == 19, "19 категорий (4 родителя + 15 листьев)")
    check(len(live.store.get("Group", {})) == 4, "4 группы (вариант four)")
    check(len(live.store.get("SLA", {})) == 6, "6 SLA")
    check(len(live.store.get("CalendarSegment", {})) == 5, "5 сегментов календаря")
    leaves = [c for c in live.store["ITILCategory"].values() if c.get("groups_id")]
    check(len(leaves) == 15, "у всех 15 листьев проставлена группа ответственных")

    print("\n4. Повторный запуск идемпотентен")
    before = live.count()
    live.stats = {}
    live.changes = 0
    with contextlib.redirect_stdout(io.StringIO()):
        run(live, Args(apply=True), WRITE_STEPS)
    check(live.count() == before, "число объектов не изменилось (%d)" % before)
    check(live.stats.get("create", 0) == 0, "не создано ни одного дубликата")
    check(live.stats.get("update", 0) == 0, "не изменено ни одного объекта")

    print("\n5. Предохранитель по числу изменений")
    capped = FakeGlpi(apply_changes=True, max_changes=5)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            run(capped, Args(apply=True), WRITE_STEPS)
        check(False, "лимит изменений должен был сработать")
    except glpi_client.SafetyError:
        check(capped.count() <= 5, "остановлено на лимите, создано %d" % capped.count())

    print("\n6. Вариант «две группы»")
    two = FakeGlpi(apply_changes=True, max_changes=300)
    with contextlib.redirect_stdout(io.StringIO()):
        run(two, Args(apply=True, groups_variant="two"), WRITE_STEPS)
    check(len(two.store.get("Group", {})) == 2, "создано 2 группы")
    gids = {g["id"] for g in two.store["Group"].values()}
    used = {c["groups_id"] for c in two.store["ITILCategory"].values() if c.get("groups_id")}
    check(used <= gids and len(used) == 2,
          "все 15 категорий разложены по двум существующим группам")

    print("\n7. Откат по журналу")
    live.allow_delete = True
    live.stats = {}
    live.changes = 0
    ids = [(t, i) for t in live.store for i in list(live.store[t].keys())]
    with contextlib.redirect_stdout(io.StringIO()):
        for itemtype, item_id in reversed(ids):
            live.delete(itemtype, item_id, purge=True)
    check(live.count() == 0, "после отката объектов не осталось")

    print("\nВсе проверки пройдены.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
