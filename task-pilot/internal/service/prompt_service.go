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

// SeedDefault 若库中没有任何 prompt，则用内置模板写入一条默认 prompt（归属 projectID）。
// 仅作为开箱即用的初始值；用户可随后自由增删改。
func (s *PromptService) SeedDefault(projectID string) error {
	var n int64
	if err := s.db.Model(&model.EvalPrompt{}).Where("project_id = ?", projectID).Count(&n).Error; err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	return s.db.Create(&model.EvalPrompt{
		ID:        util.NewID("prompt"),
		ProjectID: projectID,
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

func (s *PromptService) Create(projectID string, in UpsertPromptInput) (*model.EvalPrompt, error) {
	if in.Name == "" || in.Content == "" {
		return nil, fmt.Errorf("name and content are required")
	}
	p := &model.EvalPrompt{
		ID:        util.NewID("prompt"),
		ProjectID: projectID,
		Name:      in.Name,
		Content:   in.Content,
		IsDefault: in.IsDefault,
	}
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if in.IsDefault {
			if err := tx.Model(&model.EvalPrompt{}).Where("is_default = ? AND project_id = ?", true, projectID).Update("is_default", false).Error; err != nil {
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

func (s *PromptService) Update(projectID, id string, in UpsertPromptInput) (*model.EvalPrompt, error) {
	p, err := s.GetInProject(projectID, id)
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
			if err := tx.Model(&model.EvalPrompt{}).Where("is_default = ? AND id <> ? AND project_id = ?", true, id, projectID).Update("is_default", false).Error; err != nil {
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

// Get 按 ID 查询，不做项目归属校验，供调度器等内部代码在已知安全上下文中使用。
func (s *PromptService) Get(id string) (*model.EvalPrompt, error) {
	var p model.EvalPrompt
	if err := s.db.First(&p, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &p, nil
}

// GetInProject 按 ID+projectID 查询，防止跨项目通过 ID 越权访问。
func (s *PromptService) GetInProject(projectID, id string) (*model.EvalPrompt, error) {
	var p model.EvalPrompt
	if err := s.db.First(&p, "id = ? AND project_id = ?", id, projectID).Error; err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *PromptService) List(projectID string) ([]model.EvalPrompt, error) {
	var ps []model.EvalPrompt
	if err := s.db.Where("project_id = ?", projectID).Order("created_at desc").Find(&ps).Error; err != nil {
		return nil, err
	}
	return ps, nil
}

func (s *PromptService) Delete(projectID, id string) error {
	return s.db.Where("project_id = ?", projectID).Delete(&model.EvalPrompt{}, "id = ?", id).Error
}

// Default 返回指定项目的默认 prompt，供 EvalRun 未指定 prompt 时使用。
func (s *PromptService) Default(projectID string) (*model.EvalPrompt, error) {
	var p model.EvalPrompt
	err := s.db.Where("is_default = ? AND project_id = ?", true, projectID).First(&p).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, fmt.Errorf("no default eval prompt configured")
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}
