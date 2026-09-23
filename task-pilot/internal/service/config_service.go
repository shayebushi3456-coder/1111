package service

import (
	"errors"
	"fmt"

	"task-pilot/internal/config"
	"task-pilot/internal/model"
	"task-pilot/internal/util"
	"gorm.io/gorm"
)

// ConfigService 管理被测模型端点（多套）。api_key 加密存储、脱敏读取。
type ConfigService struct {
	db     *gorm.DB
	secret string
}

func NewConfigService(db *gorm.DB, cfg *config.Config) *ConfigService {
	return &ConfigService{db: db, secret: cfg.Eval.EncryptionSecret}
}

// UpsertEndpointInput 新增/更新端点的输入。APIKey 为空表示更新时不改动。
type UpsertEndpointInput struct {
	Name      string
	BaseURL   string
	ModelName string
	APIKey    string
	IsDefault bool
}

// CreateEndpoint 新增被测端点（归属 projectID）。同项目内 is_default 唯一。
func (s *ConfigService) CreateEndpoint(projectID string, in UpsertEndpointInput) (*model.TargetEndpoint, error) {
	if in.Name == "" || in.BaseURL == "" || in.ModelName == "" {
		return nil, fmt.Errorf("name, base_url and model_name are required")
	}
	enc, err := s.encrypt(in.APIKey)
	if err != nil {
		return nil, err
	}
	ep := &model.TargetEndpoint{
		ID:        util.NewID("ep"),
		ProjectID: projectID,
		Name:      in.Name,
		BaseURL:   in.BaseURL,
		ModelName: in.ModelName,
		APIKeyEnc: enc,
		IsDefault: in.IsDefault,
	}
	err = s.db.Transaction(func(tx *gorm.DB) error {
		if in.IsDefault {
			if err := tx.Model(&model.TargetEndpoint{}).Where("is_default = ? AND project_id = ?", true, projectID).Update("is_default", false).Error; err != nil {
				return err
			}
		}
		return tx.Create(ep).Error
	})
	if err != nil {
		return nil, err
	}
	return ep, nil
}

// UpdateEndpoint 更新端点。APIKey 为空则保留原值。projectID 用于校验端点归属，
// 防止跨项目通过 ID 越权更新。
func (s *ConfigService) UpdateEndpoint(projectID, id string, in UpsertEndpointInput) (*model.TargetEndpoint, error) {
	ep, err := s.GetEndpointInProject(projectID, id)
	if err != nil {
		return nil, err
	}
	if in.Name != "" {
		ep.Name = in.Name
	}
	if in.BaseURL != "" {
		ep.BaseURL = in.BaseURL
	}
	if in.ModelName != "" {
		ep.ModelName = in.ModelName
	}
	if in.APIKey != "" {
		enc, err := s.encrypt(in.APIKey)
		if err != nil {
			return nil, err
		}
		ep.APIKeyEnc = enc
	}
	ep.IsDefault = in.IsDefault
	err = s.db.Transaction(func(tx *gorm.DB) error {
		if in.IsDefault {
			if err := tx.Model(&model.TargetEndpoint{}).Where("is_default = ? AND id <> ? AND project_id = ?", true, id, projectID).Update("is_default", false).Error; err != nil {
				return err
			}
		}
		return tx.Save(ep).Error
	})
	if err != nil {
		return nil, err
	}
	return ep, nil
}

// GetEndpoint 按 ID 查端点（含加密 api_key，供内部注入使用），不做项目归属校验，
// 供调度器等内部代码在已知安全上下文中直接按 ID 取值使用。
func (s *ConfigService) GetEndpoint(id string) (*model.TargetEndpoint, error) {
	var ep model.TargetEndpoint
	if err := s.db.First(&ep, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &ep, nil
}

// GetEndpointInProject 按 ID+projectID 查端点，防止跨项目通过 ID 越权访问。
func (s *ConfigService) GetEndpointInProject(projectID, id string) (*model.TargetEndpoint, error) {
	var ep model.TargetEndpoint
	if err := s.db.First(&ep, "id = ? AND project_id = ?", id, projectID).Error; err != nil {
		return nil, err
	}
	return &ep, nil
}

// ListEndpoints 列出指定项目下的全部端点。
func (s *ConfigService) ListEndpoints(projectID string) ([]model.TargetEndpoint, error) {
	var eps []model.TargetEndpoint
	if err := s.db.Where("project_id = ?", projectID).Order("created_at desc").Find(&eps).Error; err != nil {
		return nil, err
	}
	return eps, nil
}

// DeleteEndpoint 删除端点（软删），要求归属指定项目。
func (s *ConfigService) DeleteEndpoint(projectID, id string) error {
	return s.db.Where("project_id = ?", projectID).Delete(&model.TargetEndpoint{}, "id = ?", id).Error
}

// DefaultEndpoint 返回指定项目的默认端点，供 EvalRun 未指定端点时使用（阶段二）。
func (s *ConfigService) DefaultEndpoint(projectID string) (*model.TargetEndpoint, error) {
	var ep model.TargetEndpoint
	err := s.db.Where("is_default = ? AND project_id = ?", true, projectID).First(&ep).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, fmt.Errorf("no default target endpoint configured")
	}
	if err != nil {
		return nil, err
	}
	return &ep, nil
}

// ResolveAPIKey 解密端点 api_key，供派发测试任务时注入（阶段二内部使用）。
func (s *ConfigService) ResolveAPIKey(ep *model.TargetEndpoint) (string, error) {
	if ep.APIKeyEnc == "" {
		return "", nil
	}
	return util.Decrypt(s.secret, ep.APIKeyEnc)
}

func (s *ConfigService) encrypt(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	return util.Encrypt(s.secret, plain)
}

// MaskedAPIKey 返回脱敏后的 api_key 供接口展示。
func (s *ConfigService) MaskedAPIKey(ep *model.TargetEndpoint) string {
	if ep.APIKeyEnc == "" {
		return ""
	}
	plain, err := util.Decrypt(s.secret, ep.APIKeyEnc)
	if err != nil {
		return "****"
	}
	return util.MaskSecret(plain)
}
