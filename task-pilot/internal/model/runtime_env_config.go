package model

import (
	"time"

	"gorm.io/gorm"
)

// RuntimeEnvConfig 用户配置的执行时环境变量。启用后会在派发 TestTask/EvalTask 时注入 Pod。
// ValueEnc 为 AES-GCM 加密值；接口按 MaskValue 决定返回明文 Value 或脱敏 ValueMasked。
type RuntimeEnvConfig struct {
	ID          string         `gorm:"primaryKey;size:64" json:"id"`
	ProjectID   string         `gorm:"index;size:64" json:"project_id"`
	Key         string         `gorm:"size:128" json:"key"`
	Description string         `gorm:"type:text" json:"description"`
	ValueEnc    string         `gorm:"type:text" json:"-"`
	Value       string         `gorm:"-" json:"value,omitempty"`
	ValueMasked string         `gorm:"-" json:"value_masked"`
	MaskValue   bool           `gorm:"index" json:"mask_value"`
	Enabled     bool           `gorm:"index" json:"enabled"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"-"`
}
