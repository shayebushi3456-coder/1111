package api

import (
	"net/http"

	"task-pilot/internal/model"
	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

// ProjectHandler 项目空间 CRUD + 成员管理。
type ProjectHandler struct {
	projects *service.ProjectService
}

func NewProjectHandler(projects *service.ProjectService) *ProjectHandler {
	return &ProjectHandler{projects: projects}
}

func toProjectResponse(p *model.Project, myRole model.ProjectRole) ProjectResponse {
	vis := string(p.Visibility)
	if vis == "" {
		vis = string(model.ProjectVisibilityPublic)
	}
	resp := ProjectResponse{
		ID:                   p.ID,
		Name:                 p.Name,
		Description:          p.Description,
		Visibility:           vis,
		IsDefault:            p.IsDefault,
		PrestartScriptFileID: p.PrestartScriptFileID,
		CreatedBy:            p.CreatedBy,
		CreatedAt:            p.CreatedAt,
		UpdatedAt:            p.UpdatedAt,
	}
	if myRole != "" {
		resp.MyRole = string(myRole)
	}
	return resp
}

func toProjectMemberResponse(m *model.ProjectMember, info service.MemberUserInfo) ProjectMemberResponse {
	return ProjectMemberResponse{
		ID:          m.ID,
		ProjectID:   m.ProjectID,
		UserID:      m.UserID,
		Username:    info.Username,
		DisplayName: info.DisplayName,
		Role:        string(m.Role),
		CreatedAt:   m.CreatedAt,
	}
}

func (h *ProjectHandler) projectResponseFor(c *gin.Context, p *model.Project) (ProjectResponse, error) {
	user, _ := CurrentUser(c)
	access, err := h.projects.ResolveAccess(user, p.ID)
	if err != nil {
		return ProjectResponse{}, err
	}
	return toProjectResponse(p, access.Role), nil
}

// List 可见项目：公开 ∪ 成员 ∪ admin 全量。
func (h *ProjectHandler) List(c *gin.Context) {
	user, _ := CurrentUser(c)
	items, err := h.projects.ListVisible(user)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	out := make([]ProjectResponse, 0, len(items))
	for i := range items {
		resp, err := h.projectResponseFor(c, &items[i])
		if err != nil {
			c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
			return
		}
		out = append(out, resp)
	}
	c.JSON(http.StatusOK, ProjectListResponse{Projects: out})
}

// Create 任意 active 用户均可创建项目，自动成为 owner；默认私有。
func (h *ProjectHandler) Create(c *gin.Context) {
	user, ok := requireActiveUser(c)
	if !ok {
		return
	}
	var req CreateProjectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	p, err := h.projects.Create(user, service.CreateProjectInput{
		Name:                 req.Name,
		Description:          req.Description,
		Visibility:           model.ProjectVisibility(req.Visibility),
		PrestartScriptFileID: req.PrestartScriptFileID,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, toProjectResponse(p, model.ProjectRoleOwner))
}

// Get 项目详情：须对该空间有读权限。
func (h *ProjectHandler) Get(c *gin.Context) {
	p, err := h.projects.Get(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResponse{Error: err.Error()})
		return
	}
	user, _ := CurrentUser(c)
	access, err := h.projects.ResolveAccess(user, p.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	if !access.CanRead() {
		c.JSON(http.StatusForbidden, ErrorResponse{Error: "permission denied: project read required", Code: "PROJECT_PERMISSION_DENIED"})
		return
	}
	c.JSON(http.StatusOK, toProjectResponse(p, access.Role))
}

// Update 更新项目信息：owner/editor 可改名称描述；改公开性仅 owner/admin。
func (h *ProjectHandler) Update(c *gin.Context) {
	access, err := h.resolveAccessForParam(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	if !access.CanWrite() {
		c.JSON(http.StatusForbidden, ErrorResponse{Error: "permission denied: project write required", Code: "PROJECT_PERMISSION_DENIED"})
		return
	}
	var req UpdateProjectRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	if req.Visibility != "" && !access.CanManageMembers() {
		c.JSON(http.StatusForbidden, ErrorResponse{Error: "permission denied: only owner can change visibility", Code: "PROJECT_PERMISSION_DENIED"})
		return
	}
	p, err := h.projects.Update(c.Param("id"), service.UpdateProjectInput{
		Name:                 req.Name,
		Description:          req.Description,
		Visibility:           model.ProjectVisibility(req.Visibility),
		PrestartScriptFileID: req.PrestartScriptFileID,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, toProjectResponse(p, access.Role))
}

// Delete 物理删除项目：仅项目 owner 或平台 admin；默认项目 IO-Eval 禁止删除。
func (h *ProjectHandler) Delete(c *gin.Context) {
	access, err := h.resolveAccessForParam(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	if !access.CanManageMembers() {
		c.JSON(http.StatusForbidden, ErrorResponse{Error: "permission denied: project owner or admin required", Code: "PROJECT_PERMISSION_DENIED"})
		return
	}
	if err := h.projects.Delete(c.Param("id")); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}

// ListMembers 成员列表：须可读。
func (h *ProjectHandler) ListMembers(c *gin.Context) {
	access, err := h.resolveAccessForParam(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	if !access.CanRead() {
		c.JSON(http.StatusForbidden, ErrorResponse{Error: "permission denied: project read required", Code: "PROJECT_PERMISSION_DENIED"})
		return
	}
	items, info, err := h.projects.ListMembersDetailed(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	out := make([]ProjectMemberResponse, 0, len(items))
	for i := range items {
		out = append(out, toProjectMemberResponse(&items[i], info[items[i].UserID]))
	}
	c.JSON(http.StatusOK, ProjectMemberListResponse{Members: out})
}

// AddMember 新增/更新成员角色：仅项目 owner 或平台 admin；支持 username 或 user_id。
func (h *ProjectHandler) AddMember(c *gin.Context) {
	access, err := h.resolveAccessForParam(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	if !access.CanManageMembers() {
		c.JSON(http.StatusForbidden, ErrorResponse{Error: "permission denied: project owner or admin required", Code: "PROJECT_PERMISSION_DENIED"})
		return
	}
	var req AddProjectMemberRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	uid, err := h.projects.ResolveUserID(req.UserID, req.Username)
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	user, _ := CurrentUser(c)
	// 若目标已是成员，等同改角色，套用创建者保护规则。
	if _, ok, _ := h.projects.GetMemberRole(c.Param("id"), uid); ok {
		if err := h.projects.AssertCanChangeMemberRole(user, c.Param("id"), uid); err != nil {
			c.JSON(http.StatusForbidden, ErrorResponse{Error: err.Error(), Code: "PROJECT_PERMISSION_DENIED"})
			return
		}
	}
	m, err := h.projects.AddMember(c.Param("id"), uid, model.ProjectRole(req.Role))
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	_, info, _ := h.projects.ListMembersDetailed(c.Param("id"))
	c.JSON(http.StatusCreated, toProjectMemberResponse(m, info[m.UserID]))
}

// UpdateMemberRole 变更成员角色：仅项目 owner 或平台 admin。
func (h *ProjectHandler) UpdateMemberRole(c *gin.Context) {
	access, err := h.resolveAccessForParam(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	if !access.CanManageMembers() {
		c.JSON(http.StatusForbidden, ErrorResponse{Error: "permission denied: project owner or admin required", Code: "PROJECT_PERMISSION_DENIED"})
		return
	}
	var req UpdateProjectMemberRoleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	user, _ := CurrentUser(c)
	if err := h.projects.AssertCanChangeMemberRole(user, c.Param("id"), c.Param("user_id")); err != nil {
		c.JSON(http.StatusForbidden, ErrorResponse{Error: err.Error(), Code: "PROJECT_PERMISSION_DENIED"})
		return
	}
	m, err := h.projects.UpdateMemberRole(c.Param("id"), c.Param("user_id"), model.ProjectRole(req.Role))
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	_, info, _ := h.projects.ListMembersDetailed(c.Param("id"))
	c.JSON(http.StatusOK, toProjectMemberResponse(m, info[m.UserID]))
}

// RemoveMember 移除成员：仅项目 owner 或平台 admin。
func (h *ProjectHandler) RemoveMember(c *gin.Context) {
	access, err := h.resolveAccessForParam(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	if !access.CanManageMembers() {
		c.JSON(http.StatusForbidden, ErrorResponse{Error: "permission denied: project owner or admin required", Code: "PROJECT_PERMISSION_DENIED"})
		return
	}
	user, _ := CurrentUser(c)
	if err := h.projects.AssertCanRemoveMember(user, c.Param("id"), c.Param("user_id")); err != nil {
		c.JSON(http.StatusForbidden, ErrorResponse{Error: err.Error(), Code: "PROJECT_PERMISSION_DENIED"})
		return
	}
	if err := h.projects.RemoveMember(c.Param("id"), c.Param("user_id")); err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "removed"})
}

// SearchUsers 按账号查找活跃用户（分享用）。须登录；结果不含当前用户自己。
func (h *ProjectHandler) SearchUsers(c *gin.Context) {
	user, ok := requireActiveUser(c)
	if !ok {
		return
	}
	users, err := h.projects.SearchUsers(c.Query("q"), 20, user.ID)
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	out := make([]UserSearchItem, 0, len(users))
	for _, u := range users {
		out = append(out, UserSearchItem{ID: u.ID, Username: u.Username, DisplayName: u.DisplayName})
	}
	c.JSON(http.StatusOK, UserSearchResponse{Users: out})
}

// resolveAccessForParam 项目管理类接口操作的是 URL :id，而非 header 当前项目。
func (h *ProjectHandler) resolveAccessForParam(c *gin.Context) (service.EffectiveAccess, error) {
	user, _ := CurrentUser(c)
	return h.projects.ResolveAccess(user, c.Param("id"))
}
