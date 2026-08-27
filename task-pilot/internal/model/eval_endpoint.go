package model

import (
	"time"

	"gorm.io/gorm"
)

// EvalEndpoint 评测模型端点，支持多套。用户可增删改，配置方式与被测端点（TargetEndpoint）一致。
// APIKeyEnc 存储加密后的 api_key，读取时脱敏，绝不明文出接口。
type EvalEndpoint struct {
	ID        string         `gorm:"primaryKey;size:64" json:"id"`
	Name      string         `gorm:"uniqueIndex;size:128" json:"name"`
	BaseURL   string         `gorm:"size:512" json:"base_url"`
	ModelName string         `gorm:"size:128" json:"model_name"`
	APIKeyEnc string         `gorm:"type:text" json:"-"`
	IsDefault bool           `gorm:"index" json:"is_default"`
	CreatedAt time.Time      `json:"created_at"`
	UpdatedAt time.Time      `json:"updated_at"`
	DeletedAt gorm.DeletedAt `gorm:"index" json:"-"`
}
