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

// envKeyPattern 环境变量 Key：字母/下划线开头，后接字母数字下划线。
var envKeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// envPlaceholderPattern 匹配用例描述中的 {{KEY}} 引用。
var envPlaceholderPattern = regexp.MustCompile(`\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}`)

// EnvVarService 管理全局环境变量（加密存储、脱敏读取）。
type EnvVarService struct {
	db     *gorm.DB
	secret string
}

func NewEnvVarService(db *gorm.DB, cfg *config.Config) *EnvVarService {
	return &EnvVarService{db: db, secret: cfg.Eval.EncryptionSecret}
}

type UpsertEnvVarInput struct {
	Key         string
	Value       string // 更新时为空表示保留原值
	Description string
}

func (s *EnvVarService) Create(in UpsertEnvVarInput) (*model.EnvVar, error) {
	key := strings.TrimSpace(in.Key)
	if !envKeyPattern.MatchString(key) {
		return nil, fmt.Errorf("key must match %s", envKeyPattern.String())
	}
	if strings.TrimSpace(in.Value) == "" {
		return nil, fmt.Errorf("value is required")
	}
	enc, err := util.Encrypt(s.secret, in.Value)
	if err != nil {
		return nil, err
	}
	ev := &model.EnvVar{
		ID:          util.NewID("env"),
		Key:         key,
		ValueEnc:    enc,
		Description: in.Description,
	}
	if err := s.db.Create(ev).Error; err != nil {
		return nil, err
	}
	return ev, nil
}

func (s *EnvVarService) Update(id string, in UpsertEnvVarInput) (*model.EnvVar, error) {
	ev, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if in.Key != "" {
		key := strings.TrimSpace(in.Key)
		if !envKeyPattern.MatchString(key) {
			return nil, fmt.Errorf("key must match %s", envKeyPattern.String())
		}
		ev.Key = key
	}
	ev.Description = in.Description
	if strings.TrimSpace(in.Value) != "" {
		enc, err := util.Encrypt(s.secret, in.Value)
		if err != nil {
			return nil, err
		}
		ev.ValueEnc = enc
	}
	if err := s.db.Save(ev).Error; err != nil {
		return nil, err
	}
	return ev, nil
}

func (s *EnvVarService) Get(id string) (*model.EnvVar, error) {
	var ev model.EnvVar
	if err := s.db.First(&ev, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &ev, nil
}

func (s *EnvVarService) List() ([]model.EnvVar, error) {
	var items []model.EnvVar
	if err := s.db.Order("key asc").Find(&items).Error; err != nil {
		return nil, err
	}
	return items, nil
}

func (s *EnvVarService) Delete(id string) error {
	return s.db.Delete(&model.EnvVar{}, "id = ?", id).Error
}

// MaskedValue 解密后脱敏展示。
func (s *EnvVarService) MaskedValue(ev *model.EnvVar) string {
	if ev.ValueEnc == "" {
		return ""
	}
	plain, err := util.Decrypt(s.secret, ev.ValueEnc)
	if err != nil {
		return "****"
	}
	return util.MaskSecret(plain)
}

// ResolveMap 返回 key → 明文 value，供派发时替换占位符。
func (s *EnvVarService) ResolveMap() (map[string]string, error) {
	items, err := s.List()
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, len(items))
	for i := range items {
		plain, err := util.Decrypt(s.secret, items[i].ValueEnc)
		if err != nil {
			return nil, fmt.Errorf("decrypt env %s: %w", items[i].Key, err)
		}
		out[items[i].Key] = plain
	}
	return out, nil
}

// SubstituteEnvVars 将文本中的 {{KEY}} 替换为实际值。
// 若引用了未定义的 key，返回错误（避免静默漏替导致敏感占位符进执行器）。
func SubstituteEnvVars(text string, values map[string]string) (string, error) {
	var missing []string
	seen := map[string]bool{}
	out := envPlaceholderPattern.ReplaceAllStringFunc(text, func(m string) string {
		sub := envPlaceholderPattern.FindStringSubmatch(m)
		if len(sub) < 2 {
			return m
		}
		key := sub[1]
		v, ok := values[key]
		if !ok {
			if !seen[key] {
				missing = append(missing, key)
				seen[key] = true
			}
			return m
		}
		return v
	})
	if len(missing) > 0 {
		return "", fmt.Errorf("undefined env vars: %s", strings.Join(missing, ", "))
	}
	return out, nil
}
