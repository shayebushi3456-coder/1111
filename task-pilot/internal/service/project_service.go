package service

import (
	"errors"
	"fmt"
	"strings"

	"task-pilot/internal/model"
	"task-pilot/internal/util"
	"gorm.io/gorm"
)

// ProjectService 管理项目空间、项目成员，以及历史数据到默认项目的一次性回填。
type ProjectService struct {
	db *gorm.DB

	defaultProjectID string
}

func NewProjectService(db *gorm.DB) *ProjectService {
	return &ProjectService{db: db}
}

// CreateProjectInput 新建项目输入。
type CreateProjectInput struct {
	Name                 string
	Description          string
	Visibility           model.ProjectVisibility // 空则 private
	PrestartScriptFileID string
}

// Create 任意 active 用户均可创建项目，创建者自动成为 owner。默认私有。
func (s *ProjectService) Create(creator *model.User, in CreateProjectInput) (*model.Project, error) {
	if creator == nil {
		return nil, fmt.Errorf("login required")
	}
	if creator.Status != model.UserActive {
		return nil, fmt.Errorf("only active users can create a project")
	}
	if in.Name == "" {
		return nil, fmt.Errorf("name is required")
	}
	vis := in.Visibility
	if vis == "" {
		vis = model.ProjectVisibilityPrivate
	}
	if !model.IsValidProjectVisibility(vis) {
		return nil, fmt.Errorf("invalid visibility: %s", vis)
	}
	// 新建项目时尚无本项目文件，绑定留到创建后上传再 Update。
	if in.PrestartScriptFileID != "" {
		return nil, fmt.Errorf("prestart script can only be set after the project is created")
	}
	p := &model.Project{
		ID:          util.NewID("proj"),
		Name:        in.Name,
		Description: in.Description,
		Visibility:  vis,
		IsDefault:   false,
		CreatedBy:   creator.ID,
	}
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(p).Error; err != nil {
			return err
		}
		member := &model.ProjectMember{
			ID:        util.NewID("pm"),
			ProjectID: p.ID,
			UserID:    creator.ID,
			Role:      model.ProjectRoleOwner,
		}
		return tx.Create(member).Error
	})
	if err != nil {
		return nil, err
	}
	return s.Get(p.ID)
}

// Get 按 ID 查询项目。
func (s *ProjectService) Get(id string) (*model.Project, error) {
	var p model.Project
	if err := s.db.First(&p, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &p, nil
}

// List 列出全部项目（平台 admin 用）。
func (s *ProjectService) List() ([]model.Project, error) {
	var items []model.Project
	if err := s.db.Order("created_at asc").Find(&items).Error; err != nil {
		return nil, err
	}
	return items, nil
}

// ListVisible 按可见性过滤：admin 全量；登录用户=公开∪自己是成员；游客=仅公开。
func (s *ProjectService) ListVisible(user *model.User) ([]model.Project, error) {
	if user != nil && user.Role == model.RoleAdmin && user.Status == model.UserActive {
		return s.List()
	}
	var items []model.Project
	q := s.db.Order("created_at asc")
	if user == nil || user.Status != model.UserActive {
		if err := q.Where("visibility = ? OR visibility = ? OR visibility IS NULL", model.ProjectVisibilityPublic, "").Find(&items).Error; err != nil {
			return nil, err
		}
		return items, nil
	}
	if err := q.Where(
		"visibility = ? OR visibility = ? OR visibility IS NULL OR id IN (?)",
		model.ProjectVisibilityPublic, "",
		s.db.Model(&model.ProjectMember{}).Select("project_id").Where("user_id = ?", user.ID),
	).Find(&items).Error; err != nil {
		return nil, err
	}
	return items, nil
}

// UpdateProjectInput 更新项目输入。
type UpdateProjectInput struct {
	Name                 string
	Description          string
	Visibility           model.ProjectVisibility // 空=不改
	PrestartScriptFileID string
}

func (s *ProjectService) validatePrestartScript(projectID, fileID string) error {
	if fileID == "" {
		return nil
	}
	var f model.FileObject
	if err := s.db.First(&f, "id = ?", fileID).Error; err != nil {
		return fmt.Errorf("prestart script not found")
	}
	if f.Purpose != model.FilePurposePrestart {
		return fmt.Errorf("file is not a prestart script")
	}
	if f.ProjectID != projectID {
		return fmt.Errorf("prestart script must belong to this project")
	}
	return nil
}

func (s *ProjectService) Update(id string, in UpdateProjectInput) (*model.Project, error) {
	p, err := s.Get(id)
	if err != nil {
		return nil, err
	}
	if err := s.validatePrestartScript(id, in.PrestartScriptFileID); err != nil {
		return nil, err
	}
	if in.Name != "" {
		p.Name = in.Name
	}
	p.Description = in.Description
	if in.Visibility != "" {
		if !model.IsValidProjectVisibility(in.Visibility) {
			return nil, fmt.Errorf("invalid visibility: %s", in.Visibility)
		}
		p.Visibility = in.Visibility
	}
	p.PrestartScriptFileID = in.PrestartScriptFileID
	if err := s.db.Save(p).Error; err != nil {
		return nil, err
	}
	return p, nil
}

// Delete 物理删除项目（含成员关系）。默认项目 IO-Eval 不允许删除。
// 出于安全考虑，若项目下仍有业务资源（用例集/执行任务/任务/文件等）则拒绝删除，
// 避免留下 project_id 悬空引用；调用方需先迁移或清理这些资源。
func (s *ProjectService) Delete(id string) error {
	p, err := s.Get(id)
	if err != nil {
		return err
	}
	if p.IsDefault {
		return fmt.Errorf("default project cannot be deleted")
	}
	inUse, err := s.projectHasResources(id)
	if err != nil {
		return err
	}
	if inUse {
		return fmt.Errorf("project still has resources, cannot delete")
	}
	return s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Unscoped().Where("project_id = ?", id).Delete(&model.ProjectMember{}).Error; err != nil {
			return err
		}
		return tx.Unscoped().Delete(&model.Project{}, "id = ?", id).Error
	})
}

func (s *ProjectService) projectHasResources(projectID string) (bool, error) {
	tables := []any{
		&model.TargetEndpoint{}, &model.EvalEndpoint{}, &model.EvalPrompt{},
		&model.MCPConfig{}, &model.SkillConfig{}, &model.RuntimeEnvConfig{},
		&model.CaseSet{}, &model.EvalRun{}, &model.Task{}, &model.FileObject{},
	}
	for _, t := range tables {
		var n int64
		if err := s.db.Model(t).Where("project_id = ?", projectID).Count(&n).Error; err != nil {
			return false, err
		}
		if n > 0 {
			return true, nil
		}
	}
	return false, nil
}

// ---- 项目成员管理 ----

func (s *ProjectService) ListMembers(projectID string) ([]model.ProjectMember, error) {
	var items []model.ProjectMember
	if err := s.db.Where("project_id = ?", projectID).Order("created_at asc").Find(&items).Error; err != nil {
		return nil, err
	}
	return items, nil
}

func (s *ProjectService) AddMember(projectID, userID string, role model.ProjectRole) (*model.ProjectMember, error) {
	if !model.IsValidProjectRole(role) {
		return nil, fmt.Errorf("invalid project role: %s", role)
	}
	if userID == "" {
		return nil, fmt.Errorf("user_id is required")
	}
	var u model.User
	if err := s.db.First(&u, "id = ? AND status = ?", userID, model.UserActive).Error; err != nil {
		return nil, fmt.Errorf("user not found or not active")
	}
	var existing model.ProjectMember
	err := s.db.Where("project_id = ? AND user_id = ?", projectID, userID).First(&existing).Error
	if err == nil {
		existing.Role = role
		if err := s.db.Save(&existing).Error; err != nil {
			return nil, err
		}
		return &existing, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	member := &model.ProjectMember{
		ID:        util.NewID("pm"),
		ProjectID: projectID,
		UserID:    userID,
		Role:      role,
	}
	if err := s.db.Create(member).Error; err != nil {
		return nil, err
	}
	return member, nil
}

// ResolveUserID 按 user_id 或 username 解析为活跃用户 ID（分享成员用）。
func (s *ProjectService) ResolveUserID(userID, username string) (string, error) {
	userID = strings.TrimSpace(userID)
	username = strings.TrimSpace(username)
	if userID != "" {
		var u model.User
		if err := s.db.First(&u, "id = ? AND status = ?", userID, model.UserActive).Error; err != nil {
			return "", fmt.Errorf("user not found or not active")
		}
		return u.ID, nil
	}
	if username == "" {
		return "", fmt.Errorf("username or user_id is required")
	}
	uname := strings.ToLower(username)
	var u model.User
	if err := s.db.First(&u, "username = ? AND status = ?", uname, model.UserActive).Error; err != nil {
		return "", fmt.Errorf("user not found or not active")
	}
	return u.ID, nil
}

// SearchUsers 按账号关键字查找活跃用户，供私有空间分享；excludeUserID 非空时排除该用户（通常是自己）。
func (s *ProjectService) SearchUsers(q string, limit int, excludeUserID string) ([]model.User, error) {
	q = strings.TrimSpace(q)
	if q == "" {
		return nil, fmt.Errorf("query is required")
	}
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	like := "%" + q + "%"
	db := s.db.Model(&model.User{}).
		Select("id", "username", "display_name").
		Where("status = ? AND (username LIKE ? OR display_name LIKE ?)", model.UserActive, like, like)
	if excludeUserID != "" {
		db = db.Where("id <> ?", excludeUserID)
	}
	var users []model.User
	err := db.Order("username asc").Limit(limit).Find(&users).Error
	return users, err
}

// MemberUserInfo 成员附带的账号展示字段。
type MemberUserInfo struct {
	Username    string
	DisplayName string
}

// ListMembersDetailed 成员列表 + 用户名。
func (s *ProjectService) ListMembersDetailed(projectID string) ([]model.ProjectMember, map[string]MemberUserInfo, error) {
	items, err := s.ListMembers(projectID)
	if err != nil {
		return nil, nil, err
	}
	info := map[string]MemberUserInfo{}
	if len(items) == 0 {
		return items, info, nil
	}
	ids := make([]string, 0, len(items))
	for _, m := range items {
		ids = append(ids, m.UserID)
	}
	var users []model.User
	if err := s.db.Select("id", "username", "display_name").Where("id IN ?", ids).Find(&users).Error; err != nil {
		return nil, nil, err
	}
	for _, u := range users {
		info[u.ID] = MemberUserInfo{Username: u.Username, DisplayName: u.DisplayName}
	}
	return items, info, nil
}

func (s *ProjectService) UpdateMemberRole(projectID, userID string, role model.ProjectRole) (*model.ProjectMember, error) {
	if !model.IsValidProjectRole(role) {
		return nil, fmt.Errorf("invalid project role: %s", role)
	}
	var member model.ProjectMember
	if err := s.db.Where("project_id = ? AND user_id = ?", projectID, userID).First(&member).Error; err != nil {
		return nil, err
	}
	member.Role = role
	if err := s.db.Save(&member).Error; err != nil {
		return nil, err
	}
	return &member, nil
}

func (s *ProjectService) RemoveMember(projectID, userID string) error {
	return s.db.Unscoped().Where("project_id = ? AND user_id = ?", projectID, userID).Delete(&model.ProjectMember{}).Error
}

// AssertCanChangeMemberRole 变更成员角色：平台 admin / 创建者可改其他人；
// 任何人（含被分享的管理者）都不能改自己的角色；被分享的管理者不能改创建者角色。
func (s *ProjectService) AssertCanChangeMemberRole(actor *model.User, projectID, targetUserID string) error {
	if actor == nil {
		return fmt.Errorf("login required")
	}
	p, err := s.Get(projectID)
	if err != nil {
		return err
	}
	access, err := s.ResolveAccess(actor, projectID)
	if err != nil {
		return err
	}
	if actor.ID == targetUserID && !access.IsPlatformAdmin {
		return fmt.Errorf("cannot change your own role")
	}
	if access.IsPlatformAdmin || actor.ID == p.CreatedBy {
		return nil
	}
	if !access.CanManageMembers() {
		return fmt.Errorf("permission denied: project owner or admin required")
	}
	if targetUserID == p.CreatedBy {
		return fmt.Errorf("cannot change the project creator's role")
	}
	return nil
}

// AssertCanRemoveMember 移除成员：创建者可移除除自己外任何人；被分享的管理者只能移除只读/编辑；创建者不可被移除。
func (s *ProjectService) AssertCanRemoveMember(actor *model.User, projectID, targetUserID string) error {
	if actor == nil {
		return fmt.Errorf("login required")
	}
	p, err := s.Get(projectID)
	if err != nil {
		return err
	}
	if targetUserID == p.CreatedBy {
		return fmt.Errorf("cannot remove the project creator")
	}
	access, err := s.ResolveAccess(actor, projectID)
	if err != nil {
		return err
	}
	if access.IsPlatformAdmin || actor.ID == p.CreatedBy {
		return nil
	}
	if !access.CanManageMembers() {
		return fmt.Errorf("permission denied: project owner or admin required")
	}
	role, ok, err := s.GetMemberRole(projectID, targetUserID)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("member not found")
	}
	if role == model.ProjectRoleOwner {
		return fmt.Errorf("managers can only remove viewers and editors")
	}
	return nil
}

// GetMemberRole 返回用户在项目中的成员角色；不是成员时返回 (\"\", false, nil)。
func (s *ProjectService) GetMemberRole(projectID, userID string) (model.ProjectRole, bool, error) {
	if projectID == "" || userID == "" {
		return "", false, nil
	}
	var member model.ProjectMember
	err := s.db.Where("project_id = ? AND user_id = ?", projectID, userID).First(&member).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return member.Role, true, nil
}

// DefaultProjectID 返回默认项目（IO-Eval）ID，带内存缓存。
func (s *ProjectService) DefaultProjectID() (string, error) {
	if s.defaultProjectID != "" {
		return s.defaultProjectID, nil
	}
	var p model.Project
	if err := s.db.Where("is_default = ?", true).First(&p).Error; err != nil {
		return "", err
	}
	s.defaultProjectID = p.ID
	return p.ID, nil
}

// SeedDefaultAndBackfill 幂等地：
//  1. 若不存在默认项目（IO-Eval），则创建之；
//  2. 把平台 bootstrap 管理员（ownerUsername，通常是 ioadmin）设为其 owner 成员；
//  3. 把所有业务表中 project_id 为空的历史记录回填指向默认项目。
//
// 每次启动都会调用，已完成的步骤不会重复产生副作用（Owner 成员用 FirstOrCreate 语义，
// 回填只更新 project_id 为空的行）。
func (s *ProjectService) SeedDefaultAndBackfill(ownerUsername string) error {
	var proj model.Project
	err := s.db.Where("is_default = ?", true).First(&proj).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		proj = model.Project{
			ID:         util.NewID("proj"),
			Name:       model.DefaultProjectName,
			Visibility: model.ProjectVisibilityPublic,
			IsDefault:  true,
		}
		if ownerUsername != "" {
			var owner model.User
			if err := s.db.Where("username = ?", ownerUsername).First(&owner).Error; err == nil {
				proj.CreatedBy = owner.ID
			}
		}
		if err := s.db.Create(&proj).Error; err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	s.defaultProjectID = proj.ID

	// 历史数据无 visibility：一律视为公开，保持「原先人人可读」不收紧。
	if err := s.db.Model(&model.Project{}).
		Where("visibility IS NULL OR visibility = ?", "").
		Update("visibility", model.ProjectVisibilityPublic).Error; err != nil {
		return err
	}
	// 默认空间保持公开，供游客只读兜底。
	if err := s.db.Model(&model.Project{}).Where("id = ?", proj.ID).
		Update("visibility", model.ProjectVisibilityPublic).Error; err != nil {
		return err
	}

	if ownerUsername != "" {
		var owner model.User
		if err := s.db.Where("username = ?", ownerUsername).First(&owner).Error; err == nil {
			var member model.ProjectMember
			err := s.db.Where("project_id = ? AND user_id = ?", proj.ID, owner.ID).First(&member).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				if err := s.db.Create(&model.ProjectMember{
					ID:        util.NewID("pm"),
					ProjectID: proj.ID,
					UserID:    owner.ID,
					Role:      model.ProjectRoleOwner,
				}).Error; err != nil {
					return err
				}
			} else if err != nil {
				return err
			}
		}
	}

	tables := []any{
		&model.TargetEndpoint{}, &model.EvalEndpoint{}, &model.EvalPrompt{},
		&model.MCPConfig{}, &model.SkillConfig{}, &model.RuntimeEnvConfig{},
		&model.CaseSet{}, &model.EvalRun{}, &model.Task{}, &model.FileObject{},
	}
	for _, t := range tables {
		if err := s.db.Model(t).Where("project_id = ? OR project_id IS NULL", "").Update("project_id", proj.ID).Error; err != nil {
			return err
		}
	}
	return nil
}

// ---- 项目角色 / 权限判定 ----

// EffectiveAccess 描述某用户在某项目下的有效访问能力。
type EffectiveAccess struct {
	IsPlatformAdmin bool
	IsMember        bool
	IsPublic        bool
	Role            model.ProjectRole // 非成员时为空串
}

// CanRead 公开空间任何人（含游客）可读；私有空间仅成员或平台 admin。
func (a EffectiveAccess) CanRead() bool {
	return a.IsPlatformAdmin || a.IsMember || a.IsPublic
}

// CanWrite 平台 admin，或项目 owner/editor 可写。
func (a EffectiveAccess) CanWrite() bool {
	if a.IsPlatformAdmin {
		return true
	}
	return a.Role == model.ProjectRoleOwner || a.Role == model.ProjectRoleEditor
}

// CanExport 平台 admin，或项目 owner/editor/viewer（即任意成员）可下载导出；公开空间的非成员/游客不可。
func (a EffectiveAccess) CanExport() bool {
	if a.IsPlatformAdmin {
		return true
	}
	return a.IsMember
}

// CanManageMembers 平台 admin，或项目 owner 可管理成员与公开性。
func (a EffectiveAccess) CanManageMembers() bool {
	if a.IsPlatformAdmin {
		return true
	}
	return a.Role == model.ProjectRoleOwner
}

// ResolveAccess 结合平台角色（admin 超级权限）、项目公开性与成员角色，得出有效访问能力。
// user 为 nil 表示未登录访客。平台 admin 仍填充成员 Role（若有），便于前端展示「管理」入口。
func (s *ProjectService) ResolveAccess(user *model.User, projectID string) (EffectiveAccess, error) {
	if projectID == "" {
		return EffectiveAccess{}, nil
	}
	p, err := s.Get(projectID)
	if err != nil {
		return EffectiveAccess{}, err
	}
	access := EffectiveAccess{IsPublic: p.IsPublicSpace()}
	if user == nil {
		return access, nil
	}
	role, isMember, err := s.GetMemberRole(projectID, user.ID)
	if err != nil {
		return EffectiveAccess{}, err
	}
	access.IsMember = isMember
	access.Role = role
	if user.Role == model.RoleAdmin && user.Status == model.UserActive {
		access.IsPlatformAdmin = true
	}
	return access, nil
}

