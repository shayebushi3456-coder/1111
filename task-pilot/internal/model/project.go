package model

import (
	"time"

	"gorm.io/gorm"
)

// ProjectRole 项目内角色，固定三档：owner（管理）、editor（编辑）、viewer（只读）。
type ProjectRole string

const (
	ProjectRoleOwner  ProjectRole = "owner"
	ProjectRoleEditor ProjectRole = "editor"
	ProjectRoleViewer ProjectRole = "viewer"
)

// ProjectVisibility 空间公开性：public 任何人（含游客）只读；private 仅成员（及平台 admin）可访问。
type ProjectVisibility string

const (
	ProjectVisibilityPublic  ProjectVisibility = "public"
	ProjectVisibilityPrivate ProjectVisibility = "private"
)

// DefaultProjectName 默认项目名称。系统启动时保证存在且唯一，历史空 project_id 数据回填于此。
const DefaultProjectName = "IO-Eval"

// IsValidProjectRole 校验项目角色是否为受支持的三档之一。
func IsValidProjectRole(role ProjectRole) bool {
	switch role {
	case ProjectRoleOwner, ProjectRoleEditor, ProjectRoleViewer:
		return true
	default:
		return false
	}
}

// IsValidProjectVisibility 校验空间公开性。
func IsValidProjectVisibility(v ProjectVisibility) bool {
	switch v {
	case ProjectVisibilityPublic, ProjectVisibilityPrivate:
		return true
	default:
		return false
	}
}

// Project 项目空间：业务资源（用例集/执行任务/配置/文件等）按 ProjectID 归属到某个项目，
// 实现多项目间的数据隔离。允许物理删除（见 ProjectService.Delete），默认项目除外。
type Project struct {
	ID          string `gorm:"primaryKey;size:64" json:"id"`
	Name        string `gorm:"uniqueIndex;size:128" json:"name"`
	Description string `gorm:"type:text" json:"description"`
	// Visibility public=任何人只读（含游客）；private=仅成员。空串按 public 兼容历史数据。
	Visibility ProjectVisibility `gorm:"size:16;index;default:private" json:"visibility"`
	// IsDefault 标记默认项目（IO-Eval）。默认项目不可被物理删除，保证系统始终有一个兜底项目空间。
	IsDefault bool `gorm:"index" json:"is_default"`
	// PrestartScriptFileID 可选：测试 Pod 启动后、agent 执行前要跑的 .py（FilePurposePrestart）。空=不使用。
	PrestartScriptFileID string         `gorm:"size:64" json:"prestart_script_file_id"`
	CreatedBy            string         `gorm:"size:64" json:"created_by"`
	CreatedAt            time.Time      `json:"created_at"`
	UpdatedAt            time.Time      `json:"updated_at"`
	DeletedAt            gorm.DeletedAt `gorm:"index" json:"-"`

	Members []ProjectMember `gorm:"foreignKey:ProjectID" json:"members,omitempty"`
}

// IsPublicSpace 公开空间（含历史空 visibility）。
func (p *Project) IsPublicSpace() bool {
	return p.Visibility == "" || p.Visibility == ProjectVisibilityPublic
}

// ProjectMember 项目成员关系：一个用户在一个项目内拥有唯一角色。
type ProjectMember struct {
	ID        string      `gorm:"primaryKey;size:64" json:"id"`
	ProjectID string      `gorm:"uniqueIndex:idx_project_member_project_user;size:64" json:"project_id"`
	UserID    string      `gorm:"uniqueIndex:idx_project_member_project_user;size:64" json:"user_id"`
	Role      ProjectRole `gorm:"size:32" json:"role"`
	CreatedAt time.Time   `json:"created_at"`
	UpdatedAt time.Time   `json:"updated_at"`
}
