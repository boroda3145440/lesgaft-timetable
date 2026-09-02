"""Выгрузка расписания из публикации mstimetables в зашифрованные файлы data/*.json.enc.

Запуск:  python fetch_data.py [--limit N] [--weeks K] [--password P] [--encrypt-only] [--plain]
  --limit N       взять только первые N групп (для быстрой проверки)
  --weeks K       сколько недель качать, начиная с текущей (по умолчанию 4)
  --password P    пароль сайта; иначе берётся из переменной TIMETABLE_PASSWORD
                  или из файла .password рядом со скриптом
  --encrypt-only  ничего не качать, зашифровать уже лежащие в data/ открытые *.json
  --plain         писать открытые *.json (только для отладки, в репо они не попадают)

Шифрование: gzip -> AES-256-GCM, ключ из пароля через PBKDF2-SHA256 (соль и число
итераций те же, что в app.js). IV выводится из ключа и содержимого, поэтому при
неизменных данных файл побайтно тот же - робот не делает пустых коммитов.
Нужна библиотека cryptography:  pip install cryptography
"""

import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
import pathlib
import sys
import time
import urllib.request

BASE = "https://schedule.mstimetables.ru/api/publications"
PUBLICATION_ID = "daaaf5b9-665d-44a1-b349-0ebc10ca5441"
OUT_DIR = pathlib.Path(__file__).resolve().parent / "data"
DELAY_SEC = 0.08  # пауза между запросами, чтобы не долбить чужой сервер
MSK = dt.timezone(dt.timedelta(hours=3))

# параметры вывода ключа из пароля - должны совпадать с app.js
KDF_SALT = bytes.fromhex("6c6573676166742d74696d657461626c652d3230323600")
KDF_ITER = 200_000
ENC_SUFFIX = ".enc"
PLAIN = False       # --plain: писать открытые json
ENC_KEY = None      # 32-байтный ключ AES

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


def read_password(cli_value):
    if cli_value:
        return cli_value
    env = os.environ.get("TIMETABLE_PASSWORD")
    if env:
        return env
    pw_file = pathlib.Path(__file__).resolve().parent / ".password"
    if pw_file.exists():
        return pw_file.read_text(encoding="utf-8").strip()
    return None


def derive_key(password):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), KDF_SALT, KDF_ITER, dklen=32)


def encrypt_bytes(plain):
    """gzip + AES-GCM. IV детерминированный (sha256 от ключа и сжатых данных):
    одинаковые данные -> одинаковый файл, разные данные -> разный IV."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: PLC0415
    gz = gzip.compress(plain, mtime=0)
    iv = hashlib.sha256(ENC_KEY + gz).digest()[:12]
    return iv + AESGCM(ENC_KEY).encrypt(iv, gz, None)


def save_json(name, payload):
    OUT_DIR.mkdir(exist_ok=True)
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if PLAIN:
        path = OUT_DIR / name
        path.write_bytes(raw)
    else:
        path = OUT_DIR / (name + ENC_SUFFIX)
        path.write_bytes(encrypt_bytes(raw))
    print(f"  {path.name}: {path.stat().st_size / 1024:.0f} КБ")


def encrypt_existing():
    """Зашифровать открытые data/*.json, которые уже лежат на диске (без выгрузки)."""
    files = sorted(OUT_DIR.glob("*.json"))
    if not files:
        sys.exit("В data/ нет открытых *.json - нечего шифровать.")
    for f in files:
        save_json(f.name, json.loads(f.read_text(encoding="utf-8")))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--weeks", type=int, default=4)
    parser.add_argument("--password", default=None)
    parser.add_argument("--encrypt-only", action="store_true")
    parser.add_argument("--plain", action="store_true")
    args = parser.parse_args()

    global PLAIN, ENC_KEY  # noqa: PLW0603
    PLAIN = args.plain
    if not PLAIN:
        password = read_password(args.password)
        if not password:
            sys.exit("Нет пароля: укажи --password, переменную TIMETABLE_PASSWORD или файл .password "
                     "(либо --plain для открытых файлов).")
        ENC_KEY = derive_key(password)
    if args.encrypt_only:
        print("Шифрую существующие файлы...")
        encrypt_existing()
        print("Готово.")
        return

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
