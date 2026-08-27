package model

import (
	"encoding/json"
	"time"

	"gorm.io/gorm"
)

// SkillConfig 一份可复用的 Claude Code Skill 定义，供用例绑定。
// 落地时会在执行器容器内还原为 ~/.claude/skills/<Name>/ 目录：
//   SKILL.md 写入 ContentMD，ExtraFilesJSON 中的每个 相对路径→文本内容 写入同名子文件
//   （例如 "references/api.md"、"scripts/run.py"），用于承载 SKILL.md 之外的参考资料/脚本。
// 仅支持文本内容（不支持二进制资产），满足当前 Skill 编排需求即可，避免引入额外的文件存储依赖。
type SkillConfig struct {
	ID             string         `gorm:"primaryKey;size:64" json:"id"`
	Name           string         `gorm:"uniqueIndex;size:128" json:"name"`
	Description    string         `gorm:"type:text" json:"description"`
	ContentMD      string         `gorm:"type:text" json:"content_md"`
	ExtraFilesJSON string         `gorm:"type:text" json:"-"`
	CreatedAt      time.Time      `json:"created_at"`
	UpdatedAt      time.Time      `json:"updated_at"`
	DeletedAt      gorm.DeletedAt `gorm:"index" json:"-"`
}

// EncodeExtraFiles 序列化 Skill 附加文件（相对路径 → 文本内容）。
func EncodeExtraFiles(files map[string]string) string {
	if len(files) == 0 {
		return ""
	}
	data, err := json.Marshal(files)
	if err != nil {
		return ""
	}
	return string(data)
}

// DecodeExtraFiles 反序列化 Skill 附加文件。
func DecodeExtraFiles(raw string) map[string]string {
	if raw == "" {
		return nil
	}
	var files map[string]string
	if err := json.Unmarshal([]byte(raw), &files); err != nil {
		return nil
	}
	return files
}
