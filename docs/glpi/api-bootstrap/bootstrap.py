#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bootstrap.py — создание объектов Релиза 1 HOFI в GLPI через REST API.

ПО УМОЛЧАНИИ НИЧЕГО НЕ МЕНЯЕТ. Без ключа --apply скрипт только печатает план
и пишет его в журнал с пометкой dry_run.

    # 1. посмотреть, что будет сделано
    python3 bootstrap.py --confirm sd.hofi.su --steps all

    # 2. применить
    python3 bootstrap.py --confirm sd.hofi.su --steps all --apply

Полное описание — README.md в этом каталоге.
Порядок шагов соответствует docs/glpi/setup-release1.md и менять его нельзя:
календарь создаётся до SLA, группы — до категорий.
"""

import argparse
import json
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from glpi_client import (  # noqa: E402
    GlpiClient, GlpiError, Ledger, SafetyError, client_from_env, is_dry_id,
)

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DATA = os.path.join(HERE, "data")
DEFAULT_LOGS = os.path.join(HERE, "logs")

STEPS = [
    "preflight",
    "groups",
    "categories",
    "calendar",
    "sla",
    "ticket-template",
    "notification-templates",
    "verify",
]

# Шаги, которые ничего не изменяют и выполняются всегда.
READ_ONLY_STEPS = {"preflight", "verify"}


def load(data_dir, name):
    path = os.path.join(data_dir, name)
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def head(title):
    print("\n" + "=" * 78)
    print(title)
    print("=" * 78, flush=True)


# ---------------------------------------------------------------------------
# Шаг 0. Предполётная проверка (только чтение)
# ---------------------------------------------------------------------------
def step_preflight(client, args, ctx):
    head("ШАГ preflight — состояние инстанса (только чтение)")
    try:
        cfg = client._request("GET", "getGlpiConfig") or {}
        glpi = cfg.get("cfg_glpi", {})
        print("  Версия GLPI:            %s" % glpi.get("version", "не определена"))
        print("  url_base:               %s" % glpi.get("url_base", "?"))
        print("  Часовой пояс (по БД):   %s" % glpi.get("timezone", "не задан"))
        print("  Уведомления включены:   %s" % glpi.get("use_notifications", "?"))
        print("  Email-уведомления:      %s" % glpi.get("notifications_mailing", "?"))
        print("  Адрес администратора:   %s" % glpi.get("admin_email", "не задан"))
        print("  Ответ на (reply_to):    %s" % glpi.get("admin_reply", "не задан"))
        ver = str(glpi.get("version", ""))
        if ver.startswith("11"):
            print("  [!] Обнаружена ветка 11.x — часть путей в меню и API отличается, "
                  "см. раздел «Отличия GLPI 11» в setup-release1.md")
    except GlpiError as exc:
        print("  [WARN] Не удалось прочитать конфигурацию: %s" % exc)

    try:
        root = client.get_item("Entity", args.entity)
        print("  Сущность id=%s:          '%s'" % (args.entity, root.get("name")))
    except GlpiError as exc:
        print("  [WARN] Сущность id=%s не прочитана: %s" % (args.entity, exc))

    print("\n  Автоматические действия (cron) — критично для SLA, почты и уведомлений:")
    watch = {"mailgate", "slaticket", "olaticket", "queuednotification", "closeticket",
             "watcher", "syncldapusers", "purgelogs"}
    try:
        tasks = client._request("GET", "CronTask",
                                params={"range": "0-300", "expand_dropdowns": "0"}) or []
        mode_names = {1: "GLPI (внутренний)", 2: "CLI (внешний cron)"}
        found = 0
        for task in tasks:
            if task.get("name") in watch:
                found += 1
                state = {0: "выключено", 1: "ожидание", 2: "выполняется"}.get(
                    int(task.get("state", 0)), task.get("state"))
                flag = ""
                if int(task.get("state", 0)) == 0:
                    flag = "  <-- ВЫКЛЮЧЕНО"
                elif int(task.get("mode", 0)) == 1:
                    flag = "  <-- режим GLPI: задача идёт только при заходе пользователя"
                print("    %-20s state=%-11s mode=%-20s last=%s%s"
                      % (task.get("name"), state,
                         mode_names.get(int(task.get("mode", 0)), task.get("mode")),
                         task.get("lastrun") or "никогда", flag))
        if not found:
            print("    [WARN] Задачи не найдены — проверьте права учётной записи API.")
    except GlpiError as exc:
        print("    [WARN] Список CronTask не прочитан: %s" % exc)

    print("\n  Носители профиля Super-Admin (ожидается не более %d):"
          % ctx["profiles"].get("max_super_admin_users", 2))
    try:
        prof = client.find("Profile", {"name": "Super-Admin"})
        if prof:
            users = client.get_children("Profile", prof["id"], "Profile_User")
            print("    найдено связок: %d" % len(users))
            if len(users) > ctx["profiles"].get("max_super_admin_users", 2):
                print("    [!] Больше нормы. Ревизия обязательна (проверка A-12, R-07).")
        else:
            print("    [WARN] профиль Super-Admin не найден по имени")
    except GlpiError as exc:
        print("    [WARN] %s" % exc)
    return True


# ---------------------------------------------------------------------------
# Шаг 1. Группы исполнителей
# ---------------------------------------------------------------------------
def step_groups(client, args, ctx):
    head("ШАГ groups — группы исполнителей (вариант: %s)" % args.groups_variant)
    data = ctx["groups"]
    codes = data["variants"][args.groups_variant]
    created = {}
    for code in codes:
        spec = dict(data["groups"][code])
        name = spec.pop("name")
        payload = {"entities_id": args.entity}
        payload.update(spec)
        gid, _ = client.ensure(
            "Group", {"name": name}, payload, step="groups", label=code,
            update_fields=["is_assign", "is_watcher", "is_notify", "is_recursive"],
        )
        created[code] = gid
    ctx["group_ids"] = created
    ctx["group_names"] = {c: data["groups"][c]["name"] for c in codes}
    print("\n  Напоминание: состав групп (кто именно в SD-L1 и в ИТ) скрипт не "
          "заполняет — это поимённый список от руководителя ИТ.\n"
          "  Пустая группа = заявка назначена «в никуда»: уведомление уходит, "
          "читать его некому.")
    return True


# ---------------------------------------------------------------------------
# Шаг 2. Категории
# ---------------------------------------------------------------------------
def step_categories(client, args, ctx):
    head("ШАГ categories — дерево категорий заявок")
    if "group_ids" not in ctx:
        step_groups(client, args, ctx)
    data = ctx["categories"]
    collapse = ctx["groups"].get("collapse_to_two", {})

    parent_ids = {}
    for parent in data["parents"]:
        pid, _ = client.ensure(
            "ITILCategory", {"name": parent["name"], "itilcategories_id": 0},
            {
                "entities_id": args.entity,
                "is_recursive": 1,
                "is_helpdeskvisible": parent.get("is_helpdeskvisible", 0),
                "comment": "Навигационный уровень. Пользователь выбрать не может (C-04).",
            },
            step="categories", label=parent["name"],
            update_fields=["is_helpdeskvisible", "is_recursive"],
        )
        parent_ids[parent["name"]] = pid

    for leaf in data["leaves"]:
        code = leaf["group"]
        if args.groups_variant == "two":
            code = collapse.get(code, code)
        gid = ctx["group_ids"].get(code)
        if gid is None:
            client.log("warn", "Для категории '%s' нет группы '%s' — пропуск"
                       % (leaf["name"], code))
            continue
        parent_id = parent_ids.get(leaf["parent"], 0) if leaf.get("parent") else 0
        payload = {
            "entities_id": args.entity,
            "is_recursive": 1,
            "is_helpdeskvisible": 1,
            "is_incident": leaf.get("is_incident", 1),
            "is_request": leaf.get("is_request", 1),
            "comment": "Целевая группа: %s" % code,
        }
        if not is_dry_id(gid):
            payload["groups_id"] = gid
        else:
            payload["groups_id"] = gid  # в dry-run видно, что связь планируется
        client.ensure(
            "ITILCategory",
            {"name": leaf["name"], "itilcategories_id": parent_id if not is_dry_id(parent_id) else 0},
            payload, step="categories", label=leaf["name"],
            update_fields=["groups_id", "is_helpdeskvisible", "is_incident", "is_request"],
        )
    print("\n  Категория сама по себе исполнителя не назначает. Маршрутизацию "
          "включают ПОСЛЕДНЕЙ и руками — setup-release1.md, шаг 21.")
    return True


# ---------------------------------------------------------------------------
# Шаг 3. Календарь (ДО SLA)
# ---------------------------------------------------------------------------
def step_calendar(client, args, ctx):
    head("ШАГ calendar — рабочий календарь и нерабочие дни")
    data = ctx["calendar"]
    spec = dict(data["calendar"])
    name = spec.pop("name")
    cal_id, _ = client.ensure(
        "Calendar", {"name": name},
        dict({"entities_id": args.entity}, **spec),
        step="calendar", label=name, update_fields=["is_recursive"],
    )
    ctx["calendar_id"] = cal_id
    ctx["calendar_name"] = name

    for seg in data["segments"]:
        client.ensure_child(
            "Calendar", cal_id, "CalendarSegment",
            {"calendars_id": cal_id, "day": seg["day"], "begin": seg["begin"]},
            {"end": seg["end"], "entities_id": args.entity},
            step="calendar",
            label="день %s %s-%s" % (seg["day"], seg["begin"], seg["end"]),
            update_fields=["end"],
        )

    for hol in data.get("holidays", []):
        hid, _ = client.ensure(
            "Holiday", {"name": hol["name"]},
            {
                "entities_id": args.entity,
                "is_recursive": 1,
                "begin_date": hol["begin_date"],
                "end_date": hol["end_date"],
                "is_perpetual": hol.get("is_perpetual", 1),
            },
            step="calendar", label=hol["name"],
            update_fields=["begin_date", "end_date", "is_perpetual"],
        )
        client.ensure_child(
            "Calendar", cal_id, "Calendar_Holiday",
            {"calendars_id": cal_id, "holidays_id": hid},
            {}, step="calendar", label="связь '%s'" % hol["name"],
        )
    print("\n  Проверить глазами: карточка календаря -> «Часы работы» показывает "
          "Пн-Пт 09:00-18:00.\n  Нумерация дней в API (0=вс) — самая частая "
          "причина календаря «сб-ср».")
    return True


# ---------------------------------------------------------------------------
# Шаг 4. SLM + SLA (ПОСЛЕ календаря)
# ---------------------------------------------------------------------------
def step_sla(client, args, ctx):
    head("ШАГ sla — соглашение об уровне услуг и 6 SLA")
    data = ctx["sla"]
    cal_id = ctx.get("calendar_id")
    if cal_id is None:
        found = client.find("Calendar", {"name": data["slm"]["calendar"]})
        if not found:
            client.log("err", "Календарь '%s' не найден. SLA без календаря будет "
                              "считать сроки в астрономических часах — шаг прерван."
                       % data["slm"]["calendar"])
            return False
        cal_id = found["id"]

    slm = dict(data["slm"])
    slm.pop("calendar", None)
    name = slm.pop("name")
    slm_id, _ = client.ensure(
        "SLM", {"name": name},
        dict({"entities_id": args.entity, "calendars_id": cal_id}, **slm),
        step="sla", label=name, update_fields=["calendars_id", "is_recursive"],
    )
    ctx["slm_id"] = slm_id

    ctx["sla_ids"] = {}
    for sla in data["slas"]:
        payload = {
            "slms_id": slm_id,
            "type": sla["type"],
            "number_time": sla["number_time"],
            "definition_time": sla["definition_time"],
            "end_of_working_day": 0,
            "comment": sla.get("comment", ""),
            "entities_id": args.entity,
        }
        sid, _ = client.ensure(
            "SLA", {"name": sla["name"], "slms_id": slm_id}, payload,
            step="sla", search_field="name", label=sla["name"],
            update_fields=["number_time", "definition_time", "type"],
        )
        ctx["sla_ids"][sla["name"]] = sid
    print("\n  Привязка SLA к заявке делается бизнес-правилами вручную "
          "(setup-release1.md, шаг 20): правила создаются по одному и "
          "проверяются на тестовой заявке.")
    return True


# ---------------------------------------------------------------------------
# Шаг 5. Шаблон заявки
# ---------------------------------------------------------------------------
def resolve_ticket_fields(client, fields_def):
    """Номера полей шаблона резолвятся с живого инстанса, а не берутся из памяти."""
    options = client.list_search_options("Ticket")
    resolved = {}
    print("\n  Сопоставление полей шаблона (GET /listSearchOptions/Ticket):")
    for key, spec in fields_def.items():
        matches = []
        for num, meta in options.items():
            if not str(num).isdigit() or not isinstance(meta, dict):
                continue
            if meta.get("table") == spec["table"] and meta.get("field") == spec["field"]:
                if spec.get("linkfield") and meta.get("linkfield") \
                        and meta.get("linkfield") != spec["linkfield"]:
                    continue
                matches.append((int(num), meta))
        expected = spec.get("expected_num")
        chosen = None
        if len(matches) == 1:
            chosen = matches[0]
        elif len(matches) > 1:
            for num, meta in matches:
                if num == expected:
                    chosen = (num, meta)
                    break
            if chosen is None:
                print("    [WARN] %-28s неоднозначно: %s — поле пропущено, задайте в UI"
                      % (spec["label"], [m[0] for m in matches]))
                continue
        if chosen is None:
            print("    [WARN] %-28s не найдено (%s.%s) — задайте в UI вручную"
                  % (spec["label"], spec["table"], spec["field"]))
            continue
        num = chosen[0]
        mark = "" if num == expected else "  <-- отличается от ожидаемого %s" % expected
        print("    %-28s num=%-4s %s%s" % (spec["label"], num, chosen[1].get("name", ""), mark))
        resolved[key] = num
    return resolved


def step_ticket_template(client, args, ctx):
    head("ШАГ ticket-template — шаблон заявки HOFI Base")
    data = ctx["ticket_template"]
    spec = dict(data["template"])
    name = spec.pop("name")
    tpl_id, _ = client.ensure(
        "TicketTemplate", {"name": name},
        dict({"entities_id": args.entity}, **spec),
        step="ticket-template", label=name, update_fields=["is_recursive"],
    )
    ctx["ticket_template_id"] = tpl_id

    nums = resolve_ticket_fields(client, data["fields"])

    for key in data.get("mandatory", []):
        if key not in nums:
            continue
        client.ensure_child(
            "TicketTemplate", tpl_id, "TicketTemplateMandatoryField",
            {"tickettemplates_id": tpl_id, "num": nums[key]}, {},
            step="ticket-template",
            label="обязательное: %s" % data["fields"][key]["label"],
        )
    for key in data.get("hidden", []) + data.get("hidden_verify", []):
        if key not in nums:
            continue
        client.ensure_child(
            "TicketTemplate", tpl_id, "TicketTemplateHiddenField",
            {"tickettemplates_id": tpl_id, "num": nums[key]}, {},
            step="ticket-template",
            label="скрытое: %s" % data["fields"][key]["label"],
        )
    for pre in data.get("predefined", []):
        key = pre["field"]
        if key not in nums:
            continue
        client.ensure_child(
            "TicketTemplate", tpl_id, "TicketTemplatePredefinedField",
            {"tickettemplates_id": tpl_id, "num": nums[key]},
            {"value": pre["value"]},
            step="ticket-template",
            label="по умолчанию: %s=%s" % (data["fields"][key]["label"], pre["value"]),
            update_fields=["value"],
        )
    print("\n  Шаблон НЕ становится шаблоном по умолчанию автоматически: его "
          "назначают в сущности\n  (Администрирование -> Сущности -> вкладка "
          "«Помощник» -> Шаблон заявки по умолчанию), шаг 11.5.")
    print("  Проверьте замечание про скрытые поля исполнителя — "
          "ticket-template.json, ключ _hidden_verify_comment.")
    return True


# ---------------------------------------------------------------------------
# Шаг 6. Шаблоны уведомлений
# ---------------------------------------------------------------------------
def step_notification_templates(client, args, ctx):
    head("ШАГ notification-templates — шаблоны писем")
    data = ctx["notifications"]
    lang = data.get("language", "ru_RU")
    ctx["notification_template_ids"] = {}
    for tpl in data["templates"]:
        tid, _ = client.ensure(
            "NotificationTemplate", {"name": tpl["name"]},
            {
                "entities_id": args.entity,
                "itemtype": tpl.get("itemtype", "Ticket"),
                "comment": tpl.get("comment", ""),
                "is_recursive": 1,
            },
            step="notification-templates", label=tpl["name"],
            update_fields=["itemtype"],
        )
        ctx["notification_template_ids"][tpl["key"]] = tid
        body = tpl["content_text"]
        client.ensure_child(
            "NotificationTemplate", tid, "NotificationTemplateTranslation",
            {"notificationtemplates_id": tid, "language": lang},
            {
                "subject": tpl["subject"],
                "content_text": body,
                "content_html": "<p>" + body.replace("\n", "<br />\n") + "</p>",
            },
            step="notification-templates", label="перевод %s / %s" % (tpl["name"], lang),
            update_fields=["subject", "content_text"],
        )
    print("\n  Скрипт создал ТОЛЬКО шаблоны. Сами уведомления (событие + "
          "получатели) заводятся руками:\n  неверно выбранный получатель — это "
          "письмо не тому человеку, и откатывать его поздно. Шаг 18.")
    return True


# ---------------------------------------------------------------------------
# Шаг 7. Проверка результата (только чтение)
# ---------------------------------------------------------------------------
def step_verify(client, args, ctx):
    head("ШАГ verify — сверка с эталоном (только чтение)")
    problems = []

    codes = ctx["groups"]["variants"][args.groups_variant]
    for code in codes:
        name = ctx["groups"]["groups"][code]["name"]
        found = client.find("Group", {"name": name})
        if not found:
            problems.append("группа '%s' отсутствует" % name)
        elif not int(found.get("is_assign", 0)):
            problems.append("группа '%s' без флага «Может быть назначена заявкам»" % name)
    print("  Группы: проверено %d" % len(codes))

    missing_group = []
    for leaf in ctx["categories"]["leaves"]:
        found = client.find("ITILCategory", {"name": leaf["name"]})
        if not found:
            problems.append("категория '%s' отсутствует" % leaf["name"])
        else:
            if not int(found.get("groups_id") or 0):
                missing_group.append(leaf["name"])
            if not int(found.get("is_helpdeskvisible", 0)):
                problems.append("категория '%s' не видна пользователю" % leaf["name"])
    for parent in ctx["categories"]["parents"]:
        found = client.find("ITILCategory", {"name": parent["name"]})
        if found and int(found.get("is_helpdeskvisible", 0)):
            problems.append("родительская категория '%s' видна пользователю "
                            "(должна быть скрыта, C-04)" % parent["name"])
    if missing_group:
        problems.append("категории без группы ответственных: %s" % ", ".join(missing_group))
    print("  Категории: проверено %d листьев, %d родителей"
          % (len(ctx["categories"]["leaves"]), len(ctx["categories"]["parents"])))

    cal = client.find("Calendar", {"name": ctx["calendar"]["calendar"]["name"]})
    if not cal:
        problems.append("календарь '%s' отсутствует" % ctx["calendar"]["calendar"]["name"])
    else:
        segs = client.get_children("Calendar", cal["id"], "CalendarSegment")
        days = sorted({int(s.get("day")) for s in segs})
        print("  Календарь: сегментов %d, дни %s (ожидается [1, 2, 3, 4, 5] = Пн-Пт)"
              % (len(segs), days))
        if days != [1, 2, 3, 4, 5]:
            problems.append("дни календаря %s не соответствуют Пн-Пт — сроки SLA "
                            "поедут" % days)
        hols = client.get_children("Calendar", cal["id"], "Calendar_Holiday")
        print("  Нерабочих периодов привязано: %d" % len(hols))

    slm = client.find("SLM", {"name": ctx["sla"]["slm"]["name"]})
    if not slm:
        problems.append("SLM '%s' отсутствует" % ctx["sla"]["slm"]["name"])
    else:
        if cal and int(slm.get("calendars_id") or 0) != int(cal["id"]):
            problems.append("SLM привязан не к календарю '%s' — сроки считаются "
                            "круглосуточно" % cal["name"])
        slas = client.get_children("SLM", slm["id"], "SLA")
        print("  SLA внутри SLM: %d (ожидается %d)"
              % (len(slas), len(ctx["sla"]["slas"])))
        if len(slas) < len(ctx["sla"]["slas"]):
            problems.append("SLA создано меньше, чем в эталоне")

    tpl = client.find("TicketTemplate", {"name": ctx["ticket_template"]["template"]["name"]})
    if not tpl:
        problems.append("шаблон заявки '%s' отсутствует"
                        % ctx["ticket_template"]["template"]["name"])
    else:
        man = client.get_children("TicketTemplate", tpl["id"], "TicketTemplateMandatoryField")
        hid = client.get_children("TicketTemplate", tpl["id"], "TicketTemplateHiddenField")
        pre = client.get_children("TicketTemplate", tpl["id"], "TicketTemplatePredefinedField")
        print("  Шаблон заявки: обязательных %d, скрытых %d, предзаполненных %d"
              % (len(man), len(hid), len(pre)))
        try:
            ent = client.get_item("Entity", args.entity)
            if int(ent.get("tickettemplates_id") or 0) != int(tpl["id"]):
                problems.append("шаблон '%s' не назначен шаблоном по умолчанию в "
                                "сущности id=%s (шаг 11.5)" % (tpl["name"], args.entity))
        except GlpiError:
            pass

    for tpl_spec in ctx["notifications"]["templates"]:
        found = client.find("NotificationTemplate", {"name": tpl_spec["name"]})
        if not found:
            problems.append("шаблон уведомления '%s' отсутствует" % tpl_spec["name"])
    print("  Шаблоны уведомлений: проверено %d" % len(ctx["notifications"]["templates"]))

    print("\n  Профили (создаются руками, скрипт только сверяет):")
    for exp in ctx["profiles"]["expected"]:
        found = client.find("Profile", {"name": exp["name"]})
        if not found:
            print("    [ ] %-16s отсутствует — %s" % (exp["name"], exp["note"]))
            problems.append("профиль '%s' не создан" % exp["name"])
            continue
        iface = found.get("interface")
        ok = (iface == exp["interface"])
        print("    [%s] %-16s интерфейс=%s (ожидается %s)"
              % ("x" if ok else "!", exp["name"], iface, exp["interface"]))
        if not ok:
            problems.append("профиль '%s': интерфейс %s вместо %s"
                            % (exp["name"], iface, exp["interface"]))

    print("\n  --- ИТОГ ПРОВЕРКИ ---")
    if problems:
        for p in problems:
            print("    [!] %s" % p)
        print("\n  Расхождений: %d. Релиз 1 не закрывается, пока список не пуст."
              % len(problems))
    else:
        print("    Расхождений не найдено.")
    return not problems


HANDLERS = {
    "preflight": step_preflight,
    "groups": step_groups,
    "categories": step_categories,
    "calendar": step_calendar,
    "sla": step_sla,
    "ticket-template": step_ticket_template,
    "notification-templates": step_notification_templates,
    "verify": step_verify,
}


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Создание объектов Релиза 1 GLPI (HOFI). По умолчанию — dry-run.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--confirm", required=True, metavar="HOSTNAME",
                        help="имя хоста инстанса, набранное вручную; должно совпасть "
                             "с хостом из GLPI_URL")
    parser.add_argument("--apply", action="store_true",
                        help="ПРИМЕНИТЬ изменения. Без этого ключа не уходит ни один "
                             "запрос на запись")
    parser.add_argument("--steps", default="preflight",
                        help="через запятую: %s или all (по умолчанию: preflight)"
                             % ", ".join(STEPS))
    parser.add_argument("--groups-variant", choices=["two", "four"], default="two",
                        help="две группы (SD-L1 + IT-ALL) или четыре. "
                             "См. setup-release1.md, раздел «Две группы или четыре». "
                             "По умолчанию: two")
    parser.add_argument("--entity", type=int, default=0,
                        help="id сущности, в которой создаются объекты (0 = корневая)")
    parser.add_argument("--max-changes", type=int, default=120,
                        help="предохранитель: максимум изменений за запуск "
                             "(по умолчанию 120)")
    parser.add_argument("--allow-update", action="store_true",
                        help="разрешить доводить существующие объекты до эталона. "
                             "Без ключа расхождения только показываются")
    parser.add_argument("--data-dir", default=DEFAULT_DATA)
    parser.add_argument("--ledger", default=None,
                        help="путь к журналу операций (по умолчанию logs/ledger-<дата>.jsonl)")
    args = parser.parse_args(argv)

    if args.steps.strip() == "all":
        args.step_list = list(STEPS)
    else:
        args.step_list = [s.strip() for s in args.steps.split(",") if s.strip()]
    unknown = [s for s in args.step_list if s not in STEPS]
    if unknown:
        parser.error("неизвестные шаги: %s" % ", ".join(unknown))
    return args


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    ledger_path = args.ledger or os.path.join(
        DEFAULT_LOGS, "ledger-%s-%s.jsonl" % (stamp, "apply" if args.apply else "dryrun"))
    run_id = "%s-%s" % (stamp, os.getpid())

    writes = [s for s in args.step_list if s not in READ_ONLY_STEPS]
    print("GLPI bootstrap — Релиз 1 HOFI")
    print("  режим:      %s" % ("ПРИМЕНЕНИЕ (--apply)" if args.apply else "DRY-RUN (изменений не будет)"))
    print("  шаги:       %s" % ", ".join(args.step_list))
    print("  вариант групп: %s" % args.groups_variant)
    print("  сущность:   id=%s" % args.entity)
    print("  журнал:     %s" % ledger_path)
    if args.apply and writes:
        print("\n  Изменяющие шаги: %s" % ", ".join(writes))
        print("  Учётная запись работает под профилем super-Admin: любая ошибка в "
              "данных\n  применяется молча и целиком. Убедитесь, что dry-run этого "
              "же набора шагов\n  был просмотрен глазами, и что бэкап БД снят "
              "сегодня (шаг 3 руководства).")

    ledger = Ledger(ledger_path, os.environ.get("GLPI_URL", ""), run_id)
    try:
        client = client_from_env(args, ledger)
    except SafetyError as exc:
        print("\n[STOP] %s" % exc)
        return 2

    ctx = {
        "groups": load(args.data_dir, "groups.json"),
        "categories": load(args.data_dir, "categories.json"),
        "calendar": load(args.data_dir, "calendar.json"),
        "sla": load(args.data_dir, "sla.json"),
        "ticket_template": load(args.data_dir, "ticket-template.json"),
        "notifications": load(args.data_dir, "notification-templates.json"),
        "profiles": load(args.data_dir, "profiles-expected.json"),
    }

    rc = 0
    try:
        client.init_session()
        print("\n  сессия открыта")
        for step in args.step_list:
            ok = HANDLERS[step](client, args, ctx)
            if ok is False:
                rc = 1
                print("\n[STOP] Шаг '%s' не выполнен. Следующие шаги зависят от него "
                      "— выполнение прервано." % step)
                break
    except SafetyError as exc:
        print("\n[STOP] Сработала защита: %s" % exc)
        rc = 2
    except GlpiError as exc:
        print("\n[ERROR] %s" % exc)
        rc = 1
    except KeyboardInterrupt:
        print("\n[STOP] Прервано оператором. Уже применённые операции остались в "
              "журнале: %s" % ledger_path)
        rc = 130
    finally:
        client.kill_session()

    print("\n" + "-" * 78)
    print("Итог: %s" % client.summary())
    print("Журнал: %s" % ledger_path)
    if not args.apply and writes:
        print("\nЭто был DRY-RUN. Ничего не изменено. Чтобы применить:")
        print("  python3 bootstrap.py --confirm %s --steps %s --groups-variant %s --apply"
              % (args.confirm, args.steps, args.groups_variant))
    if args.apply:
        print("\nОткат созданного этим запуском:")
        print("  python3 rollback.py --confirm %s --ledger %s          # покажет план"
              % (args.confirm, ledger_path))
        print("  python3 rollback.py --confirm %s --ledger %s --apply  # удалит"
              % (args.confirm, ledger_path))
        print("\nЗафиксируйте результат в docs/glpi/config-log.md — без записи в "
              "журнале конфигурации изменение считается несогласованным (A-20).")
    return rc


if __name__ == "__main__":
    sys.exit(main())
