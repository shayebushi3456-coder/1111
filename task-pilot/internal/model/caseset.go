package model

import (
	"encoding/json"
	"time"

	"gorm.io/gorm"
)

// CaseSet 用例集：一组用例的容器。
type CaseSet struct {
	ID          string         `gorm:"primaryKey;size:64" json:"id"`
	Name        string         `gorm:"size:128" json:"name"`
	Description string         `gorm:"type:text" json:"description"`
	Version     int            `json:"version"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"-"`

	Cases []Case `gorm:"foreignKey:CaseSetID;constraint:OnDelete:CASCADE" json:"cases,omitempty"`
}

// Case 单条用例：任务描述 + 关联文件 + 校验点 + 可选的 MCP/Skill 绑定 + 数据标签。
type Case struct {
	ID           string `gorm:"primaryKey;size:64" json:"id"`
	CaseSetID    string `gorm:"index;size:64" json:"case_set_id"`
	Name         string `gorm:"size:128" json:"name"`
	Description  string `gorm:"type:text" json:"description"`
	FileIDsJSON  string `gorm:"type:text" json:"-"`
	MCPIDsJSON   string `gorm:"type:text" json:"-"`
	SkillIDsJSON string `gorm:"type:text" json:"-"`
	OrderNo      int    `json:"order_no"`
	// 数据标签：一级/二级类型为级联下拉；TaskTypes 可多选（JSON 存于 task_type 列）；Difficulty 手填。
	Level1Type    string   `gorm:"size:128" json:"level1_type"`
	Level2Type    string   `gorm:"size:128" json:"level2_type"`
	TaskTypesJSON string   `gorm:"column:task_type;type:text" json:"-"`
	Difficulty    string   `gorm:"size:64" json:"difficulty"`
	TaskTypes     []string `gorm:"-" json:"task_types"`
	// SkipHTMLVisualScore 跳过该用例测试产物中 HTML 文件的视觉美观度评测（不转图片、不做
	// layout_soft/aesthetic 评审），仅评估任务描述/校验点覆盖等其它维度。零值 false 即为默认
	// 行为：HTML 产物默认转图片走美观度评测，与新增此开关前的既有行为完全一致。
	SkipHTMLVisualScore bool `json:"skip_html_visual_score"`

	Checkpoints []Checkpoint `gorm:"foreignKey:CaseID;constraint:OnDelete:CASCADE" json:"checkpoints,omitempty"`
	FileIDs     []string     `gorm:"-" json:"file_ids"`
	// MCPIDs / SkillIDs 该用例执行测试任务前，需在执行器 Pod 内预先配置好的
	// MCP Server / Skill（引用 model.MCPConfig / model.SkillConfig 的 ID）。
	MCPIDs   []string `gorm:"-" json:"mcp_ids"`
	SkillIDs []string `gorm:"-" json:"skill_ids"`
}

// Checkpoint 校验点：文本描述 + 可选参考文件（如标准答案、评分参考图、规范文档），
// 仅提供给评测 LLM 按需读取，不下发给测试任务——与校验点文本本身的隔离原则一致。
type Checkpoint struct {
	ID          string `gorm:"primaryKey;size:64" json:"id"`
	CaseID      string `gorm:"index;size:64" json:"case_id"`
	OrderNo     int    `json:"order_no"`
	Description string `gorm:"type:text" json:"description"`
	FileIDsJSON string `gorm:"type:text" json:"-"`

	FileIDs []string `gorm:"-" json:"file_ids"`
}

// EncodeFileIDs 将字符串 ID 列表序列化为 JSON 存储。复用于关联文件 / MCP / Skill 三种引用列表，
// 三者存储结构完全一致（[]string 的 JSON 数组），无需各自定义编解码函数。
func EncodeFileIDs(ids []string) string {
	if len(ids) == 0 {
		return ""
	}
	data, err := json.Marshal(ids)
	if err != nil {
		return ""
	}
	return string(data)
}

// DecodeFileIDs 反序列化关联文件 ID 列表。
func DecodeFileIDs(raw string) []string {
	if raw == "" {
		return nil
	}
	var ids []string
	if err := json.Unmarshal([]byte(raw), &ids); err != nil {
		return nil
	}
	return ids
}

// DecodeTaskTypes 反序列化 task 类型多选列表。兼容旧数据：纯文本单值视为仅含一项的数组。
func DecodeTaskTypes(raw string) []string {
	if raw == "" {
		return nil
	}
	var ids []string
	if err := json.Unmarshal([]byte(raw), &ids); err == nil {
		return ids
	}
	return []string{raw}
}
