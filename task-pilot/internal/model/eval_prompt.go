package model

import (
	"time"

	"gorm.io/gorm"
)

// EvalPrompt 用户自定义的评测 prompt。评测阶段用它指导评测 LLM 逐条判定校验点。
// EvalRun 创建时会选定一个 prompt 并将其内容快照到 run，保证历史结果可复现。
type EvalPrompt struct {
	ID        string         `gorm:"primaryKey;size:64" json:"id"`
	Name      string         `gorm:"uniqueIndex;size:128" json:"name"`
	Content   string         `gorm:"type:text" json:"content"`
	IsDefault bool           `gorm:"index" json:"is_default"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
}
