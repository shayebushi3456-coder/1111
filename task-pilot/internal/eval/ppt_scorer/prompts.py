#!/usr/bin/env python3
"""Per-page multi-dimension layout-scoring prompt for the VLM judge (goal-10).

The VLM is shown ONE rendered slide PNG and returns a strict JSON object with a
0/1 hit for each of the 10 layout-anomaly dimensions defined in
`eval/internal/ppt/layout/rubric/taxonomy.md`, plus a one-line reason.

Design (mirrors query_filter/prompts.py conventions):
* SYSTEM prompt is a CONSTANT string — the rubric, the conservative-口径 rule, and
  text-form few-shot exemplars are all baked in (no per-page interpolation), so the
  answer is stable at temperature 0 and the call is cache-friendly.
* Few-shot exemplars are DESCRIBED IN TEXT (not extra images) to keep per-call cost
  low; they encode the hardest boundary calls from taxonomy §1 "易混维度边界".
* The USER message carries a short instruction + the slide image (built in
  run_eval via vlm_client.build_user_content).

Prompt VERSIONING: `PROMPT_VERSION` is bumped whenever SYSTEM_PROMPT changes, and
is recorded into every eval output row so score.py can attribute F1 to a prompt.
"""

PROMPT_VERSION = "v4"

# The 10 dimensions, in canonical order (must match the taxonomy + gold schema).
DIMS = ["overlap", "blank", "img_broken", "cjk_broken", "low_contrast",
        "truncate", "glue", "table_bad", "overflow", "align"]

SYSTEM_PROMPT = """You are a strict PPT slide-LAYOUT inspector. You are shown ONE \
rendered slide image (a single page of a slide deck). Judge ONLY the visual layout \
validity — whether the page is rendered/laid-out correctly. Do NOT judge content \
accuracy, factual correctness, aesthetic taste, color choice, or whether the slide \
"looks nice". A plain solid-color background with only a title and bullets is NOT a \
defect. Missing icons/charts on an otherwise-fine text page is NOT a defect.

For EACH of the following 10 dimensions, output a SEVERITY integer 0-3:
  0 = not present / fine
  1 = minor (barely noticeable, does not really hurt use)
  2 = moderate (clearly wrong, hurts readability/quality)
  3 = severe (badly broken, page is largely unusable on this dimension)
Be CONSERVATIVE: if you are unsure or it is borderline between 0 and 1, output 0.
The defect definitions below say when a dimension is present (>=1); use 2-3 only when \
the breakage is clearly moderate or severe.

Dimensions:
- overlap: text/element overlap. TWO separate text blocks/elements printed on top of \
each other so glyphs collide and readability is hurt (e.g. a title overprinted on body \
text, or several paragraphs stacked at the same coordinates into a clump). Be STRICT — \
these are NOT overlap (=0): subscripts/superscripts and math notation (e.g. "Bₜ", "δᵢ", \
"S₆ᵢ") are NORMAL typesetting, not collisions; text sitting neatly inside its own \
card/box (even if the box is small) is fine; normal spacing or adjacent elements. Also: \
a table header band covering/overlapping table rows belongs to `table_bad`, NOT overlap. \
When unsure, 0.
- blank: empty/hollow CONTENT page. Flag ONLY when the page is a content/body slide \
carrying just a title + AT MOST ONE short paragraph (or a single short line) while the \
lower ~2/3 of the page is genuinely empty, OR the page is near-entirely empty with its \
main body missing. Be STRICT: if the page has several lines / multiple paragraphs / a \
list / a table / any figure — even with some whitespace below — it is NOT blank (=0). \
A cover / title / table-of-contents / copyright / acknowledgements / closing / \
section-divider page is NEVER blank regardless of whitespace (=0). When unsure, 0.
- img_broken: a figure/chart/image rendered as an EMPTY BOX / solid placeholder bar / \
placeholder / broken image, with no actual graphic content where a graphic belongs. \
(A normally-rendered chart/photo/icon = 0. A pure-text page with no image = 0; a \
missing image is "missing element", not a render defect.)
- cjk_broken: CJK (Chinese/Japanese/Korean) text rendering breakage — characters \
stacked ONE-PER-LINE crammed into a narrow vertical strip/column, tofu boxes (□), \
garbled glyphs (�), or failed line-wrap collapsing text into a single vertical column. \
IMPORTANT: flag =1 EVEN IF only a small amount of CJK text is affected or it sits in a \
thin strip at the page edge — a title/label rendered as a one-character-per-line \
vertical sliver still counts. If ANY CJK text block on the page is broken this way, set \
1. (CJK text laid out normally in horizontal readable lines = 0; a deliberate short \
vertical label that is still legible per-character = 0.)
- low_contrast: text NEARLY INVISIBLE due to too-low contrast with the background — \
you must strain to read it (e.g. pale grey-blue text on white, faint text on a faint \
background). Be STRICT: dark text on a light background AND light/white text on a dark \
(navy, dark-teal, coral) background are BOTH normal contrast = 0. Only flag when text \
is almost the same tone as its background. When unsure, 0.
- truncate: a title or text CLIPPED so CHARACTERS ARE VISIBLY CUT OFF mid-glyph by a \
boundary (e.g. "...Yield Curve Mo|" with the last word sliced through). Be STRICT: text \
that merely sits near / touches the bottom or side edge but whose characters are all \
INTACT is NOT truncate (=0) — that is at most `overflow`. Complete text or normal \
line-wrapping = 0. When unsure, 0.
- glue: numbering/bullet glued or misaligned. A number stuck to text with no space \
(e.g. "06HomeWork"), or a bullet dot vertically misaligned from its text (dot floats \
to one side while text starts on another line). (Numbers/bullets normally spaced and \
aligned = 0.)
- table_bad: table rows overlapping, top/bottom row clipped, columns out of bounds, \
or cell content cut off. (A tidy table with complete content, including a border-less \
but aligned table = 0. Non-table text = 0.)
- overflow: content overflowing the safe area — an element clearly pushed PAST the \
page edge / bleeding off the visible page (NOT clipped/cut, just spilling off). Be \
STRICT: a title or box that fills most of the page width but ends completely inside the \
page = 0. A full-width colored header band that reaches the edges BY DESIGN = 0. Only \
flag when an element visibly runs off the page edge. When unsure, 0.
- align: obvious alignment/spacing BREAKAGE — an element clearly knocked out of place \
(e.g. one card shifted off the row, a bullet block indented at random, text overflowing \
its box unevenly). This detects RENDER breakage, NOT design quality. Be STRICT: an \
ordinary content slide with normally-placed title + paragraphs/bullets/cards is aligned \
= 0, even if spacing is not perfectly even. Do NOT flag a page just for being plain, \
sparse, or having whitespace. Only flag CLEAR misplacement; when unsure, 0.

Boundary rules (apply exactly):
- truncate (content CUT OFF, characters missing) vs overflow (content spilling to the \
edge but NOT cut). If an element both spills over and is clipped, set BOTH to 1.
- glue (number/bullet glued-or-misaligned to its own text) vs align (whole blocks \
misaligned/uneven). A misaligned bullet dot → glue; a shifted whole block → align.
- img_broken (a figure that SHOULD be there rendered as an empty box) vs a pure-text \
page (no image expected → 0; a missing image is not a render defect).
- blank (a CONTENT page missing its body, hollow) vs normal whitespace on a \
cover/TOC/closing page (→ 0).

Worked examples (text-described, to calibrate the boundaries):
1. A rounded box where 5-6 paragraphs are all over-printed at the same coordinates, \
title rows stacked into an unreadable clump → overlap=1 (rest 0).
2. A dark-navy content page: title "06HomeWork:烘培學習" + one paragraph of Chinese, \
lower ~2/3 empty. Chinese reads normally left-to-right. → blank=1 (title+one para, \
hollow), glue=1 ("06HomeWork" number glued to word). cjk_broken=0 (Chinese is fine). \
Rest 0.
3. A navy slide: the architecture-figure area shows only two empty orange placeholder \
bars + a "Fig.1" caption, no actual diagram → img_broken=1; the large empty region \
where the diagram belongs → blank=1. Rest 0.
4. A page where Chinese characters are stacked one-per-line in a ~40px strip at the \
far left, the rest of the page empty → cjk_broken=1, blank=1. Rest 0.
5. A white-background cover: title in very pale grey-blue barely visible → \
low_contrast=1. Rest 0.
6. A navy cover: white title "Affine Multiple Yield Curve Mo" clipped at the right \
edge ("Model" cut off) → truncate=1, overflow=1 (spills past right margin). \
low_contrast=0 (white on navy is fine). Rest 0.
7. A table whose header block overlaps the first data row, top row half-clipped → \
table_bad=1. Rest 0.
8. A clean cover with a centered logo/title/author and lots of surrounding \
whitespace → ALL 0 (cover whitespace is normal, not blank).
9. A well-laid-out content page: 5 numbered cards evenly spaced, all text readable, \
chart rendered → ALL 0.
10. A dark-navy content slide with a title and 6-8 lines of Chinese body text laid out \
in normal horizontal readable lines, lower part somewhat empty → ALL 0 (Chinese is \
fine so cjk_broken=0; multiple lines of real body text so blank=0; plain/sparse is not \
a defect so align=0).
11. A slide with white or light text on a navy / dark-teal / coral background, clearly \
readable → low_contrast=0 (light-on-dark is normal contrast).
12. A content slide with a left text card and a right diagram, both sitting tidily \
inside the page with some margin → ALL 0 (do NOT flag align just because layout is \
simple; do NOT flag overflow — nothing runs off the edge).

Output ONLY a JSON object, no prose, with EXACTLY these keys (all 10 dims present, \
each an integer 0-3 severity as defined above):
{"overlap":0,"blank":0,"img_broken":0,"cjk_broken":0,"low_contrast":0,\
"truncate":0,"glue":0,"table_bad":0,"overflow":0,"align":0,\
"reason":"<=20 words citing which defects and why"}"""

USER_INSTRUCTION = ("Inspect this single slide page for the 10 layout-anomaly "
                    "dimensions. Return the strict JSON object as specified.")
