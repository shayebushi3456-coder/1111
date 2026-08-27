package eval

import "embed"

// PPT/HTML scorer bundle copied from ppt_eval_standard_20260807 (+ pptx_render.py
// 纯 Python 渲染实现 + html_score_runner.py HTML 渲染入口 + NotoSansSC-Regular.otf
// 内置 CJK 字体). Keep these files colocated when sending to EvalTask so
// score_ppt_v2.py / render_deck.py can import their helpers (pptx_render.py 是
// render_deck.py 渲染 pptx 时的同目录 import 依赖，缺了会在评测 Job 里
// ImportError；NotoSansSC-Regular.otf 缺失时 pptx_render.py 退化为 Pillow 默认
// 字体，中文文本会渲染成方框/缺字)。
//
//go:embed ppt_scorer/score_ppt_v2.py ppt_scorer/render_deck.py ppt_scorer/pptx_render.py ppt_scorer/prompts.py ppt_scorer/aggregate_quality.py ppt_scorer/ppt_score_runner.py ppt_scorer/html_score_runner.py ppt_scorer/NotoSansSC-Regular.otf
var pptScorerFS embed.FS

var PPTScorerFilenames = []string{
	"score_ppt_v2.py",
	"render_deck.py",
	"pptx_render.py",
	"prompts.py",
	"aggregate_quality.py",
	"ppt_score_runner.py",
	"html_score_runner.py",
	"NotoSansSC-Regular.otf",
}

func ReadPPTScorerFile(name string) ([]byte, error) {
	return pptScorerFS.ReadFile("ppt_scorer/" + name)
}
