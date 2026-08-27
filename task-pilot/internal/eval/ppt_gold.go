package eval

import (
	"encoding/json"
)

// PPTGoldReference is the gold checklist consumed by the bundled PPT scorer.
// It mirrors ppt_eval_standard_20260807/scorer/score_ppt_v2.py expectations.
type PPTGoldReference struct {
	QID                  string                 `json:"qid"`
	Topic                string                 `json:"topic"`
	ScoreWeights         map[string]float64      `json:"score_weights"`
	RequiredNumbers      map[string]any          `json:"required_numbers"`
	StructureConstraints map[string]any          `json:"structure_constraints"`
	KeyPointsCoverage    []string               `json:"key_points_coverage"`
	Grounding            map[string]any          `json:"grounding"`
}

// BuildPPTGoldReferenceJSON builds a minimal gold_reference.json from the
// existing CaseSet schema. The current product model has free-text checkpoints
// rather than the full PPT scorer checklist, so v1 maps checkpoints to
// key_points_coverage and keeps the scorer's default linear weights.
func BuildPPTGoldReferenceJSON(qid, topic string, checkpoints []string) (string, error) {
	ref := PPTGoldReference{
		QID:   qid,
		Topic: topic,
		ScoreWeights: map[string]float64{
			"layout_soft": 0.5,
			"aesthetic":   0.2,
			"compliance":  0.3,
		},
		RequiredNumbers:      map[string]any{},
		StructureConstraints: map[string]any{},
		KeyPointsCoverage:    checkpoints,
		Grounding: map[string]any{
			"must_be_from_materials": true,
			"forbidden_behavior": []string{
				"不得编造关键数字或事实",
				"不得遗漏任务描述和校验点中的核心要求",
			},
		},
	}
	data, err := json.Marshal(ref)
	if err != nil {
		return "", err
	}
	return string(data), nil
}
