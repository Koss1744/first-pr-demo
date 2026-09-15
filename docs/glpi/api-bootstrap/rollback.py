#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rollback.py — откат объектов, созданных bootstrap.py.

Работает ТОЛЬКО по журналу (ledger) конкретного запуска. Ничего не ищет
самостоятельно и ничего не удаляет «по имени»: удаляются ровно те id,
которые записаны как успешно созданные, в обратном порядке.

    # посмотреть план отката
    python3 rollback.py --confirm sd.hofi.su --ledger logs/ledger-...-apply.jsonl

    # выполнить
    python3 rollback.py --confirm sd.hofi.su --ledger logs/ledger-...-apply.jsonl --apply

Предохранители:
  * dry-run по умолчанию;
  * удаляются только записи action=create с dry_run=false;
  * перед удалением объект перечитывается и сверяется имя из журнала —
    если объект уже переименован или id занят другим объектом, он пропускается;
  * если в системе уже есть заявки, откат требует --force: удаление категорий
    и групп рвёт ссылки в существующих заявках;
  * лимит --max-changes.

Что НЕ откатывается автоматически (и почему):
  профили, правила, уведомления, настройки сущности и конфигурации — их
  bootstrap.py не создаёт. Откат этих объектов описан пошагово в
  docs/glpi/config-log.md, колонка «Как откатить».
"""

import argparse
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from glpi_client import (  # noqa: E402
    ALLOWED_ITEMTYPES, GlpiError, Ledger, SafetyError, client_from_env,
)

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_LOGS = os.path.join(HERE, "logs")


def parse_args(argv):
    parser = argparse.ArgumentParser(
        description="Откат объектов Релиза 1, созданных bootstrap.py. По умолчанию — dry-run.")
    parser.add_argument("--confirm", required=True, metavar="HOSTNAME")
    parser.add_argument("--ledger", required=True, help="журнал запуска bootstrap.py")
    parser.add_argument("--apply", action="store_true", help="выполнить удаление")
    parser.add_argument("--only-step", default=None,
                        help="откатить только один шаг (groups, categories, calendar, "
                             "sla, ticket-template, notification-templates)")
    parser.add_argument("--no-purge", action="store_true",
                        help="переместить в корзину вместо окончательного удаления")
    parser.add_argument("--force", action="store_true",
                        help="откатывать, даже если в системе уже есть заявки")
    parser.add_argument("--max-changes", type=int, default=200)
    return parser.parse_args(argv)


def main(argv=None):
    args = parse_args(argv or sys.argv[1:])
    records = Ledger.read(args.ledger)

    instances = {r.get("instance") for r in records if r.get("instance")}
    current = os.environ.get("GLPI_URL", "")
    if instances and current not in instances:
        print("[STOP] Журнал снят с инстанса %s, а GLPI_URL сейчас '%s'. "
              "Откат на другом контуре запрещён." % (", ".join(instances), current))
        return 2

    targets = [
        r for r in records
        if r.get("action") == "create" and not r.get("dry_run")
        and (args.only_step is None or r.get("step") == args.only_step)
    ]
    targets.reverse()  # дети удаляются раньше родителей

    planned_dry = [r for r in records if r.get("action") == "create-planned"]
    if not targets:
        print("В журнале %s нет реально созданных объектов." % args.ledger)
        if planned_dry:
            print("Найдено %d записей create-planned — это журнал dry-run. "
                  "Откатывать нечего." % len(planned_dry))
        return 0

    bad = {r["itemtype"] for r in targets if r["itemtype"] not in ALLOWED_ITEMTYPES}
    if bad:
        print("[STOP] В журнале типы вне белого списка: %s" % ", ".join(sorted(bad)))
        return 2

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_ledger = Ledger(
        os.path.join(DEFAULT_LOGS, "rollback-%s-%s.jsonl"
                     % (stamp, "apply" if args.apply else "dryrun")),
        current, "rollback-%s" % stamp)

    print("Откат Релиза 1 по журналу %s" % args.ledger)
    print("  режим:   %s" % ("УДАЛЕНИЕ (--apply)" if args.apply else "DRY-RUN"))
    print("  объектов к откату: %d" % len(targets))
    by_type = {}
    for r in targets:
        by_type[r["itemtype"]] = by_type.get(r["itemtype"], 0) + 1
    for k in sorted(by_type):
        print("    %-32s %d" % (k, by_type[k]))

    try:
        client = client_from_env(args, out_ledger)
    except SafetyError as exc:
        print("\n[STOP] %s" % exc)
        return 2
    client.allow_delete = True
    client.max_changes = args.max_changes

    rc = 0
    try:
        client.init_session()

        try:
            tickets = client._request("GET", "Ticket", params={"range": "0-1"}) or []
        except GlpiError:
            tickets = []
        if tickets and not args.force:
            print("\n[STOP] В системе уже есть заявки. Удаление категорий и групп "
                  "разорвёт ссылки\n       в существующих заявках и исказит "
                  "статистику. Если откат всё равно нужен —\n       повторите с "
                  "--force, предварительно сняв бэкап БД.")
            return 2

        for rec in targets:
            itemtype = rec["itemtype"]
            item_id = rec["id"]
            expected_name = (rec.get("payload") or {}).get("name")
            try:
                current_item = client.get_item(itemtype, item_id)
            except GlpiError:
                client.log("skip", "%s id=%s уже отсутствует" % (itemtype, item_id))
                client.bump("skip")
                continue
            if expected_name and str(current_item.get("name", "")).strip() != str(expected_name).strip():
                client.log("warn", "%s id=%s сейчас называется '%s', в журнале '%s' — "
                                   "пропуск, разбирайтесь руками"
                           % (itemtype, item_id, current_item.get("name"), expected_name))
                client.bump("skip")
                continue
            try:
                client.delete(itemtype, item_id, step="rollback",
                              purge=not args.no_purge,
                              label="'%s'" % (expected_name or ""))
            except GlpiError as exc:
                rc = 1
                client.log("err", "%s id=%s не удалён: %s" % (itemtype, item_id, exc))
                client.log("info", "Обычная причина — объект уже используется "
                                   "(категория в заявке, календарь в SLM). "
                                   "Сначала удалите зависимые объекты.")
    except SafetyError as exc:
        print("\n[STOP] Сработала защита: %s" % exc)
        rc = 2
    except GlpiError as exc:
        print("\n[ERROR] %s" % exc)
        rc = 1
    finally:
        client.kill_session()

    print("\n" + "-" * 78)
    print("Итог: %s" % client.summary())
    print("Журнал отката: %s" % out_ledger.path)
    if not args.apply:
        print("\nЭто был DRY-RUN. Ничего не удалено. Для выполнения добавьте --apply.")
    else:
        print("\nОтразите откат в docs/glpi/config-log.md (статус записи -> «откачено»).")
    return rc


if __name__ == "__main__":
    sys.exit(main())
