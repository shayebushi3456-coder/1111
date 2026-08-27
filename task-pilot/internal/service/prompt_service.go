package service

import (
	"errors"
	"fmt"

	"task-pilot/internal/config"
	"task-pilot/internal/model"
	"task-pilot/internal/util"
	"gorm.io/gorm"
)

// PromptService 管理用户自定义的评测 prompt（CRUD + 默认项）。
type PromptService struct {
	db *gorm.DB
}

func NewPromptService(db *gorm.DB) *PromptService {
	return &PromptService{db: db}
}

// SeedDefault 若库中没有任何 prompt，则用内置模板写入一条默认 prompt。
// 仅作为开箱即用的初始值；用户可随后自由增删改。
func (s *PromptService) SeedDefault() error {
	var n int64
	if err := s.db.Model(&model.EvalPrompt{}).Count(&n).Error; err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	return s.db.Create(&model.EvalPrompt{
		ID:        util.NewID("prompt"),
		Name:      "default",
		Content:   config.Builtin.EvalPromptTemplate,
		IsDefault: true,
	}).Error
}

// UpsertPromptInput 新增/更新 prompt 的输入。
type UpsertPromptInput struct {
	Name      string
	Content   string
	IsDefault bool
}

func (s *PromptService) Create(in UpsertPromptInput) (*model.EvalPrompt, error) {
	if in.Name == "" || in.Content == "" {
		return nil, fmt.Errorf("name and content are required")
	}
	p := &model.EvalPrompt{
		ID:        util.NewID("prompt"),
		Name:      in.Name,
		Content:   in.Content,
		IsDefault: in.IsDefault,
	}
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if in.IsDefault {
			if err := tx.Model(&model.EvalPrompt{}).Where("is_default = ?", true).Update("is_default", false).Error; err != nil {
				return err
			}
		}
		return tx.Create(p).Error
	})
	if err != nil {
		return nil, err
	}
	return p, nil
}

func (s *PromptService) Update(id string, in UpsertPromptInput) (*model.EvalPrompt, error) {
	p, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if in.Name != "" {
		p.Name = in.Name
	}
	if in.Content != "" {
		p.Content = in.Content
	}
	p.IsDefault = in.IsDefault
	err = s.db.Transaction(func(tx *gorm.DB) error {
		if in.IsDefault {
			if err := tx.Model(&model.EvalPrompt{}).Where("is_default = ? AND id <> ?", true, id).Update("is_default", false).Error; err != nil {
				return err
			}
		}
		return tx.Save(p).Error
	})
	if err != nil {
		return nil, err
	}
	return p, nil
}

func (s *PromptService) Get(id string) (*model.EvalPrompt, error) {
	var p model.EvalPrompt
	if err := s.db.First(&p, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *PromptService) List() ([]model.EvalPrompt, error) {
	var ps []model.EvalPrompt
	if err := s.db.Order("created_at desc").Find(&ps).Error; err != nil {
		return nil, err
	}
	return ps, nil
}

func (s *PromptService) Delete(id string) error {
	return s.db.Delete(&model.EvalPrompt{}, "id = ?", id).Error
}

// Default 返回默认 prompt，供 EvalRun 未指定 prompt 时使用。
func (s *PromptService) Default() (*model.EvalPrompt, error) {
	var p model.EvalPrompt
	err := s.db.Where("is_default = ?", true).First(&p).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, fmt.Errorf("no default eval prompt configured")
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}
