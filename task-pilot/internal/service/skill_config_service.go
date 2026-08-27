package service

import (
	"fmt"

	"task-pilot/internal/model"
	"task-pilot/internal/util"
	"gorm.io/gorm"
)

// SkillConfigService 管理可复用的 Claude Code Skill 定义（多套），供用例绑定。
type SkillConfigService struct {
	db *gorm.DB
}

func NewSkillConfigService(db *gorm.DB) *SkillConfigService {
	return &SkillConfigService{db: db}
}

// UpsertSkillConfigInput 新增/更新 Skill 配置的输入。
type UpsertSkillConfigInput struct {
	Name        string
	Description string
	// ContentMD 落地为该 Skill 目录下的 SKILL.md 正文。
	ContentMD string
	// ExtraFiles 附加文件：相对路径（如 "references/api.md"）→ 文本内容，落地到 SKILL.md 同级目录。
	ExtraFiles map[string]string
}

func (s *SkillConfigService) Create(in UpsertSkillConfigInput) (*model.SkillConfig, error) {
	if in.Name == "" {
		return nil, fmt.Errorf("name is required")
	}
	if in.ContentMD == "" {
		return nil, fmt.Errorf("content_md is required")
	}
	sk := &model.SkillConfig{
		ID:             util.NewID("skill"),
		Name:           in.Name,
		Description:    in.Description,
		ContentMD:      in.ContentMD,
		ExtraFilesJSON: model.EncodeExtraFiles(in.ExtraFiles),
	}
	if err := s.db.Create(sk).Error; err != nil {
		return nil, err
	}
	return sk, nil
}

func (s *SkillConfigService) Update(id string, in UpsertSkillConfigInput) (*model.SkillConfig, error) {
	sk, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if in.Name != "" {
		sk.Name = in.Name
	}
	sk.Description = in.Description
	if in.ContentMD != "" {
		sk.ContentMD = in.ContentMD
	}
	sk.ExtraFilesJSON = model.EncodeExtraFiles(in.ExtraFiles)
	if err := s.db.Save(sk).Error; err != nil {
		return nil, err
	}
	return sk, nil
}

func (s *SkillConfigService) Get(id string) (*model.SkillConfig, error) {
	var sk model.SkillConfig
	if err := s.db.First(&sk, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &sk, nil
}

func (s *SkillConfigService) List() ([]model.SkillConfig, error) {
	var items []model.SkillConfig
	if err := s.db.Order("created_at desc").Find(&items).Error; err != nil {
		return nil, err
	}
	return items, nil
}

func (s *SkillConfigService) Delete(id string) error {
	return s.db.Delete(&model.SkillConfig{}, "id = ?", id).Error
}

// GetMany 按 ID 批量查询（保持稳定顺序，跳过不存在的 ID），供派发测试任务时解析用例绑定使用。
func (s *SkillConfigService) GetMany(ids []string) ([]model.SkillConfig, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	var items []model.SkillConfig
	if err := s.db.Where("id IN ?", ids).Find(&items).Error; err != nil {
		return nil, err
	}
	byID := make(map[string]model.SkillConfig, len(items))
	for _, it := range items {
		byID[it.ID] = it
	}
	out := make([]model.SkillConfig, 0, len(ids))
	for _, id := range ids {
		if it, ok := byID[id]; ok {
			out = append(out, it)
		}
	}
	return out, nil
}
