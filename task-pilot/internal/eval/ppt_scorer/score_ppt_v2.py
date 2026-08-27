#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PPT 生成题评分器 v2 —— 排版为重点,三部分线性加权(无一票否决)。

  total = 0.5 * layout_soft   # 排版无破绽(复用 eval/internal/ppt/layout 10 维 SOFT 分级罚分) —— 最重
        + 0.2 * aesthetic     # 排版美学/无陈旧审美(新维)
        + 0.3 * compliance    # 遵循:对着 gold 清单判命中(required_numbers/structure/要点覆盖/grounding)

调用粒度(用户拍板):
  - layout + 美学 = 逐页判(一页一次 gemini 调用,单页视觉属性,同一次出 10 维 + 美学)
  - compliance    = 整体判(所有页 + gold 清单一次调用,覆盖率是全局属性)
  N 页 deck = N 次逐页 + 1 次整体 = N+1 次 gemini-3.5-flash。

评委 = gemini-3.5-flash(sidecar),复用 eval/internal/ppt/layout 的 vlm_client + aggregate_quality。
🔴 评委必须 ≠ 造题器(opus),防 reward hack。

用法:
  python3 score_ppt_v2.py --deck <deck.pptx|.html> --gold <gold_reference.json> [--out score.json]
  # 先 render_deck 出 png,再逐页+整体判,打印 total + 三部分明细。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
# 优先同目录(容器/bundle 里 prompts.py+aggregate_quality.py 与本文件同级);回退宿主 eval/internal/ppt/layout
if not (HERE / "prompts.py").exists():
    LAYOUT_DIR = Path("/volume/posttrain/users/tnan/work/pro_tasks/eval/internal/ppt/layout")
    if LAYOUT_DIR.is_dir():
        sys.path.insert(0, str(LAYOUT_DIR))

import prompts as layout_prompts  # noqa: E402  10 维 layout prompt(现成,禁改)
from aggregate_quality import page_score_soft  # noqa: E402  SOFT 分级罚分(现成)
from render_deck import render_deck  # noqa: E402

SIDECAR = os.environ.get("SIDECAR_BASE_URL", "http://llm-sidecar.iquest-inner.com:8000")
ENDPOINT = SIDECAR.rstrip("/") + "/v1/chat/completions"
MODEL = os.environ.get("PPT_JUDGE_MODEL", "gemini-3.5-flash")
KEY_FILE = os.path.expanduser("~/.claude/tools/.iquest.key")
DIMS = layout_prompts.DIMS  # 10 维

# ---- 美学维 prompt(逐页,与 layout 同一次调用) ----
AESTHETIC_INSTR = """此外,请对本页的【排版美学】打分(0-10 整数,10=现代专业):
判断维度:配色是否协调现代、字体层次是否清晰、留白是否得当、整体是否有设计感。
🔴 惩罚陈旧/老式审美(给低分):Word 默认模板观感、老式 ClipArt 剪贴画、劣质渐变/立体阴影/斜面、
艺术字(WordArt)、文字挤满页面无留白、上世纪商务 PPT 观感、廉价配色。
纯色背景+清晰标题正文的极简页是可以的(不算陈旧)。"""

# ---- 遵循维 prompt(整体,对 gold 清单) ----
COMPLIANCE_SYS = """你是 PPT 交付质量审核员。给你一份演示文稿的全部页面图 + 一份"要求清单(gold)"。
判断这份 PPT 对清单的满足程度。只依据你在图中实际看到的内容,不脑补。对每一类要求给命中比例。"""


def load_key() -> str:
    env = os.environ.get("IQUEST_API_KEY")
    if env:
        return env.strip()
    return Path(KEY_FILE).read_text().strip()


def _img_b64(path: str) -> str:
    with open(path, "rb") as f:
        return "data:image/png;base64," + base64.b64encode(f.read()).decode()


def _call(messages: list, key: str, max_tokens: int = 1500, timeout: int = 180) -> str:
    body = json.dumps({"model": MODEL, "temperature": 0, "max_tokens": max_tokens,
                       "messages": messages}).encode()
    req = urllib.request.Request(ENDPOINT, data=body, method="POST", headers={
        "Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read())
    return d["choices"][0]["message"]["content"]


def _parse_json(s: str) -> dict:
    s = s.strip()
    if "```" in s:
        s = s.split("```")[1].lstrip("json").strip() if "```json" in s else s.split("```")[1].strip()
    i, j = s.find("{"), s.rfind("}")
    return json.loads(s[i:j+1]) if i >= 0 else {}


def judge_page(png: str, key: str) -> dict:
    """一次调用出该页 10 维 layout severity + 美学分。"""
    user = [
        {"type": "text", "text": layout_prompts.SYSTEM_PROMPT + "\n\n" + AESTHETIC_INSTR
         + '\n\n输出 JSON:{"' + '":0,"'.join(DIMS) + '":0, "aesthetic":0-10, "reason":"一句话"}'},
        {"type": "image_url", "image_url": {"url": _img_b64(png), "detail": "auto"}},
    ]
    try:
        out = _parse_json(_call([{"role": "user", "content": user}], key))
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:120], "aesthetic": None}
    return out


def judge_compliance(pngs: list[str], gold: dict, key: str) -> dict:
    """整体一次调用:对 gold 清单判命中。"""
    checklist = {
        "required_numbers": {k: f"{v['value']}{v.get('unit','')}({v.get('kind','')})"
                             for k, v in gold.get("required_numbers", {}).items()},
        "structure_constraints": gold.get("structure_constraints", {}),
        "key_points_coverage": gold.get("key_points_coverage", []),
        "grounding": gold.get("grounding", {}),
    }
    txt = (f"主题:{gold.get('topic','')}\n\n要求清单(gold):\n"
           + json.dumps(checklist, ensure_ascii=False, indent=1)
           + '\n\n请判断这份 PPT(下附全部页面)对上述清单的满足度,输出 JSON:\n'
           '{"required_numbers_hit_rate":0-1, "structure_hit_rate":0-1, '
           '"key_points_coverage_rate":0-1, "grounding_ok":0-1, '
           '"compliance":0-1(综合遵循度), "reason":"简述哪些满足/缺失"}')
    content = [{"type": "text", "text": txt}]
    for p in pngs[:20]:  # 上限 20 页防超长
        content.append({"type": "image_url", "image_url": {"url": _img_b64(p), "detail": "low"}})
    try:
        return _parse_json(_call([{"role": "system", "content": COMPLIANCE_SYS},
                                  {"role": "user", "content": content}], key, max_tokens=1200))
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)[:120], "compliance": None}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--deck", required=True)
    ap.add_argument("--gold", required=True)
    ap.add_argument("--out", default=None)
    ap.add_argument("--render-dir", default=None)
    args = ap.parse_args()

    gold = json.loads(Path(args.gold).read_text(encoding="utf-8"))
    w = gold.get("score_weights", {"layout_soft": 0.5, "aesthetic": 0.2, "compliance": 0.3})
    key = load_key()

    rdir = args.render_dir or (Path(args.deck).parent / "_pages")
    rres = render_deck(args.deck, str(rdir))
    if not rres["ok"] or not rres["pages"]:
        print(json.dumps({"error": "render_failed", "render": rres}, ensure_ascii=False))
        return 1
    pngs = rres["pages"]

    # 逐页:layout 10 维 + 美学
    page_soft, page_aes = [], []
    per_page = []
    for png in pngs:
        j = judge_page(png, key)
        dims = {k: int(j.get(k, 0) or 0) for k in DIMS}
        soft = page_score_soft(dims) / 100.0        # 0-1(越高越好)
        aes = j.get("aesthetic")
        aes = (float(aes) / 10.0) if aes is not None else None
        page_soft.append(soft)
        if aes is not None:
            page_aes.append(aes)
        per_page.append({"page": os.path.basename(png), "layout_soft": round(soft, 3),
                         "aesthetic": aes, "dims": {k: v for k, v in dims.items() if v}})

    layout_soft = sum(page_soft) / len(page_soft) if page_soft else 0.0
    aesthetic = sum(page_aes) / len(page_aes) if page_aes else 0.0

    # 整体:遵循 gold 清单
    comp = judge_compliance(pngs, gold, key)
    compliance = float(comp.get("compliance") or 0.0)

    total = w["layout_soft"] * layout_soft + w["aesthetic"] * aesthetic + w["compliance"] * compliance
    result = {
        "qid": gold.get("qid"), "deck": os.path.basename(args.deck), "n_pages": len(pngs),
        "total": round(total, 4),
        "parts": {"layout_soft": round(layout_soft, 4), "aesthetic": round(aesthetic, 4),
                  "compliance": round(compliance, 4)},
        "weights": w, "compliance_detail": comp, "per_page": per_page,
    }
    print(json.dumps(result, ensure_ascii=False, indent=1))
    if args.out:
        Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
