package service

import (
	"errors"
	"fmt"
	"os"

	"task-pilot/internal/config"
	"task-pilot/internal/model"
	"task-pilot/internal/util"
	"gorm.io/gorm"
)

// EvalEndpointService 管理评测模型端点（多套）。配置方式与被测端点（ConfigService）
// 完全一致：api_key AES-GCM 加密存储、脱敏读取，支持默认端点。
type EvalEndpointService struct {
	db     *gorm.DB
	secret string
}

func NewEvalEndpointService(db *gorm.DB, cfg *config.Config) *EvalEndpointService {
	return &EvalEndpointService{db: db, secret: cfg.Eval.EncryptionSecret}
}

// SeedDefault 若库中没有任何评测端点，则用内置默认值写入一条默认端点。
// base_url/model 取自 config.Builtin.EvalModel；api_key 从环境变量 EVAL_MODEL_API_KEY
// 读取（不再硬编码明文）。仅作开箱即用的初始值，用户可随后自由增删改。
func (s *EvalEndpointService) SeedDefault() error {
	var n int64
	if err := s.db.Model(&model.EvalEndpoint{}).Count(&n).Error; err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	enc, err := s.encrypt(os.Getenv("EVAL_MODEL_API_KEY"))
	if err != nil {
		return err
	}
	return s.db.Create(&model.EvalEndpoint{
		ID:        util.NewID("eep"),
		Name:      "default",
		BaseURL:   config.Builtin.EvalModel.BaseURL,
		ModelName: config.Builtin.EvalModel.ModelName,
		APIKeyEnc: enc,
		IsDefault: true,
	}).Error
}

// CreateEndpoint 新增评测端点。
func (s *EvalEndpointService) CreateEndpoint(in UpsertEndpointInput) (*model.EvalEndpoint, error) {
	if in.Name == "" || in.BaseURL == "" || in.ModelName == "" {
		return nil, fmt.Errorf("name, base_url and model_name are required")
	}
	enc, err := s.encrypt(in.APIKey)
	if err != nil {
		return nil, err
	}
	ep := &model.EvalEndpoint{
		ID:        util.NewID("eep"),
		Name:      in.Name,
		BaseURL:   in.BaseURL,
		ModelName: in.ModelName,
		APIKeyEnc: enc,
		IsDefault: in.IsDefault,
	}
	err = s.db.Transaction(func(tx *gorm.DB) error {
		if in.IsDefault {
			if err := tx.Model(&model.EvalEndpoint{}).Where("is_default = ?", true).Update("is_default", false).Error; err != nil {
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

// UpdateEndpoint 更新评测端点。APIKey 为空则保留原值。
func (s *EvalEndpointService) UpdateEndpoint(id string, in UpsertEndpointInput) (*model.EvalEndpoint, error) {
	ep, err := s.GetEndpoint(id)
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
			if err := tx.Model(&model.EvalEndpoint{}).Where("is_default = ? AND id <> ?", true, id).Update("is_default", false).Error; err != nil {
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

// GetEndpoint 按 ID 查评测端点（含加密 api_key，供内部注入使用）。
func (s *EvalEndpointService) GetEndpoint(id string) (*model.EvalEndpoint, error) {
	var ep model.EvalEndpoint
	if err := s.db.First(&ep, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &ep, nil
}

// ListEndpoints 列出全部评测端点。
func (s *EvalEndpointService) ListEndpoints() ([]model.EvalEndpoint, error) {
	var eps []model.EvalEndpoint
	if err := s.db.Order("created_at desc").Find(&eps).Error; err != nil {
		return nil, err
	}
	return eps, nil
}

// DeleteEndpoint 删除评测端点（软删）。
func (s *EvalEndpointService) DeleteEndpoint(id string) error {
	return s.db.Delete(&model.EvalEndpoint{}, "id = ?", id).Error
}

// DefaultEndpoint 返回默认评测端点，供 EvalRun 未指定评测端点时使用。
func (s *EvalEndpointService) DefaultEndpoint() (*model.EvalEndpoint, error) {
	var ep model.EvalEndpoint
	err := s.db.Where("is_default = ?", true).First(&ep).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, fmt.Errorf("no default eval endpoint configured")
	}
	if err != nil {
		return nil, err
	}
	return &ep, nil
}

// ResolveAPIKey 解密评测端点 api_key，供派发评测任务时注入。
func (s *EvalEndpointService) ResolveAPIKey(ep *model.EvalEndpoint) (string, error) {
	if ep.APIKeyEnc == "" {
		return "", nil
	}
	return util.Decrypt(s.secret, ep.APIKeyEnc)
}

func (s *EvalEndpointService) encrypt(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	return util.Encrypt(s.secret, plain)
}

// MaskedAPIKey 返回脱敏后的 api_key 供接口展示。
func (s *EvalEndpointService) MaskedAPIKey(ep *model.EvalEndpoint) string {
	if ep.APIKeyEnc == "" {
		return ""
	}
	plain, err := util.Decrypt(s.secret, ep.APIKeyEnc)
	if err != nil {
		return "****"
	}
	return util.MaskSecret(plain)
}
