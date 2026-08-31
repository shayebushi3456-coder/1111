package service

import (
	"fmt"

	"task-pilot/internal/model"
	"task-pilot/internal/util"
	"gorm.io/gorm"
)

// CaseSetService 管理用例集及其用例、校验点。
type CaseSetService struct {
	db *gorm.DB
}

func NewCaseSetService(db *gorm.DB) *CaseSetService {
	return &CaseSetService{db: db}
}

// CheckpointInput 单条校验点输入：文本描述 + 可选参考文件（仅供评测 LLM 读取）。
type CheckpointInput struct {
	Description string
	FileIDs     []string
}

// CaseInput 单条用例输入。
type CaseInput struct {
	Name        string
	Description string
	FileIDs     []string
	Checkpoints []CheckpointInput
	// MCPIDs / SkillIDs 该用例绑定的 MCP Server / Skill 配置 ID（引用 model.MCPConfig /
	// model.SkillConfig），派发测试任务前会据此在执行器 Pod 内还原对应配置。
	MCPIDs   []string
	SkillIDs []string
	// EnablePPTVisualScore / EnableHTMLVisualScore 是否对 PPT/HTML 类产物执行转图片视觉评测。
	// 默认 false：不转图片、不做视觉评审；仅显式开启时执行。
	EnablePPTVisualScore  bool
	EnableHTMLVisualScore bool
	// SkipHTMLVisualScore 兼容旧字段，新逻辑以 EnableHTMLVisualScore 为准。
	SkipHTMLVisualScore bool
}

// CaseSetInput 用例集输入。
type CaseSetInput struct {
	Name        string
	Description string
	Cases       []CaseInput
}

func (s *CaseSetService) validate(in CaseSetInput) error {
	if in.Name == "" {
		return fmt.Errorf("name is required")
	}
	if len(in.Cases) == 0 {
		return fmt.Errorf("at least one case is required")
	}
	for i, c := range in.Cases {
		if c.Name == "" {
			return fmt.Errorf("case[%d].name is required", i)
		}
		if c.Description == "" {
			return fmt.Errorf("case[%d].description is required", i)
		}
		if len(c.Checkpoints) == 0 {
			return fmt.Errorf("case[%d] must have at least one checkpoint", i)
		}
		for j, cp := range c.Checkpoints {
			if cp.Description == "" {
				return fmt.Errorf("case[%d].checkpoints[%d].description is required", i, j)
			}
		}
	}
	return nil
}

func buildCases(caseSetID string, cases []CaseInput) []model.Case {
	out := make([]model.Case, 0, len(cases))
	for i, c := range cases {
		caseID := util.NewID("case")
		cks := make([]model.Checkpoint, 0, len(c.Checkpoints))
		for j, cp := range c.Checkpoints {
			cks = append(cks, model.Checkpoint{
				ID:          util.NewID("ck"),
				CaseID:      caseID,
				OrderNo:     j,
				Description: cp.Description,
				FileIDsJSON: model.EncodeFileIDs(cp.FileIDs),
			})
		}
		out = append(out, model.Case{
			ID:                  caseID,
			CaseSetID:           caseSetID,
			Name:                c.Name,
			Description:         c.Description,
			FileIDsJSON:         model.EncodeFileIDs(c.FileIDs),
			MCPIDsJSON:          model.EncodeFileIDs(c.MCPIDs),
			SkillIDsJSON:        model.EncodeFileIDs(c.SkillIDs),
			OrderNo:               i,
			EnablePPTVisualScore:  c.EnablePPTVisualScore,
			EnableHTMLVisualScore: c.EnableHTMLVisualScore,
			SkipHTMLVisualScore:   c.SkipHTMLVisualScore,
			Checkpoints:           cks,
		})
	}
	return out
}

// Create 创建用例集（含用例与校验点）。
func (s *CaseSetService) Create(in CaseSetInput) (*model.CaseSet, error) {
	if err := s.validate(in); err != nil {
		return nil, err
	}
	csID := util.NewID("cs")
	cs := &model.CaseSet{
		ID:          csID,
		Name:        in.Name,
		Description: in.Description,
		Version:     1,
		Cases:       buildCases(csID, in.Cases),
	}
	if err := s.db.Create(cs).Error; err != nil {
		return nil, err
	}
	return s.Get(csID)
}

// Get 查询用例集详情（含用例与校验点）。
func (s *CaseSetService) Get(id string) (*model.CaseSet, error) {
	var cs model.CaseSet
	err := s.db.Preload("Cases", func(db *gorm.DB) *gorm.DB {
		return db.Order("order_no asc")
	}).Preload("Cases.Checkpoints", func(db *gorm.DB) *gorm.DB {
		return db.Order("order_no asc")
	}).First(&cs, "id = ?", id).Error
	if err != nil {
		return nil, err
	}
	for i := range cs.Cases {
		cs.Cases[i].FileIDs = model.DecodeFileIDs(cs.Cases[i].FileIDsJSON)
		cs.Cases[i].MCPIDs = model.DecodeFileIDs(cs.Cases[i].MCPIDsJSON)
		cs.Cases[i].SkillIDs = model.DecodeFileIDs(cs.Cases[i].SkillIDsJSON)
		for j := range cs.Cases[i].Checkpoints {
			cs.Cases[i].Checkpoints[j].FileIDs = model.DecodeFileIDs(cs.Cases[i].Checkpoints[j].FileIDsJSON)
		}
	}
	return &cs, nil
}

// List 列出用例集（预加载用例列表以便前端展示用例数量，不含校验点明细）。
func (s *CaseSetService) List() ([]model.CaseSet, error) {
	var sets []model.CaseSet
	if err := s.db.Preload("Cases", func(db *gorm.DB) *gorm.DB {
		return db.Order("order_no asc")
	}).Order("created_at desc").Limit(100).Find(&sets).Error; err != nil {
		return nil, err
	}
	return sets, nil
}

// Update 覆盖式更新用例集：替换全部用例与校验点，并递增版本。
func (s *CaseSetService) Update(id string, in CaseSetInput) (*model.CaseSet, error) {
	if err := s.validate(in); err != nil {
		return nil, err
	}
	var cs model.CaseSet
	if err := s.db.First(&cs, "id = ?", id).Error; err != nil {
		return nil, err
	}
	err := s.db.Transaction(func(tx *gorm.DB) error {
		var oldCases []model.Case
		if err := tx.Where("case_set_id = ?", id).Find(&oldCases).Error; err != nil {
			return err
		}
		for _, oc := range oldCases {
			if err := tx.Where("case_id = ?", oc.ID).Delete(&model.Checkpoint{}).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("case_set_id = ?", id).Delete(&model.Case{}).Error; err != nil {
			return err
		}
		cs.Name = in.Name
		cs.Description = in.Description
		cs.Version++
		if err := tx.Save(&cs).Error; err != nil {
			return err
		}
		return tx.Create(buildCases(id, in.Cases)).Error
	})
	if err != nil {
		return nil, err
	}
	return s.Get(id)
}

// Delete 软删除用例集及其用例、校验点。
func (s *CaseSetService) Delete(id string) error {
	return s.db.Transaction(func(tx *gorm.DB) error {
		var cases []model.Case
		if err := tx.Where("case_set_id = ?", id).Find(&cases).Error; err != nil {
			return err
		}
		for _, c := range cases {
			if err := tx.Where("case_id = ?", c.ID).Delete(&model.Checkpoint{}).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("case_set_id = ?", id).Delete(&model.Case{}).Error; err != nil {
			return err
		}
		return tx.Delete(&model.CaseSet{}, "id = ?", id).Error
	})
}
