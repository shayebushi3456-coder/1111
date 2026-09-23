package service

import (
	"fmt"
	"regexp"
	"strings"

	"task-pilot/internal/config"
	"task-pilot/internal/model"
	"task-pilot/internal/util"
	"gorm.io/gorm"
)

var runtimeEnvKeyRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// RuntimeEnvConfigService 管理执行时环境变量配置，供 TestTask/EvalTask 派发时注入 Pod。
type RuntimeEnvConfigService struct {
	db     *gorm.DB
	secret string
}

type UpsertRuntimeEnvConfigInput struct {
	Key         string
	Value       string
	Description string
	MaskValue   bool
	Enabled     bool
}

func NewRuntimeEnvConfigService(db *gorm.DB, cfg *config.Config) *RuntimeEnvConfigService {
	return &RuntimeEnvConfigService{db: db, secret: cfg.Eval.EncryptionSecret}
}

func validateRuntimeEnvKey(key string) error {
	if key == "" {
		return fmt.Errorf("key is required")
	}
	if !runtimeEnvKeyRe.MatchString(key) {
		return fmt.Errorf("key must match [A-Za-z_][A-Za-z0-9_]*")
	}
	reservedPrefixes := []string{"TASK_", "WORKSPACE", "TARGET_", "EVAL_", "KUBERNETES_"}
	for _, p := range reservedPrefixes {
		if key == p || strings.HasPrefix(key, p) {
			return fmt.Errorf("key %q uses reserved prefix %q", key, p)
		}
	}
	return nil
}

func (s *RuntimeEnvConfigService) encrypt(plain string) (string, error) {
	return util.Encrypt(s.secret, plain)
}

func (s *RuntimeEnvConfigService) decrypt(enc string) (string, error) {
	if enc == "" {
		return "", nil
	}
	return util.Decrypt(s.secret, enc)
}

func (s *RuntimeEnvConfigService) fillDisplayValue(item *model.RuntimeEnvConfig) {
	plain, err := s.decrypt(item.ValueEnc)
	if err != nil {
		item.Value = ""
		item.ValueMasked = "****"
		return
	}
	item.ValueMasked = util.MaskSecret(plain)
	if item.MaskValue {
		item.Value = ""
	} else {
		item.Value = plain
	}
}

func (s *RuntimeEnvConfigService) Create(projectID string, in UpsertRuntimeEnvConfigInput) (*model.RuntimeEnvConfig, error) {
	in.Key = strings.TrimSpace(in.Key)
	if err := validateRuntimeEnvKey(in.Key); err != nil {
		return nil, err
	}
	enc, err := s.encrypt(in.Value)
	if err != nil {
		return nil, err
	}
	item := &model.RuntimeEnvConfig{
		ID:          util.NewID("env"),
		ProjectID:   projectID,
		Key:         in.Key,
		Description: in.Description,
		ValueEnc:    enc,
		MaskValue:   in.MaskValue,
		Enabled:     in.Enabled,
	}
	if err := s.db.Create(item).Error; err != nil {
		return nil, err
	}
	s.fillDisplayValue(item)
	return item, nil
}

func (s *RuntimeEnvConfigService) Update(projectID, id string, in UpsertRuntimeEnvConfigInput) (*model.RuntimeEnvConfig, error) {
	item, err := s.GetInProject(projectID, id)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(in.Key) != "" {
		key := strings.TrimSpace(in.Key)
		if err := validateRuntimeEnvKey(key); err != nil {
			return nil, err
		}
		item.Key = key
	}
	item.Description = in.Description
	if in.Value != "" {
		enc, err := s.encrypt(in.Value)
		if err != nil {
			return nil, err
		}
		item.ValueEnc = enc
	}
	item.MaskValue = in.MaskValue
	item.Enabled = in.Enabled
	if err := s.db.Save(item).Error; err != nil {
		return nil, err
	}
	s.fillDisplayValue(item)
	return item, nil
}

// Get 按 ID 查询，不做项目归属校验，供内部使用。
func (s *RuntimeEnvConfigService) Get(id string) (*model.RuntimeEnvConfig, error) {
	var item model.RuntimeEnvConfig
	if err := s.db.First(&item, "id = ?", id).Error; err != nil {
		return nil, err
	}
	s.fillDisplayValue(&item)
	return &item, nil
}

// GetInProject 按 ID+projectID 查询，防止跨项目通过 ID 越权访问。
func (s *RuntimeEnvConfigService) GetInProject(projectID, id string) (*model.RuntimeEnvConfig, error) {
	var item model.RuntimeEnvConfig
	if err := s.db.First(&item, "id = ? AND project_id = ?", id, projectID).Error; err != nil {
		return nil, err
	}
	s.fillDisplayValue(&item)
	return &item, nil
}

func (s *RuntimeEnvConfigService) List(projectID string) ([]model.RuntimeEnvConfig, error) {
	var items []model.RuntimeEnvConfig
	if err := s.db.Where("project_id = ?", projectID).Order("created_at desc").Find(&items).Error; err != nil {
		return nil, err
	}
	for i := range items {
		s.fillDisplayValue(&items[i])
	}
	return items, nil
}

func (s *RuntimeEnvConfigService) Delete(projectID, id string) error {
	return s.db.Where("project_id = ?", projectID).Delete(&model.RuntimeEnvConfig{}, "id = ?", id).Error
}

// EnabledEnv 返回指定项目下所有已启用的环境变量，供派发测试/评测任务时注入 Pod。
func (s *RuntimeEnvConfigService) EnabledEnv(projectID string) (map[string]string, error) {
	var items []model.RuntimeEnvConfig
	if err := s.db.Where("enabled = ? AND project_id = ?", true, projectID).Find(&items).Error; err != nil {
		return nil, err
	}
	out := make(map[string]string, len(items))
	for i := range items {
		plain, err := s.decrypt(items[i].ValueEnc)
		if err != nil {
			return nil, fmt.Errorf("decrypt runtime env %s: %w", items[i].Key, err)
		}
		out[items[i].Key] = plain
	}
	return out, nil
}
