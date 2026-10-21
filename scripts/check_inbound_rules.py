"""
Сверка inbound-правил Voximplant с привязками номеров в БД.
Запуск в Shell на Render:

    python3 scripts/check_inbound_rules.py                 # все номера, только отчёт
    python3 scripts/check_inbound_rules.py 79666669642     # один номер (цифры, можно с +)
    python3 scripts/check_inbound_rules.py --fix           # пересоздать правила проблемных номеров

Ищет номера, у которых звонок уйдёт не туда, куда указывает БД:
  missing   — правила из voximplant_phone_numbers.vox_rule_id нет в Voximplant;
  orphan    — у номера есть правила, которых нет в БД (перехватывают звонок);
  no_rule   — ассистент привязан, а правила для номера нет;
  scenario  — правило ведёт не в сценарий типа ассистента (inbound_gemini вместо inbound_fish …).

--fix вызывает rebind_inbound_rule (тот же код, что и привязка в кабинете): удаляет
все правила номера и создаёт одно под текущий assistant_type. Номера без
ассистента, тестового пула и запаса для физлиц не чинятся — только отчёт.
"""
import argparse
import asyncio
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(line_buffering=True)

# Конфиг — первым, как в app.py (иначе циклический импорт моделей)
import backend.core.config  # noqa: E402,F401
from backend.db.session import SessionLocal  # noqa: E402
from backend.models.voximplant_child import VoximplantChildAccount, VoximplantPhoneNumber  # noqa: E402
from backend.api.telephony import get_scenario_key, normalize_phone_number, rebind_inbound_rule  # noqa: E402
from backend.services.voximplant_partner import get_voximplant_partner_service  # noqa: E402


def rule_scenario_ids(rule: dict) -> set:
    ids = set()
    for sc in rule.get("scenarios") or []:
        if isinstance(sc, dict) and sc.get("scenario_id") is not None:
            ids.add(str(sc["scenario_id"]))
    return ids


def rule_scenario_names(rule: dict) -> str:
    names = [sc.get("scenario_name") or str(sc.get("scenario_id"))
             for sc in rule.get("scenarios") or [] if isinstance(sc, dict)]
    return " → ".join(names) or "?"


def check_number(phone: VoximplantPhoneNumber, rules: list, legacy_rule_id: str) -> list:
    pattern = normalize_phone_number(phone.phone_number)
    own = [r for r in rules
           if str(r.get("rule_id")) != legacy_rule_id
           and (r.get("rule_pattern") == pattern or r.get("rule_name") == f"inbound_{pattern}")]
    db_rule = str(phone.vox_rule_id or "")
    problems = []

    if db_rule and db_rule != legacy_rule_id and db_rule not in {str(r.get("rule_id")) for r in own}:
        problems.append(f"missing: правила {db_rule} из БД нет в Voximplant")
    orphans = [r for r in own if str(r.get("rule_id")) != db_rule]
    for r in orphans:
        problems.append(f"orphan: правило {r.get('rule_id')} {r.get('rule_name')} → "
                        f"{rule_scenario_names(r)} не записано в БД")
    if phone.assistant_type and not own and db_rule != legacy_rule_id:
        problems.append("no_rule: ассистент привязан, правила нет")

    expected_name = get_scenario_key(phone.assistant_type, "inbound") if phone.assistant_type else None
    expected_id = phone.child_account.get_scenario_id(expected_name) if expected_name else None
    if expected_id and not phone.is_test_pool:
        for r in own:
            if r.get("scenarios") and str(expected_id) not in rule_scenario_ids(r):
                problems.append(f"scenario: правило {r.get('rule_id')} ведёт в {rule_scenario_names(r)}, "
                                f"а привязан {phone.assistant_type} ({expected_name})")
    elif phone.assistant_type and not expected_id:
        problems.append(f"scenario: на аккаунте нет сценария {expected_name}")
    return problems


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phone", nargs="?", help="номер (цифры); без него — все номера")
    parser.add_argument("--fix", action="store_true", help="пересоздать правила проблемных номеров")
    args = parser.parse_args()

    service = get_voximplant_partner_service()
    db = SessionLocal()
    try:
        query = db.query(VoximplantPhoneNumber).filter(VoximplantPhoneNumber.phone_source == "voximplant")
        numbers = query.all()
        if args.phone:
            digits = re.sub(r"\D", "", args.phone)[-10:]
            numbers = [n for n in numbers if re.sub(r"\D", "", n.phone_number).endswith(digits)]

        # Номера физлиц (is_hosted) лежат в приложении аккаунта администратора:
        # правила читаем один раз на (аккаунт, приложение).
        groups = defaultdict(list)
        for n in numbers:
            acc = n.child_account
            if acc and acc.vox_application_id:
                groups[(acc.vox_account_id, str(acc.vox_application_id))].append(n)

        total = bad = fixed = 0
        for (vox_account_id, app_id), phones in groups.items():
            acc = next((p.child_account for p in phones if not p.child_account.is_hosted), phones[0].child_account)
            res = await service.get_rules(
                child_account_id=vox_account_id, child_api_key=acc.vox_api_key,
                application_id=app_id, count=1000, with_scenarios=True,
            )
            if not res.get("success"):
                print(f"⚠️  {vox_account_id}: GetRules не отработал: {res.get('error')}")
                continue
            rules = res.get("rules") or []
            for phone in phones:
                total += 1
                legacy = str(phone.child_account.vox_rule_id or "")
                problems = check_number(phone, rules, legacy)
                if not problems:
                    continue
                bad += 1
                owner = phone.child_account.user.email if phone.child_account.user else "?"
                print(f"❌ {phone.phone_number} ({owner}, аккаунт {vox_account_id}, "
                      f"тип {phone.assistant_type}, rule в БД {phone.vox_rule_id})")
                for p in problems:
                    print(f"     {p}")
                if args.fix and phone.assistant_type and not phone.is_test_pool and not phone.hosted_stock:
                    ok = await rebind_inbound_rule(phone.child_account, phone, phone.assistant_type, "[CHECK-RULES]")
                    db.commit()
                    fixed += ok
                    print(f"     {'✅ пересоздано, rule ' + str(phone.vox_rule_id) if ok else '❌ не удалось пересоздать'}")
                    # Список правил изменился — перечитываем для следующих номеров
                    res = await service.get_rules(
                        child_account_id=vox_account_id, child_api_key=acc.vox_api_key,
                        application_id=app_id, count=1000, with_scenarios=True,
                    )
                    rules = res.get("rules") or rules

        print(f"\nПроверено номеров: {total}, с проблемами: {bad}" + (f", исправлено: {fixed}" if args.fix else ""))
    finally:
        db.close()


if __name__ == "__main__":
    asyncio.run(main())
