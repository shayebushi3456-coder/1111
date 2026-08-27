package model

import (
	"time"

	"gorm.io/gorm"
)

// EnvVar 全局环境变量：用例描述中以 {{KEY}} 引用，派发测试任务时替换为明文 Value。
// Value 加密存储，接口一律脱敏返回。
type EnvVar struct {
	ID          string         `gorm:"primaryKey;size:64" json:"id"`
	Key         string         `gorm:"uniqueIndex;size:128" json:"key"`
	ValueEnc    string         `gorm:"type:text" json:"-"`
	Description string         `gorm:"type:text" json:"description"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"-"`
}
