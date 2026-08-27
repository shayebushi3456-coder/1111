package service

import (
	"encoding/json"
	"fmt"

	"task-pilot/internal/model"
	"task-pilot/internal/util"
	"gorm.io/gorm"
)

// MCPConfigService 管理可复用的 MCP Server 配置（多套），供用例绑定。
type MCPConfigService struct {
	db *gorm.DB
}

func NewMCPConfigService(db *gorm.DB) *MCPConfigService {
	return &MCPConfigService{db: db}
}

// UpsertMCPConfigInput 新增/更新 MCP 配置的输入。
type UpsertMCPConfigInput struct {
	Name        string
	Description string
	// ConfigJSON 单个 MCP server 的配置对象（写入 .mcp.json 的 mcpServers.<Name> 字段），
	// 例如 {"command":"npx","args":["-y","@some/mcp-server"],"env":{"API_KEY":"..."}}。
	ConfigJSON string
}

func validateMCPConfigJSON(raw string) error {
	if raw == "" {
		return fmt.Errorf("config_json is required")
	}
	var v map[string]any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return fmt.Errorf("config_json must be a valid JSON object: %w", err)
	}
	return nil
}

func (s *MCPConfigService) Create(in UpsertMCPConfigInput) (*model.MCPConfig, error) {
	if in.Name == "" {
		return nil, fmt.Errorf("name is required")
	}
	if err := validateMCPConfigJSON(in.ConfigJSON); err != nil {
		return nil, err
	}
	m := &model.MCPConfig{
		ID:          util.NewID("mcp"),
		Name:        in.Name,
		Description: in.Description,
		ConfigJSON:  in.ConfigJSON,
	}
	if err := s.db.Create(m).Error; err != nil {
		return nil, err
	}
	return m, nil
}

func (s *MCPConfigService) Update(id string, in UpsertMCPConfigInput) (*model.MCPConfig, error) {
	m, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if in.Name != "" {
		m.Name = in.Name
	}
	m.Description = in.Description
	if in.ConfigJSON != "" {
		if err := validateMCPConfigJSON(in.ConfigJSON); err != nil {
			return nil, err
		}
		m.ConfigJSON = in.ConfigJSON
	}
	if err := s.db.Save(m).Error; err != nil {
		return nil, err
	}
	return m, nil
}

func (s *MCPConfigService) Get(id string) (*model.MCPConfig, error) {
	var m model.MCPConfig
	if err := s.db.First(&m, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &m, nil
}

func (s *MCPConfigService) List() ([]model.MCPConfig, error) {
	var items []model.MCPConfig
	if err := s.db.Order("created_at desc").Find(&items).Error; err != nil {
		return nil, err
	}
	return items, nil
}

func (s *MCPConfigService) Delete(id string) error {
	return s.db.Delete(&model.MCPConfig{}, "id = ?", id).Error
}

// GetMany 按 ID 批量查询（保持稳定顺序，跳过不存在的 ID），供派发测试任务时解析用例绑定使用。
func (s *MCPConfigService) GetMany(ids []string) ([]model.MCPConfig, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	var items []model.MCPConfig
	if err := s.db.Where("id IN ?", ids).Find(&items).Error; err != nil {
		return nil, err
	}
	byID := make(map[string]model.MCPConfig, len(items))
	for _, it := range items {
		byID[it.ID] = it
	}
	out := make([]model.MCPConfig, 0, len(ids))
	for _, id := range ids {
		if it, ok := byID[id]; ok {
			out = append(out, it)
		}
	}
	return out, nil
}
