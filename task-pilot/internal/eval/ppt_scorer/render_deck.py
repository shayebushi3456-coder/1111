#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统一 deck 渲染器:吃 .pptx / .html → 每页 png。造题 testdeck 自检 + 未来判分共用。

两条渲染链:
  - pptx  → python-pptx 解析 + Pillow 逐形状绘制(纯 Python,不依赖 soffice/
            libreoffice/pdftoppm 等系统二进制,只需 pip 包)→ pNNN.png
  - html  → playwright(本地 chromium) 截图 → p001.png(单页) 或按 .slide/section 分页截图

pptx 渲染是"够判分"的近似还原,不追求逐像素还原 PowerPoint 渲染效果:按形状几何
位置绘制矩形/椭圆/线条填充与描边、文本框逐 run 绘制文字(字号/粗体/颜色/对齐)、
表格画网格+逐格文字、图片直接贴对应 blob、图表/其它复杂对象画占位框+类型标签。
对 VLM 视觉评审(overlap/blank/truncate/table_bad/overflow 等排版缺陷)已经足够
判断,同时把渲染依赖从"系统里有没有装 LibreOffice"降到"pip 装两个包"。

用法:
  python3 render_deck.py <deck.pptx|deck.html> <out_dir> [--dpi 110] [--viewport 1280x720]
  # 产 out_dir/p001.png, p002.png, ...;打印 JSON {n_pages, engine, ok}
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from pathlib import Path

EMU_PER_INCH = 914400


def render_pptx(pptx: str, out_dir: str, dpi: int = 110) -> tuple[bool, str, int]:
    """纯 Python 渲染 pptx → 逐页 png。不 fork 任何外部进程。"""
    os.makedirs(out_dir, exist_ok=True)
    try:
        from pptx_render import render_pptx_to_pngs
    except ImportError as e:
        return False, f"pptx_render_import_failed: {e}", 0
    try:
        pages = render_pptx_to_pngs(pptx, out_dir, dpi=dpi)
    except Exception as e:  # noqa: BLE001 任何解析/绘制异常都归一化成结构化失败
        return False, f"pptx_render_failed: {type(e).__name__}: {e}", 0
    if not pages:
        return False, "pptx_render_no_pages: 未产出任何 png", 0
    return True, "ok", len(pages)


_PAGE_SEL = ".slide, section.slide, [data-slide], .reveal .slides section, .page, section"


def _dhash(png_path: str) -> int:
    """9x8 灰度差分感知哈希(64bit),抗动画背景/时间戳抖动,判两截图是否同一页。"""
    from PIL import Image
    im = Image.open(png_path).convert("L").resize((9, 8))
    px = list(im.getdata())
    bits = 0
    for r in range(8):
        for c in range(8):
            bits = (bits << 1) | (1 if px[r * 9 + c] > px[r * 9 + c + 1] else 0)
    return bits


def _ham(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def render_html(html: str, out_dir: str, viewport: str = "1280x720") -> tuple[bool, str, int]:
    """HTML deck → png。策略(兼容三类布局):
      1) 探测分页元素数 n。
      2) 单页翻页式 deck(所有 slide 叠同位置,靠键盘/JS 切页,scrollIntoView 无效)是主流 →
         优先模拟按 → 键翻页,每翻一次截可视区;用 dhash 判断是否真换页(连续 2 次没换 → 停)。
      3) 兜底:n<=1 或按键翻不动 → 截整页 full_page 一张。

    对 playwright/chromium 环境问题(未装 chromium、缺系统库等)一律归一化成结构化
    失败,不让异常裸露到上层——playwright 缺浏览器二进制时并不抛 FileNotFoundError,
    而是 playwright._impl._errors.Error,故不能只靠捕获特定异常类型,直接兜底 Exception。
    """
    os.makedirs(out_dir, exist_ok=True)
    try:
        w, h = (int(x) for x in viewport.lower().split("x"))
    except Exception:
        return False, f"invalid_viewport: {viewport}", 0
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as e:
        return False, f"playwright_not_installed: {e}", 0

    uri = "file://" + os.path.abspath(html)
    pages: list[str] = []
    try:
        with sync_playwright() as p:
            proxy_url = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
            launch_kwargs = {"args": ["--no-sandbox"]}
            try:
                if proxy_url:
                    launch_kwargs["proxy"] = {"server": proxy_url}
                b = p.chromium.launch(**launch_kwargs)
            except Exception as e:
                return False, f"chromium_launch_failed: {e}", 0
            try:
                pg = b.new_page(viewport={"width": w, "height": h})
                try:
                    pg.goto(uri, wait_until="networkidle", timeout=25000)
                except Exception:
                    pg.goto(uri, timeout=25000)
                pg.wait_for_timeout(1800)  # 等 WebGL/字体/首屏动效
                n = int(pg.evaluate("(sel) => document.querySelectorAll(sel).length", _PAGE_SEL) or 0)
                # 关静音动画背景干扰:很多 guizang deck 支持 B 键切静态(low-power),减少每帧抖动
                try:
                    pg.keyboard.press("b")
                    pg.wait_for_timeout(300)
                except Exception:
                    pass

                max_pages = min(max(n, 1), 60) + 2  # 护栏:最多截 n+2 张
                hashes = []
                for i in range(max_pages):
                    out = os.path.join(out_dir, f"p{i+1:03d}.png")
                    pg.screenshot(path=out)  # 截可视区(非 full_page,单页翻页式正确)
                    h_i = _dhash(out)
                    # 若与上一张几乎相同(翻页没生效),回退:删掉这张、停止
                    if hashes and _ham(h_i, hashes[-1]) <= 2:
                        os.remove(out)
                        break
                    hashes.append(h_i)
                    pages.append(out)
                    if i + 1 >= max_pages:
                        break
                    # 翻下一页:多按键覆盖不同 deck 的监听(ArrowRight 最通用)
                    pg.keyboard.press("ArrowRight")
                    pg.wait_for_timeout(800)  # 覆盖 700ms 翻页 lock + 动画

                # 兜底:一张都没有效翻页(单页/滚动式) → full_page 整页一张
                if len(pages) <= 1:
                    for f in pages:
                        try:
                            os.remove(f)
                        except OSError:
                            pass
                    out = os.path.join(out_dir, "p001.png")
                    pg.screenshot(path=out, full_page=True)
                    pages = [out]
            finally:
                b.close()
    except Exception as e:  # noqa: BLE001 兜底任何 playwright/浏览器运行时异常
        return False, f"render_html_failed: {type(e).__name__}: {e}", 0
    if not pages:
        return False, "render_html_no_pages: 未产出任何 png", 0
    return True, "ok", len(pages)


def render_deck(deck: str, out_dir: str, dpi: int = 110, viewport: str = "1280x720"):
    ext = Path(deck).suffix.lower()
    if ext in (".pptx", ".ppt"):
        ok, msg, n = render_pptx(deck, out_dir, dpi)
        engine = "pptx_render"
    elif ext in (".html", ".htm"):
        ok, msg, n = render_html(deck, out_dir, viewport)
        engine = "playwright"
    else:
        return {"ok": False, "engine": None, "n_pages": 0, "msg": f"unsupported ext {ext}"}
    return {"ok": ok, "engine": engine, "n_pages": n, "msg": msg,
            "pages": sorted(glob.glob(os.path.join(out_dir, "p*.png")))}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("deck")
    ap.add_argument("out_dir")
    ap.add_argument("--dpi", type=int, default=110)
    ap.add_argument("--viewport", default="1280x720")
    args = ap.parse_args()
    try:
        res = render_deck(args.deck, args.out_dir, args.dpi, args.viewport)
    except Exception as e:  # noqa: BLE001 保证任何异常都落成合法 JSON,不留裸 traceback
        res = {"ok": False, "engine": None, "n_pages": 0, "msg": f"render_deck_exception: {e}"}
    print(json.dumps(res, ensure_ascii=False))
    return 0 if res["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
