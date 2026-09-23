package api

import (
	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

func NewRouter(handler *Handler, authHandler *AuthHandler, admin *AdminHandler, auth *service.AuthService, config *ConfigHandler, evalEndpoint *EvalEndpointHandler, caseset *CaseSetHandler, eval *EvalHandler, prompt *PromptHandler, leaderboard *LeaderboardHandler, mcpConfig *MCPConfigHandler, skillConfig *SkillConfigHandler, runtimeEnvConfig *RuntimeEnvConfigHandler, project *ProjectHandler, projects *service.ProjectService) *gin.Engine {
	r := gin.Default()
	r.GET("/healthz", handler.Healthz)

	v1 := r.Group("/api/v1")
	v1.Use(AuthMiddleware(auth))
	{
		v1.GET("/auth/me", authHandler.Me)
		v1.POST("/auth/register", authHandler.Register)
		v1.POST("/auth/login", authHandler.Login)
		v1.POST("/auth/logout", authHandler.Logout)

		v1.GET("/projects", project.List)
		v1.POST("/projects", project.Create)
		v1.GET("/projects/:id", project.Get)
		v1.PUT("/projects/:id", project.Update)
		v1.DELETE("/projects/:id", project.Delete)
		v1.GET("/projects/:id/members", project.ListMembers)
		v1.POST("/projects/:id/members", project.AddMember)
		v1.PUT("/projects/:id/members/:user_id", project.UpdateMemberRole)
		v1.DELETE("/projects/:id/members/:user_id", project.RemoveMember)
		v1.GET("/users/search", project.SearchUsers)

		// 执行器上传产物：不经 ProjectContext。
		v1.POST("/tasks/:id/artifacts", handler.UploadArtifact)

		v1.Use(ProjectContext(projects))

		v1.POST("/files/upload", RequirePermission(service.PermCaseSetWrite), RequireProjectWrite(), handler.UploadFile)
		v1.GET("/files", handler.ListFiles)
		v1.GET("/files/:id", handler.GetFile)
		v1.GET("/files/:id/download", handler.DownloadFile)
		v1.DELETE("/files/:id", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), handler.DeleteFile)
		v1.POST("/tasks", RequirePermission(service.PermEvalRunCreate), RequireProjectWrite(), handler.CreateTask)
		v1.GET("/tasks", RequirePermission(service.PermEvalRunRead), handler.ListTasks)
		v1.GET("/tasks/:id", handler.GetTask)
		v1.GET("/tasks/:id/logs", handler.Logs)
		v1.POST("/tasks/:id/cancel", RequirePermission(service.PermEvalRunStop), RequireProjectWrite(), handler.CancelTask)
		v1.POST("/tasks/:id/retry", RequirePermission(service.PermEvalRunCreate), RequireProjectWrite(), handler.RetryTask)
		v1.GET("/tasks/:id/artifacts", handler.ListArtifacts)

		v1.GET("/config/target-endpoints", config.List)
		v1.POST("/config/target-endpoints", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), config.Create)
		v1.GET("/config/target-endpoints/:id", config.Get)
		v1.PUT("/config/target-endpoints/:id", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), config.Update)
		v1.DELETE("/config/target-endpoints/:id", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), config.Delete)

		v1.GET("/config/eval-endpoints", evalEndpoint.List)
		v1.POST("/config/eval-endpoints", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), evalEndpoint.Create)
		v1.GET("/config/eval-endpoints/:id", evalEndpoint.Get)
		v1.PUT("/config/eval-endpoints/:id", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), evalEndpoint.Update)
		v1.DELETE("/config/eval-endpoints/:id", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), evalEndpoint.Delete)

		v1.POST("/case-sets", RequirePermission(service.PermCaseSetWrite), RequireProjectWrite(), caseset.Create)
		v1.GET("/case-sets", caseset.List)
		v1.GET("/case-sets/:id", caseset.Get)
		v1.PUT("/case-sets/:id", RequirePermission(service.PermCaseSetWrite), RequireProjectWrite(), caseset.Update)
		v1.DELETE("/case-sets/:id", RequirePermission(service.PermCaseSetWrite), RequireProjectWrite(), caseset.Delete)

		v1.POST("/eval-runs", RequirePermission(service.PermEvalRunCreate), RequireProjectWrite(), eval.Create)
		v1.GET("/eval-runs", eval.List)
		v1.GET("/eval-runs/running", eval.Running)
		v1.GET("/eval-runs/:id", eval.Get)
		v1.GET("/eval-runs/:id/results", eval.Results)
		v1.POST("/eval-runs/:id/stop", RequirePermission(service.PermEvalRunStop), RequireProjectWrite(), eval.Stop)
		v1.POST("/eval-runs/:id/case-executions/:ce_id/reeval", RequirePermission(service.PermEvalRunCreate), RequireProjectWrite(), eval.ReEval)
		v1.DELETE("/eval-runs/:id", RequirePermission(service.PermEvalRunDelete), RequireProjectWrite(), eval.Delete)

		v1.POST("/eval-prompts", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), prompt.Create)
		v1.GET("/eval-prompts", prompt.List)
		v1.GET("/eval-prompts/:id", prompt.Get)
		v1.PUT("/eval-prompts/:id", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), prompt.Update)
		v1.DELETE("/eval-prompts/:id", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), prompt.Delete)

		v1.GET("/leaderboard", leaderboard.Get)

		v1.GET("/config/mcp-servers", mcpConfig.List)
		v1.POST("/config/mcp-servers", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), mcpConfig.Create)
		v1.GET("/config/mcp-servers/:id", mcpConfig.Get)
		v1.PUT("/config/mcp-servers/:id", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), mcpConfig.Update)
		v1.DELETE("/config/mcp-servers/:id", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), mcpConfig.Delete)

		v1.GET("/config/skills", skillConfig.List)
		v1.POST("/config/skills", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), skillConfig.Create)
		v1.GET("/config/skills/:id", skillConfig.Get)
		v1.PUT("/config/skills/:id", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), skillConfig.Update)
		v1.DELETE("/config/skills/:id", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), skillConfig.Delete)

		v1.GET("/config/runtime-envs", runtimeEnvConfig.List)
		v1.POST("/config/runtime-envs", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), runtimeEnvConfig.Create)
		v1.GET("/config/runtime-envs/:id", runtimeEnvConfig.Get)
		v1.PUT("/config/runtime-envs/:id", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), runtimeEnvConfig.Update)
		v1.DELETE("/config/runtime-envs/:id", RequirePermission(service.PermConfigWrite), RequireProjectWrite(), runtimeEnvConfig.Delete)

		adminGroup := v1.Group("/admin", RequirePermission(service.PermUserRead))
		adminGroup.GET("/users", admin.ListUsers)
		adminGroup.POST("/users/:id/approve", RequirePermission(service.PermUserApprove), admin.Approve)
		adminGroup.POST("/users/:id/reject", RequirePermission(service.PermUserApprove), admin.Reject)
		adminGroup.PUT("/users/:id/role", RequirePermission(service.PermUserUpdateRole), admin.UpdateRole)
		adminGroup.POST("/users/:id/disable", RequirePermission(service.PermUserDisable), admin.Disable)
		adminGroup.POST("/users/:id/enable", RequirePermission(service.PermUserDisable), admin.Enable)
	}

	return r
}
