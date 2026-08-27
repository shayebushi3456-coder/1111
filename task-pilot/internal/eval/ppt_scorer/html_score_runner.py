#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Render HTML deck artifacts for Claude-Code based visual review inside EvalTask.

与 ppt_score_runner.py 完全同构:PPT 用 render_deck.py 里的 render_pptx(纯
python-pptx+Pillow),HTML 用同一个 render_deck.py 里的 render_html(playwright)。
两者的评审方式与标准保持一致——都是先转逐页 PNG,再交给评测 Claude 用 Read 工具
逐页读图评审,而不是消费预先计算的分数。

Inputs are expected under $WORKSPACE:
- tmp/artifacts/**/{*.html,*.htm}
- tmp/ppt_scorer/render_deck.py

Outputs packaged with EvalTask artifact:
- output/html_render_pages/<deck_id>/p001.png ...
- output/html_review/html_render_manifest.json

Prompt bridge:
- tmp/html_render_summary.txt lists page paths that the final grading Claude
  should read with its image-capable Read tool.
"""
from __future__ import annotations

import glob
import json
import os
import pathlib
import re
import shutil
import subprocess
from typing import Any


def safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_") or "deck"


def write_json(path: pathlib.Path, rec: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")


def main() -> int:
    ws = pathlib.Path(os.environ.get("WORKSPACE", ""))
    scorer_dir = ws / "tmp" / "ppt_scorer"
    render_script = scorer_dir / "render_deck.py"
    tmp_pages_root = ws / "tmp" / "html_pages"
    out_pages_root = ws / "output" / "html_render_pages"
    review_dir = ws / "output" / "html_review"
    tmp_pages_root.mkdir(parents=True, exist_ok=True)
    out_pages_root.mkdir(parents=True, exist_ok=True)
    review_dir.mkdir(parents=True, exist_ok=True)

    decks = sorted(
        glob.glob(str(ws / "tmp" / "artifacts" / "**" / "*.html"), recursive=True)
        + glob.glob(str(ws / "tmp" / "artifacts" / "**" / "*.htm"), recursive=True)
    )

    manifest: dict[str, Any] = {"decks": []}
    if decks and not render_script.exists():
        manifest["decks"].append({
            "status": "FAILED",
            "error": "html_renderer_missing",
            "detail": "render_deck.py not found in eval input files",
        })
    else:
        for idx, deck in enumerate(decks, 1):
            base = os.path.basename(deck)
            deck_id = f"html_{idx:03d}_{safe_name(base)}"
            tmp_pages = tmp_pages_root / deck_id
            out_pages = out_pages_root / deck_id
            tmp_pages.mkdir(parents=True, exist_ok=True)
            out_pages.mkdir(parents=True, exist_ok=True)
            rec: dict[str, Any] = {
                "deck": base,
                "deck_path": deck,
                "deck_id": deck_id,
                "status": "PENDING",
                "pages": [],
            }
            try:
                proc = subprocess.run(
                    ["python3", str(render_script), deck, str(tmp_pages), "--viewport", "1280x720"],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=360,
                )
                rec["renderer_stdout"] = proc.stdout[-4000:]
                rec["renderer_stderr"] = proc.stderr[-4000:]
                if proc.returncode != 0:
                    rec.update({"status": "FAILED", "error": "html_render_failed", "detail": proc.stderr[-2000:] or proc.stdout[-2000:]})
                    manifest["decks"].append(rec)
                    continue

                render_result = {}
                try:
                    render_result = json.loads(proc.stdout.strip().splitlines()[-1])
                except Exception:
                    render_result = {"ok": False, "msg": "render_deck stdout is not JSON", "raw_stdout": proc.stdout[-1000:]}
                rec["render_result"] = render_result
                if not render_result.get("ok"):
                    rec.update({"status": "FAILED", "error": "html_render_failed", "detail": render_result.get("msg", "render failed")})
                    manifest["decks"].append(rec)
                    continue

                page_paths = sorted(glob.glob(str(tmp_pages / "p*.png")))
                for page_no, page in enumerate(page_paths, 1):
                    src = pathlib.Path(page)
                    dst = out_pages / src.name
                    shutil.copy2(src, dst)
                    rec["pages"].append({
                        "page_no": page_no,
                        "filename": src.name,
                        "workspace_path": str(dst),
                        "artifact_path": str(pathlib.Path("html_render_pages") / deck_id / src.name),
                    })
                rec["n_pages"] = len(rec["pages"])
                rec["status"] = "SUCCEEDED" if rec["pages"] else "FAILED"
                if not rec["pages"]:
                    rec["error"] = "html_render_no_pages"
                    rec["detail"] = "render_deck succeeded but no p*.png pages were found"
                manifest["decks"].append(rec)
            except Exception as e:  # noqa: BLE001
                rec.update({"status": "FAILED", "error": "html_render_exception", "detail": str(e)})
                manifest["decks"].append(rec)

    manifest_path = review_dir / "html_render_manifest.json"
    write_json(manifest_path, manifest)

    summary_path = ws / "tmp" / "html_render_summary.txt"
    with summary_path.open("w", encoding="utf-8") as f:
        if not decks:
            f.write("未检测到 HTML 产物，HTML 逐页图片评审不适用。\n")
        else:
            f.write("检测到 HTML 产物，已将其转换为逐页 PNG，并打包到 output/html_render_pages/。\n")
            f.write(f"渲染清单 JSON：{manifest_path}\n")
            for deck in manifest["decks"]:
                name = deck.get("deck", "unknown")
                if deck.get("status") != "SUCCEEDED":
                    f.write(f"- {name}: 渲染失败，error={deck.get('error')}; detail={deck.get('detail', '')}\n")
                    continue
                f.write(f"- {name}: {deck.get('n_pages', 0)} 页。评分 Claude 必须逐页读取以下图片后再评价：\n")
                for page in deck.get("pages", []):
                    f.write(f"  - 第 {page.get('page_no')} 页: {page.get('workspace_path')}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
