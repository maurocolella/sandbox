"""Generate fixtures/cif-syntax/cases.json: CIF edge-case inputs with gemmi's reading as the reference.

gemmi keeps raw tokens (quotes included) and errors where the spec says error; where our tolerant parser
deliberately differs (see whitepapers/mmcif-parser.md §3), tests should say so explicitly.
Usage: python syntax_cases.py > ../fixtures/cif-syntax/cases.json   (gemmi 0.7.5)
"""
import json
import sys

import gemmi

CASES = {
    "embedded_quote": "data_x\n_a 'a dog's life'\n",
    "quote_then_hash": "data_x\n_a 'abc'#comment\n",
    "quoted_null": "data_x\n_a '.'\n_b .\n_c '?'\n_d ?\n",
    "text_leading_nl": "data_x\n_a\n;\nline1\n  line2  \n;\n",
    "text_same_line": "data_x\n_a\n;line1\nline2\n;\n",
    "text_crlf": "data_x\r\n_a\r\n;line1\r\nline2\r\n;\r\n",
    "text_close_nows": "data_x\n_a\n;abc\n;_b 1\n",
    "semicolon_midline": "data_x\n_a ;abc\n",
    "hash_in_bare": "data_x\n_a ab#c\n",
    "reserved_global": "data_x\n_a global_\n",
    "reserved_datalike": "data_x\n_a data_foo\n",
    "bracket_lead": "data_x\n_a [abc]\n",
    "dollar_lead": "data_x\n_a $abc\n",
    "case_tags": "data_x\n_A.B 1\n_a.b 2\n",
    "LOOP_upper": "data_x\nLOOP_\n_a.x\n_a.y\n1 2 3 4\n",
    "empty_loop": "data_x\nloop_\n_a.x\n_a.y\n_b.z 1\n",
    "loop_bad_count": "data_x\nloop_\n_a.x\n_a.y\n1 2 3\n",
    "no_trailing_nl": "data_x\n_a 1",
    "unterminated_text": "data_x\n_a\n;abc\n",
    "bare_data_": "data_\n_a 1\n",
    "missing_value": "data_x\n_a\n_b 1\n",
    "stop_": "data_x\nloop_\n_a.x\n1 2\nstop_\n_b 1\n",
    "triple_quote": "data_x\n_a '''abc'''\n",
    "bom": "﻿data_x\n_a 1\n",
    "tab_sep": "data_x\n_a\t1\n",
    "quote_eol_unclosed": "data_x\n_a 'abc\n_b 1\n",
    "dup_tag": "data_x\n_a 1\n_a 2\n",
    "two_blocks": "data_x\n_a 1\ndata_y\n_a 2\n",
}


def read(text):
    try:
        doc = gemmi.cif.read_string(text)
    except Exception as e:  # gemmi reports spec violations as errors
        return {"ok": False, "error": str(e)}
    blocks = []
    for b in doc:
        items = []
        for it in b:
            if it.pair is not None:
                items.append({"tag": it.pair[0], "raw": it.pair[1]})
            elif it.loop is not None:
                items.append({"loop": list(it.loop.tags), "raw": list(it.loop.values)})
        blocks.append({"name": b.name, "items": items})
    return {"ok": True, "blocks": blocks}


if __name__ == "__main__":
    out = {name: {"input": text, "gemmi": read(text)} for name, text in CASES.items()}
    json.dump({"gemmiVersion": gemmi.__version__, "cases": out}, sys.stdout, indent=1, ensure_ascii=False)
    sys.stdout.write("\n")
