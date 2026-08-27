package model

import (
	"time"

	"gorm.io/gorm"
)

// MCPConfig 一套可复用的 MCP Server 配置，供用例绑定。
// ConfigJSON 是单个 MCP server 的配置对象（写入 .mcp.json 的 mcpServers.<Name> 字段），
// 例如 {"command":"npx","args":["-y","@some/mcp-server"],"env":{"API_KEY":"..."}}。
// 内容原样落库，不做结构校验（不同 MCP server 的字段差异很大），仅要求是合法 JSON 对象。
type MCPConfig struct {
	ID          string         `gorm:"primaryKey;size:64" json:"id"`
	Name        string         `gorm:"uniqueIndex;size:128" json:"name"`
	Description string         `gorm:"type:text" json:"description"`
	ConfigJSON  string         `gorm:"type:text" json:"config_json"`
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"-"`
}
