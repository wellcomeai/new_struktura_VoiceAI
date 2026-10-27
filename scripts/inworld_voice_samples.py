"""
Примеры голосов Inworld для Каскада одной фразой → R2, через Voximplant.
Запуск в Shell на Render (ключи Voximplant и R2 берутся из окружения сервиса):

    python3 scripts/inworld_voice_samples.py               # все голоса
    python3 scripts/inworld_voice_samples.py Galina Lev    # выбранные
    python3 scripts/inworld_voice_samples.py --no-upload   # без R2, файлы в ./voice_samples_out

Ключ Inworld не нужен: синтез делает Modules.Inworld в Voximplant на биллинге
родительского аккаунта (как в звонках Каскада). Скрипт:
  1. кладёт voximplant_scenarios/voice_samples_inworld.js на родительский аккаунт
     (сценарий voice_samples_inworld) и при необходимости создаёт правило с тем же
     именем — паттерн не совпадает ни с одним номером, звонки на него не попадут;
  2. StartScenarios без звонка: сценарий по очереди озвучивает фразу каждым голосом
     в отдельную запись Voximplant "voice-sample-<голос>" (mp3 48 кГц). Сессия без
     звонков живёт не больше 60 с (лимит VoxEngine), поэтому голоса идут пачками по
     BATCH_SIZE — отдельными сессиями, одновременно;
  3. ждёт конца сессий, берёт записи из GetCallHistory (with_records) и копирует их в
     R2 voice-samples/cascade/<голос в нижнем регистре>.mp3 — их играет кнопка
     «Послушать» (js/voice-samples.js); обновляет записи provider=cascade в index.json.
     Записи на аккаунте закрытые (secure): для скачивания скрипт создаёт временный
     ключ сервисного аккаунта (CreateKey), подписывает им JWT и в конце ключ удаляет.

Голоса — INWORLD_VOICES в backend/api/grok_assistants.py, модель — как в звонках.
"""
import argparse
import asyncio
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone

import httpx

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from voice_samples import PHRASE, R2_PREFIX, make_uploader  # noqa: E402  (импортирует backend.core.config)

from backend.api.grok_assistants import INWORLD_VOICES  # noqa: E402
from backend.services.r2_storage import VoximplantAuth  # noqa: E402
from backend.services.voximplant_partner import get_voximplant_partner_service  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCENARIO_NAME = "voice_samples_inworld"
SCENARIO_FILE = os.path.join(ROOT, "voximplant_scenarios", "voice_samples_inworld.js")
RULE_PATTERN = "voice_samples_inworld_only"   # не номер — входящие звонки сюда не попадут
INWORLD_MODEL = "inworld-tts-2"               # как INWORLD_MODEL в inbound_cascade.js / outbound_cascade.js
POLL_INTERVAL_S = 5
BATCH_SIZE = 5            # голосов на сессию: ~7 с на голос, сессия без звонка живёт ≤ 60 с
SESSION_WAIT_S = 120


async def vox(svc, method: str, **params) -> dict:
    """Вызов Management API от имени родительского аккаунта."""
    client = await svc._get_client()
    data = {"account_id": svc.parent_account_id, "api_key": svc.parent_api_key, **params}
    result = (await client.post(f"{svc.API_BASE_URL}/{method}", data=data)).json()
    if "error" in result:
        raise RuntimeError(f"{method}: {result['error']}")
    return result


async def ensure_scenario(svc) -> int:
    code = open(SCENARIO_FILE, encoding="utf-8").read()
    found = await svc.get_parent_scenarios(with_script=False)
    ids = {s["scenario_name"]: s["scenario_id"] for s in found.get("scenarios", [])}
    if SCENARIO_NAME in ids:
        r = await svc.set_scenario_info(svc.parent_account_id, svc.parent_api_key,
                                        int(ids[SCENARIO_NAME]), scenario_script=code)
        scenario_id = int(ids[SCENARIO_NAME])
    else:
        r = await svc.add_scenario(svc.parent_account_id, svc.parent_api_key, SCENARIO_NAME, code)
        scenario_id = int(r.get("scenario_id") or 0)
    if not r.get("success"):
        raise RuntimeError(f"сценарий {SCENARIO_NAME}: {r.get('error')}")
    return scenario_id


async def ensure_rule(svc, scenario_id: int, app_hint: str) -> int:
    apps = (await vox(svc, "GetApplications")).get("result", [])
    if not apps:
        raise RuntimeError("на родительском аккаунте нет приложений")
    app = next((a for a in apps if app_hint and app_hint in a.get("application_name", "")), None) \
        or next((a for a in apps if a.get("application_name", "").startswith("voicyfy")), None) or apps[0]
    app_id = app["application_id"]
    rules = await svc.get_rules(svc.parent_account_id, svc.parent_api_key, str(app_id), count=1000)
    rule = next((r for r in rules.get("rules", []) if r.get("rule_name") == SCENARIO_NAME), None)
    if rule:
        return int(rule["rule_id"])
    r = await svc.add_rule(svc.parent_account_id, svc.parent_api_key, str(app_id),
                           SCENARIO_NAME, RULE_PATTERN, scenario_id)
    if not r.get("success"):
        raise RuntimeError(f"правило {SCENARIO_NAME}: {r.get('error')}")
    print(f"создано правило {SCENARIO_NAME} в приложении {app.get('application_name')}")
    return int(r["rule_id"])


async def wait_records(svc, session_id, expected: int, timeout_s: int) -> dict:
    """Ждёт конца сессии и все записи; возвращает сессию из GetCallHistory."""
    now = datetime.now(timezone.utc)
    fmt = "%Y-%m-%d %H:%M:%S"
    deadline = time.monotonic() + timeout_s
    session, polls_after_end = {}, 0
    while time.monotonic() < deadline:
        await asyncio.sleep(POLL_INTERVAL_S)
        res = (await vox(svc, "GetCallHistory", call_session_history_id=session_id,
                         from_date=(now - timedelta(hours=1)).strftime(fmt),
                         to_date=(now + timedelta(hours=2)).strftime(fmt),
                         with_records="true")).get("result", [])
        session = res[0] if res else {}
        records = session.get("records") or []
        finished = session.get("duration") is not None
        print(f"  … записей {len(records)}/{expected}" + (" (сессия завершена)" if finished else ""))
        if finished and len(records) >= expected:
            break
        if finished:
            polls_after_end += 1
            if polls_after_end >= 3:   # сессия закончилась, записи не дописываются — части голосов нет
                break
    return session


async def main():
    p = argparse.ArgumentParser(description="Примеры голосов Inworld (Каскад) через Voximplant → R2")
    p.add_argument("voices", nargs="*", help="только эти голоса (id Inworld, например Galina)")
    p.add_argument("--phrase", default=PHRASE)
    p.add_argument("--model", default=INWORLD_MODEL)
    p.add_argument("--app", default="", help="часть имени приложения Voximplant для служебного правила")
    p.add_argument("--no-upload", action="store_true", help="не грузить в R2, сохранить в --out")
    p.add_argument("--out", default="voice_samples_out")
    args = p.parse_args()

    known = {vid.lower(): (vid, name, gender) for vid, name, gender, _ in INWORLD_VOICES}
    missing = [v for v in args.voices if v.lower() not in known]
    if missing:
        raise SystemExit(f"Неизвестные голоса: {missing}. Есть: {[v[0] for v in INWORLD_VOICES]}")
    jobs = [known[v.lower()] for v in args.voices] or [(v, n, g) for v, n, g, _ in INWORLD_VOICES]

    uploader, reader = make_uploader(args.no_upload, args.out)
    svc = get_voximplant_partner_service()
    scenario_id = await ensure_scenario(svc)
    rule_id = await ensure_rule(svc, scenario_id, args.app)

    batches = [jobs[i:i + BATCH_SIZE] for i in range(0, len(jobs), BATCH_SIZE)]
    sessions = []
    for batch in batches:
        custom = json.dumps({"voices": [j[0] for j in batch], "phrase": args.phrase, "model": args.model},
                            ensure_ascii=False)
        started = await svc.start_scenarios(svc.parent_account_id, svc.parent_api_key, rule_id, custom)
        if not started.get("success"):
            raise SystemExit(f"StartScenarios: {started.get('error')}")
        sessions.append(started["call_session_history_id"])
        print(f"сессия {started['call_session_history_id']}: {', '.join(j[0] for j in batch)}")
    print(f"{len(jobs)} голосов в {len(sessions)} сессиях, модель {args.model}, фраза «{args.phrase}»")

    done = await asyncio.gather(*(wait_records(svc, sid, len(b), SESSION_WAIT_S)
                                  for sid, b in zip(sessions, batches)))
    by_name = {}
    for session in done:
        by_name.update({r.get("record_name"): r for r in session.get("records") or []})
        if session.get("log_file_url") and len(session.get("records") or []) < BATCH_SIZE:
            print("лог сессии:", session["log_file_url"])

    # Временный ключ сервисного аккаунта: записи закрытые, без JWT отдают 401.
    key = await svc.create_key(svc.parent_account_id, svc.parent_api_key,
                               key_name="voice_samples_tmp", description="временный, удаляется скриптом",
                               roles=["Owner"])
    if not key.get("success"):
        raise SystemExit(f"CreateKey: {key.get('error')}")
    auth = VoximplantAuth({"account_id": svc.parent_account_id, "key_id": key["key_id"],
                           "private_key": key["private_key"]})

    results = []
    try:
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as http:
            for vid, name, gender in jobs:
                row = {"provider": "cascade", "voice": vid, "slug": vid.lower(), "name": name,
                       "gender": "ж" if gender == "female" else "м", "model": args.model}
                rec = by_name.get(f"voice-sample-{vid}")
                try:
                    if not rec or not rec.get("record_url"):
                        raise RuntimeError("записи нет (смотрите ===SAMPLE=== в логе сессии)")
                    resp = await http.get(rec["record_url"], headers={"Authorization": auth.build_auth_header()})
                    if resp.status_code != 200:
                        raise RuntimeError(f"скачивание: HTTP {resp.status_code}")
                    url = uploader(f"{R2_PREFIX}/cascade/{vid.lower()}.mp3", resp.content, "audio/mpeg")
                    row.update(url=url, duration_s=rec.get("duration"), size_kb=len(resp.content) // 1024)
                except Exception as e:
                    row["error"] = str(e)
                results.append(row)
    finally:
        deleted = await svc.delete_key(svc.parent_account_id, svc.parent_api_key, key["key_id"])
        print("временный ключ удалён" if deleted.get("success") else f"⚠️ удалите ключ {key['key_id']} вручную")

    print("\n" + "═" * 96)
    print(f"{'голос':<10} {'имя':<10} {'пол':<3} {'сек':>4} {'КБ':>5}  ссылка")
    print("─" * 96)
    for r in results:
        if r.get("error"):
            print(f"{r['voice']:<10} {r['name']:<10} {r['gender']:<3} {'—':>4} {'—':>5}  ❌ {r['error']}")
        else:
            print(f"{r['voice']:<10} {r['name']:<10} {r['gender']:<3} {r['duration_s'] or '—':>4} "
                  f"{r['size_kb']:>5}  {r['url']}")

    if any(not r.get("error") for r in results):
        print("index.json:", save_index(results, uploader, reader, args.phrase))
    await svc.close()
    if any(r.get("error") for r in results):
        sys.exit(1)


def save_index(results, uploader, reader, phrase):
    """index.json: записи cascade поверх прежних, остальные провайдеры не трогаем."""
    key = f"{R2_PREFIX}/index.json"
    try:
        index = json.loads(reader(key) or b"{}")
    except ValueError:
        index = {}
    fresh = {r["slug"]: r for r in results if not r.get("error")}
    voices = [fresh.pop(v.get("slug"), v) if v.get("provider") == "cascade" else v
              for v in index.get("voices") or []]
    voices += list(fresh.values())
    index.update({"voices": voices, "cascade_phrase": phrase,
                  "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    return uploader(key, json.dumps(index, ensure_ascii=False, indent=2).encode("utf-8"),
                    "application/json; charset=utf-8")


if __name__ == "__main__":
    asyncio.run(main())
