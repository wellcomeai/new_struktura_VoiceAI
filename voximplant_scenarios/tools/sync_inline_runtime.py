#!/usr/bin/env python3
"""Синхронизирует инлайн-копию VoxTurnTaking в outbound_cascade.js.

Источник правды — vox-turn-taking.js. outbound_cascade.js обязан быть
самодостаточным (работает и одиночным правилом, и в цепочке), поэтому носит
копию рантайма внутри себя. Копия генерируется этим скриптом, руками её править
нельзя — иначе исходящие звонки тихо останутся на старой логике turn-taking.

    python3 voximplant_scenarios/tools/sync_inline_runtime.py [--check]

--check ничего не пишет, а только сообщает, разъехались ли копии (код возврата
1, если да). Удобно как гейт перед раскаткой.
"""
import argparse
import pathlib
import re
import sys

BASE = pathlib.Path(__file__).resolve().parent.parent
SRC = BASE / "vox-turn-taking.js"
DST = BASE / "outbound_cascade.js"

BEGIN = "// ===== BEGIN INLINE VoxTurnTaking (auto-synced from vox-turn-taking.js) ====="
END = "// ===== END INLINE VoxTurnTaking ====="

HEADER = """// Идемпотентно: если правило — цепочка [vox-turn-taking, outbound_cascade], то
// vox-turn-taking.js уже объявил глобальный VoxTurnTaking (const) → typeof !==
// "undefined" → это определение ПРОПУСКАЕТСЯ. Если правило одиночное —
// объявляем здесь. Присваивание без const/var, чтобы не конфликтовать с
// const-объявлением в цепочечном режиме.
//
// НЕ РЕДАКТИРОВАТЬ ВРУЧНУЮ: блок генерируется скриптом
// voximplant_scenarios/tools/sync_inline_runtime.py из vox-turn-taking.js."""


def build_block() -> str:
    src = SRC.read_text(encoding="utf-8")
    match = re.search(r"^const VoxTurnTaking = \{$", src, re.M)
    if not match:
        sys.exit("не найдено объявление `const VoxTurnTaking = {` в vox-turn-taking.js")

    body = src[match.end():].rstrip()
    if not body.endswith("};"):
        sys.exit("неожиданный хвост vox-turn-taking.js: ожидалось закрытие `};`")
    body = body[: -len("};")].rstrip()

    indented = "\n".join(("    " + ln) if ln.strip() else "" for ln in body.split("\n"))
    return (
        f"{BEGIN}\n{HEADER}\n"
        f'if (typeof VoxTurnTaking === "undefined") {{\n'
        f"    // eslint-disable-next-line no-global-assign, no-undef\n"
        f"    VoxTurnTaking = {{\n{indented}\n    }};\n}}\n{END}"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true",
                        help="только проверить синхронность, ничего не записывать")
    args = parser.parse_args()

    dst = DST.read_text(encoding="utf-8")
    if BEGIN not in dst or END not in dst:
        sys.exit(
            "в outbound_cascade.js нет маркеров инлайн-блока "
            f"({BEGIN!r} / {END!r}) — впаять их вручную один раз"
        )

    start = dst.index(BEGIN)
    stop = dst.index(END) + len(END)
    block = build_block()

    if dst[start:stop] == block:
        print("ok: инлайн-копия совпадает с vox-turn-taking.js")
        return 0

    if args.check:
        print("РАСХОЖДЕНИЕ: инлайн-копия в outbound_cascade.js отстала от "
              "vox-turn-taking.js. Запустить без --check.", file=sys.stderr)
        return 1

    DST.write_text(dst[:start] + block + dst[stop:], encoding="utf-8")
    print(f"ok: инлайн-копия обновлена ({len(block)} байт)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
