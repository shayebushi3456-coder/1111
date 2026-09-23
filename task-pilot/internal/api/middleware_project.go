package api

import (
	"net/http"
	"strings"

	"task-pilot/internal/model"
	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

const currentProjectIDKey = "current_project_id"
const currentProjectAccessKey = "current_project_access"

// ProjectContext 解析当前请求所属项目：优先读取 X-Project-ID 请求头，
// 其次 project_id 查询参数，都缺省时回退到默认项目（IO-Eval）。
// 同时结合当前登录用户（可能是访客）算出其在该项目下的有效访问能力
// （EffectiveAccess：读/写/导出/成员管理），供后续 RequireProject* 中间件与
// 业务 handler 使用。既有 API 路径不变，项目上下文只通过 header/query 传递。
func ProjectContext(projects *service.ProjectService) gin.HandlerFunc {
	return func(c *gin.Context) {
		projectID := c.GetHeader("X-Project-ID")
		if projectID == "" {
			projectID = c.Query("project_id")
		}
		if projectID == "" {
			defID, err := projects.DefaultProjectID()
			if err != nil {
				c.AbortWithStatusJSON(http.StatusInternalServerError, ErrorResponse{Error: "resolve default project: " + err.Error()})
				return
			}
			projectID = defID
		} else {
			if _, err := projects.Get(projectID); err != nil {
				c.AbortWithStatusJSON(http.StatusNotFound, ErrorResponse{Error: "project not found"})
				return
			}
		}

		user, _ := CurrentUser(c)
		access, err := projects.ResolveAccess(user, projectID)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, ErrorResponse{Error: "resolve project access: " + err.Error()})
			return
		}
		if !access.CanRead() {
			// 执行器下载 input 带 task_id（+ X-Task-Token），与当前请求方的项目读权限无关。
			if !(c.Request.Method == http.MethodGet && c.Query("task_id") != "" && strings.HasSuffix(c.Request.URL.Path, "/download")) {
				c.AbortWithStatusJSON(http.StatusForbidden, ErrorResponse{Error: "permission denied: project read required", Code: "PROJECT_PERMISSION_DENIED"})
				return
			}
		}

		c.Set(currentProjectIDKey, projectID)
		c.Set(currentProjectAccessKey, access)
		c.Next()
	}
}

// CurrentProjectID 返回本次请求解析出的当前项目 ID（由 ProjectContext 设置）。
func CurrentProjectID(c *gin.Context) string {
	v, ok := c.Get(currentProjectIDKey)
	if !ok {
		return ""
	}
	id, _ := v.(string)
	return id
}

// CurrentProjectAccess 返回当前用户在当前项目下的有效访问能力。
func CurrentProjectAccess(c *gin.Context) service.EffectiveAccess {
	v, ok := c.Get(currentProjectAccessKey)
	if !ok {
		return service.EffectiveAccess{}
	}
	access, _ := v.(service.EffectiveAccess)
	return access
}

// RequireProjectWrite 要求当前用户对当前项目具有写权限：平台 admin，或项目 owner/editor。
// 非成员/访客/项目 viewer 均被拒绝。必须放在 ProjectContext 之后使用。
func RequireProjectWrite() gin.HandlerFunc {
	return func(c *gin.Context) {
		access := CurrentProjectAccess(c)
		if !access.CanWrite() {
			c.AbortWithStatusJSON(http.StatusForbidden, ErrorResponse{Error: "permission denied: project write required", Code: "PROJECT_PERMISSION_DENIED"})
			return
		}
		c.Next()
	}
}

// RequireProjectExport 要求当前用户对当前项目具有下载/导出权限：平台 admin，
// 或该项目任意角色的成员（owner/editor/viewer）。非成员/访客被拒绝。
func RequireProjectExport() gin.HandlerFunc {
	return func(c *gin.Context) {
		access := CurrentProjectAccess(c)
		if !access.CanExport() {
			c.AbortWithStatusJSON(http.StatusForbidden, ErrorResponse{Error: "permission denied: project export required", Code: "PROJECT_PERMISSION_DENIED"})
			return
		}
		c.Next()
	}
}

// RequireProjectManageMembers 要求当前用户可管理当前项目成员：平台 admin 或项目 owner。
func RequireProjectManageMembers() gin.HandlerFunc {
	return func(c *gin.Context) {
		access := CurrentProjectAccess(c)
		if !access.CanManageMembers() {
			c.AbortWithStatusJSON(http.StatusForbidden, ErrorResponse{Error: "permission denied: project owner or admin required", Code: "PROJECT_PERMISSION_DENIED"})
			return
		}
		c.Next()
	}
}

// requireActiveUser 是项目创建等操作的最低门槛：必须登录且账号状态为 active。
// 与平台角色/项目角色无关——任何 active 用户都可创建项目并成为其 owner。
func requireActiveUser(c *gin.Context) (*model.User, bool) {
	user, ok := CurrentUser(c)
	if !ok {
		c.AbortWithStatusJSON(http.StatusUnauthorized, ErrorResponse{Error: "login required", Code: "LOGIN_REQUIRED"})
		return nil, false
	}
	if user.Status != model.UserActive {
		c.AbortWithStatusJSON(http.StatusForbidden, ErrorResponse{Error: "account not active", Code: "PERMISSION_DENIED"})
		return nil, false
	}
	return user, true
}
