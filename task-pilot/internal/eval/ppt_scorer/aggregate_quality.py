#!/usr/bin/env python3
"""Aggregate per-generation-model layout quality from a VLM run (goal-10 v1).

Given a scores.jsonl produced by run_eval over the 4 generation models
(opus/siflow/qwen/deepseek), roll up to per-model layout quality:
  * pages, defect-page rate (pages with >=1 hit / pages)
  * defect density (hit dims / page), unweighted and severity-weighted
  * per-dimension hit-page count + rate

This is the "which model lays out best" view (lower = better). It reuses the
same DIMS/SEVERITY/DIM_ZH as score.py.

Usage:
  python aggregate_quality.py --run runs/v1_all4_gemini_flash/scores.jsonl \
      [--json out.json]
"""
from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict

DIMS = ["overlap", "blank", "img_broken", "cjk_broken", "low_contrast",
        "truncate", "glue", "table_bad", "overflow", "align"]
DIM_ZH = {"overlap": "文字重叠", "blank": "空白空洞", "img_broken": "图表空框",
          "cjk_broken": "中文崩坏", "low_contrast": "低对比", "truncate": "文本截断",
          "glue": "编号粘连", "table_bad": "表格错乱", "overflow": "内容溢出",
          "align": "对齐失衡"}
SEVERITY = {"overlap": 3, "img_broken": 3, "cjk_broken": 3,
            "blank": 2, "low_contrast": 2, "table_bad": 2,
            "truncate": 1, "glue": 1, "overflow": 1, "align": 0.5}
MODEL_ORDER = ["opus", "deepseek", "qwen", "siflow",
               # flash-4 bakeoff tags (goal-11); MODEL_FULL needed for legend
               "haiku", "dsflash", "kimi", "gemini_gen"]
# 生成模型简称 -> 全称/代号(pages 目录用简称,报告带全称)
MODEL_FULL = {
    "opus": "claude-opus-4-8-ppio",
    "qwen": "qwen3.7-max-ali",
    "deepseek": "deepseek-v4-pro-ppio-anthropic",
    "siflow": "u30a3tb05think-zhuoguang",
    "haiku": "claude-haiku-4-5-20251001",
    "dsflash": "deepseek-v4-flash-ppio-anthropic",
    "kimi": "kimi-k2.7-code",
    "gemini_gen": "gemini-3.5-flash",
}

# ---- 加权排版分(0-100,越高越好):HARD(一票否决)+ SOFT(严重度分级)双分 ----
# VLM 每维给 0-3 严重度(prompt v4)。dims 值即严重度;二值命中 = 严重度>=1。
#
# 按类别的"容忍 x 个问题":扣到 0 为止,单次(severe=3)扣分 = 100/x。
#   致命 overlap/img_broken/cjk_broken : x=1  → severe 扣 100
#   严重 blank/low_contrast/table_bad   : x=2  → severe 扣 50
#   中等 truncate/glue/overflow         : x=4  → severe 扣 25
#   低   align                          : x=8  → severe 扣 12.5
TOLERANCE_X = {
    "overlap": 1, "img_broken": 1, "cjk_broken": 1,
    "blank": 2, "low_contrast": 2, "table_bad": 2,
    "truncate": 4, "glue": 4, "overflow": 4,
    "align": 8,
}
FATAL_DIMS = {"overlap", "img_broken", "cjk_broken"}  # HARD 一票否决


def _sev(dims: dict, k: str) -> int:
    try:
        return max(0, min(3, int(dims.get(k, 0))))
    except (TypeError, ValueError):
        return 0


def page_score_soft(dims: dict) -> float:
    """SOFT:无瞬间否决。每维按严重度分级扣 = (sev/3)×(100/x),累加,扣到 0。
    致命也走分级(轻微致命扣得少),不直接归零。"""
    penalty = 0.0
    for k in DIMS:
        s = _sev(dims, k)
        if s:
            penalty += (s / 3.0) * (100.0 / TOLERANCE_X[k])
    return max(0.0, 100.0 - penalty)


def page_score_hard(dims: dict) -> float:
    """HARD:任一致命维度命中(sev>=1)→ 该页 0 分(一票否决)。
    否则非致命维度按严重度分级扣(同 soft 公式),扣到 0。"""
    if any(_sev(dims, k) >= 1 for k in FATAL_DIMS):
        return 0.0
    penalty = 0.0
    for k in DIMS:
        if k in FATAL_DIMS:
            continue
        s = _sev(dims, k)
        if s:
            penalty += (s / 3.0) * (100.0 / TOLERANCE_X[k])
    return max(0.0, 100.0 - penalty)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--json", default=None)
    ap.add_argument("--expected", type=int, default=None,
                    help="每模型期望的 deck(题)数。启用后:未产出的 deck 计 HARD/SOFT=0 "
                         "并入模型均分(deck 级),并输出产出率/缺失数列。"
                         "口径:跑满未产出=真实负样本(能力性失败),不做幸存者偏差豁免。")
    args = ap.parse_args(argv)

    pages = defaultdict(int)          # model -> n pages scored
    defect_pages = defaultdict(int)   # model -> pages with >=1 hit
    hits = defaultdict(int)           # model -> total dim hits
    whits = defaultdict(int)          # model -> severity-weighted hits
    dim_pages = defaultdict(lambda: Counter())  # model -> {dim: pages hit}
    decks = defaultdict(set)          # model -> set(qid)
    parse_err = defaultdict(int)
    soft_sum = defaultdict(float)     # model -> Σ page_score_soft (页级)
    hard_sum = defaultdict(float)     # model -> Σ page_score_hard (页级)
    # deck 级:(model,qid) -> [页 hard], [页 soft];用于 deck 分 = 该 deck 页均
    deck_hard = defaultdict(list)
    deck_soft = defaultdict(list)

    for line in open(args.run):
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        m = r["model"]
        if r.get("dims") is None:
            parse_err[m] += 1
            continue
        pages[m] += 1
        decks[m].add(r["qid"])
        d = r["dims"]
        h = sum(1 for k in DIMS if _sev(d, k) >= 1)  # 二值命中数
        hits[m] += h
        whits[m] += sum(SEVERITY[k] for k in DIMS if _sev(d, k) >= 1)
        ph, ps = page_score_hard(d), page_score_soft(d)
        soft_sum[m] += ps
        hard_sum[m] += ph
        deck_hard[(m, r["qid"])].append(ph)
        deck_soft[(m, r["qid"])].append(ps)
        if h > 0:
            defect_pages[m] += 1
        for k in DIMS:
            if _sev(d, k) >= 1:
                dim_pages[m][k] += 1

    # deck 级模型分:每 deck 先取页均,模型分 = deck 分的平均。
    # 若 --expected 给定:分母用 expected(未产出的 deck 计 0),即"跑满未产出=负样本"。
    deck_model_hard = defaultdict(list)  # model -> [deck 分]
    deck_model_soft = defaultdict(list)
    for (m, q), vs in deck_hard.items():
        deck_model_hard[m].append(sum(vs) / len(vs))
    for (m, q), vs in deck_soft.items():
        deck_model_soft[m].append(sum(vs) / len(vs))

    out = {}
    exp = args.expected
    hdr = (f"{'model':<10}{'decks':>6}{'pages':>7}{'defect_pg%':>11}"
           f"{'HARD分':>9}{'SOFT分':>9}{'density':>9}{'parse_err':>10}")
    if exp:
        hdr += f"{'产出':>8}{'缺失':>6}{'HARD*':>8}{'SOFT*':>8}"
    print(hdr)
    for m in MODEL_ORDER:
        if not pages[m]:
            continue
        p = pages[m]
        dpr = defect_pages[m] / p
        dens = hits[m] / p
        wdens = whits[m] / p
        hard = hard_sum[m] / p   # HARD 分(页均,仅产出物)
        soft = soft_sum[m] / p   # SOFT 分(页均,仅产出物)
        rec = {
            "decks": len(decks[m]), "pages": p,
            "defect_page_rate": round(dpr, 4),
            "defect_density": round(dens, 4),
            "weighted_density": round(wdens, 4),
            "layout_score_hard": round(hard, 2),          # 仅产出物(幸存者口径)
            "layout_score_soft": round(soft, 2),
            "parse_errors": parse_err[m],
            "dim_hit_pages": dict(dim_pages[m]),
        }
        line = (f"{m:<10}{len(decks[m]):>6}{p:>7}{dpr*100:>10.1f}%"
                f"{hard:>9.1f}{soft:>9.1f}{dens:>9.3f}{parse_err[m]:>10}")
        if exp:
            n_prod = len(decks[m])                        # 已产出 deck 数
            n_miss = max(0, exp - n_prod)                 # 未产出(计0负样本)
            # deck 级含缺失总分:Σ已产出deck分 / expected(缺失贡献0)
            hard_full = sum(deck_model_hard[m]) / exp
            soft_full = sum(deck_model_soft[m]) / exp
            rec.update({
                "expected_decks": exp, "produced_decks": n_prod,
                "missing_decks": n_miss,
                "produce_rate": round(n_prod / exp, 4),
                "layout_score_hard_full": round(hard_full, 2),  # 含缺失记0(公允口径)
                "layout_score_soft_full": round(soft_full, 2),
            })
            line += (f"{n_prod}/{exp}".rjust(8) + f"{n_miss:>6}"
                     + f"{hard_full:>8.1f}{soft_full:>8.1f}")
        out[m] = rec
        print(line)
    # 代号图例
    print("代号: " + " / ".join(f"{m}={MODEL_FULL[m]}"
                                for m in MODEL_ORDER if pages[m]))
    if exp:
        print("HARD分/SOFT分 = 仅产出物页均(幸存者口径);HARD*/SOFT* = 含未产出deck计0的公允总分"
              "(缺失=期望-产出,能力性负样本)。")

    # per-dimension hit-page rate table (per model)
    print(f"\n{'dim/维度':<22}" + "".join(f"{m:>10}" for m in MODEL_ORDER if pages[m]))
    for k in DIMS:
        label = f"{k}({DIM_ZH[k]})"
        row = f"{label:<20}"
        for m in MODEL_ORDER:
            if not pages[m]:
                continue
            n = dim_pages[m][k]
            row += f"{n:>4}({n/pages[m]*100:>3.0f}%)".rjust(10)
        print(row)

    if args.json:
        with open(args.json, "w") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        print(f"\n[out] {args.json}")


if __name__ == "__main__":
    main()
