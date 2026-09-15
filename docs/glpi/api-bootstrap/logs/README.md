# Журналы запусков

Сюда `bootstrap.py` и `rollback.py` пишут файлы `ledger-<дата>-<режим>.jsonl`
и `rollback-<дата>-<режим>.jsonl`.

Одна строка — одна операция:

```json
{"ts":"2026-09-22T09:14:03Z","instance":"https://sd.hofi.su/apirest.php",
 "run_id":"20260922-121403-3312","step":"categories","itemtype":"ITILCategory",
 "action":"create","id":47,"match":{"name":"1С","itilcategories_id":12},
 "payload":{"...":"..."},"dry_run":false}
```

Журнал `*-apply.jsonl` — **единственный вход для отката**: `rollback.py`
удаляет ровно те id, которые в нём записаны как `action=create`.
Потеряли журнал — откат придётся делать руками по `docs/glpi/config-log.md`.

Сами файлы в git не попадают (`.gitignore`): в них id конкретного инстанса,
а не переносимая конфигурация. После применения перенесите итог (какие
объекты и с какими id созданы) в `docs/glpi/config-log.md` — это то, что
переживает пересоздание инстанса.
