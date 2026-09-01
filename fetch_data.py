"""Выгрузка расписания из публикации mstimetables в статические JSON-файлы.

Запуск:  uv run python fetch_data.py [--limit N] [--weeks K]
  --limit N  взять только первые N групп (для быстрой проверки)
  --weeks K  сколько недель качать, начиная с текущей (по умолчанию 2)

Результат кладётся в папку data/ рядом со скриптом:
  meta.json, groups.json, teachers.json, cabinets.json, week-ГГГГ-ММ-ДД.json
"""

import argparse
import datetime as dt
import json
import pathlib
import sys
import time
import urllib.request

BASE = "https://schedule.mstimetables.ru/api/publications"
PUBLICATION_ID = "daaaf5b9-665d-44a1-b349-0ebc10ca5441"
OUT_DIR = pathlib.Path(__file__).resolve().parent / "data"
DELAY_SEC = 0.08  # пауза между запросами, чтобы не долбить чужой сервер
MSK = dt.timezone(dt.timedelta(hours=3))

HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "lesgaft-personal-timetable/1.0 (personal use)",
}


def http_get(path):
    req = urllib.request.Request(f"{BASE}/{PUBLICATION_ID}/{path}", headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def http_post(path, body):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(f"{BASE}/{path}", data=data, headers=HEADERS, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def monday_of_current_week():
    today = dt.datetime.now(MSK).date()
    return today - dt.timedelta(days=today.weekday())


def clean_lesson(raw):
    """Оставляем только нужные поля, выбрасываем мусор вроде publication: null."""
    groups = []
    for ug in raw.get("unionGroups") or []:
        g = ug.get("group") or {}
        sub = ug.get("subgroup")
        if isinstance(sub, dict):
            sub = sub.get("name")
        groups.append({
            "id": g.get("id"),
            "name": g.get("name"),
            "subgroup": sub,
        })
    subject = raw.get("subject") or {}
    type_lesson = raw.get("typeLesson") or {}
    cabinet = raw.get("cabinet") or None
    return {
        "id": raw.get("id"),
        "weekday": raw.get("weekday"),  # 1 = понедельник
        "num": raw.get("lesson"),
        "start": raw.get("startTime"),
        "end": raw.get("endTime"),
        "startMin": raw.get("startTimeMin"),
        "subject": subject.get("name"),
        "type": type_lesson.get("name"),
        "cabinet": {"id": cabinet.get("id"), "name": cabinet.get("name")} if cabinet else None,
        "teachers": [{"id": t.get("id"), "fio": t.get("fio")} for t in raw.get("teachers") or []],
        "groups": groups,
    }


def save_json(name, payload):
    OUT_DIR.mkdir(exist_ok=True)
    path = OUT_DIR / name
    path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  {name}: {path.stat().st_size / 1024:.0f} КБ")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--weeks", type=int, default=4)
    args = parser.parse_args()

    print("Качаю справочники...")
    bootstrap = http_get("bootstrap")
    groups = http_get("groups")
    teachers = http_get("teachers")
    cabinets = http_get("cabinets")
    print(f"  групп: {len(groups)}, преподавателей: {len(teachers)}, аудиторий: {len(cabinets)}")

    if args.limit:
        groups_to_fetch = groups[: args.limit]
        print(f"Режим проверки: только {len(groups_to_fetch)} групп")
    else:
        groups_to_fetch = groups

    mondays = [monday_of_current_week() + dt.timedelta(weeks=i) for i in range(args.weeks)]
    weeks_out = {}  # monday -> {lesson_id: lesson}

    total = len(groups_to_fetch) * len(mondays)
    done = 0
    errors = 0
    for monday in mondays:
        lessons_by_id = weeks_out.setdefault(monday, {})
        for group in groups_to_fetch:
            done += 1
            try:
                data = http_post("group/lessons", {
                    "publicationId": PUBLICATION_ID,
                    "groupId": group["id"],
                    "date": monday.isoformat(),
                })
                for raw in data.get("lessons") or []:
                    lesson = clean_lesson(raw)
                    if lesson["id"]:
                        lessons_by_id[lesson["id"]] = lesson
            except Exception as exc:  # noqa: BLE001 - сбой одной группы не должен валить весь синк
                errors += 1
                print(f"  ! группа {group.get('name')} ({monday}): {exc}", file=sys.stderr)
            if done % 50 == 0 or done == total:
                print(f"  {done}/{total} запросов, пар собрано: {sum(len(w) for w in weeks_out.values())}")
            time.sleep(DELAY_SEC)

    print("Сохраняю файлы...")
    save_json("groups.json", groups)
    save_json("teachers.json", teachers)
    save_json("cabinets.json", cabinets)
    week_names = []
    for monday, lessons_by_id in weeks_out.items():
        lessons = sorted(lessons_by_id.values(), key=lambda l: (l["weekday"], l["startMin"] or 0))
        name = f"week-{monday.isoformat()}.json"
        week_names.append({"start": monday.isoformat(), "file": name, "lessons": len(lessons)})
        save_json(name, {"weekStart": monday.isoformat(), "lessons": lessons})
    save_json("meta.json", {
        "siteName": bootstrap.get("siteName"),
        "updatedAt": dt.datetime.now(MSK).strftime("%Y-%m-%d %H:%M"),
        "weeks": week_names,
        "errors": errors,
    })
    print("Готово." + (f" Ошибок: {errors}" if errors else ""))


if __name__ == "__main__":
    main()
