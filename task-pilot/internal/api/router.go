package api

import "github.com/gin-gonic/gin"

func NewRouter(handler *Handler, config *ConfigHandler, evalEndpoint *EvalEndpointHandler, caseset *CaseSetHandler, eval *EvalHandler, prompt *PromptHandler, leaderboard *LeaderboardHandler, mcpConfig *MCPConfigHandler, skillConfig *SkillConfigHandler, envVar *EnvVarHandler) *gin.Engine {
	r := gin.Default()
	r.GET("/healthz", handler.Healthz)

	v1 := r.Group("/api/v1")
	{
		v1.POST("/files/upload", handler.UploadFile)
		v1.GET("/files/:id/download", handler.DownloadFile)
		v1.POST("/tasks", handler.CreateTask)
		v1.GET("/tasks", handler.ListTasks)
		v1.GET("/tasks/:id", handler.GetTask)
		v1.GET("/tasks/:id/logs", handler.Logs)
		v1.POST("/tasks/:id/cancel", handler.CancelTask)
		v1.POST("/tasks/:id/retry", handler.RetryTask)
		v1.POST("/tasks/:id/artifacts", handler.UploadArtifact)
		v1.GET("/tasks/:id/artifacts", handler.ListArtifacts)

		// 配置中心：被测模型端点（多套）
		v1.GET("/config/target-endpoints", config.List)
		v1.POST("/config/target-endpoints", config.Create)
		v1.GET("/config/target-endpoints/:id", config.Get)
		v1.PUT("/config/target-endpoints/:id", config.Update)
		v1.DELETE("/config/target-endpoints/:id", config.Delete)

		// 配置中心：评测模型端点（多套，配置方式与被测端点一致）
		v1.GET("/config/eval-endpoints", evalEndpoint.List)
		v1.POST("/config/eval-endpoints", evalEndpoint.Create)
		v1.GET("/config/eval-endpoints/:id", evalEndpoint.Get)
		v1.PUT("/config/eval-endpoints/:id", evalEndpoint.Update)
		v1.DELETE("/config/eval-endpoints/:id", evalEndpoint.Delete)

		// 用例集
		v1.POST("/case-sets", caseset.Create)
		v1.GET("/case-sets", caseset.List)
		v1.GET("/case-sets/:id", caseset.Get)
		v1.PUT("/case-sets/:id", caseset.Update)
		v1.DELETE("/case-sets/:id", caseset.Delete)

		// 执行任务（EvalRun）
		v1.POST("/eval-runs", eval.Create)
		v1.GET("/eval-runs", eval.List)
		// 注意：/running 必须注册在 /:id 之前，否则 running 会被当作 id 匹配。
		v1.GET("/eval-runs/running", eval.Running)
		v1.GET("/eval-runs/:id", eval.Get)
		v1.GET("/eval-runs/:id/results", eval.Results)
		v1.POST("/eval-runs/:id/stop", eval.Stop)
		v1.DELETE("/eval-runs/:id", eval.Delete)

		// 评测 Prompt（用户自定义：上传/查看/修改/删除）
		v1.POST("/eval-prompts", prompt.Create)
		v1.GET("/eval-prompts", prompt.List)
		v1.GET("/eval-prompts/:id", prompt.Get)
		v1.PUT("/eval-prompts/:id", prompt.Update)
		v1.DELETE("/eval-prompts/:id", prompt.Delete)

		// 被测模型 Leaderboard：按机评均分聚合排名
		v1.GET("/leaderboard", leaderboard.Get)

		// MCP Server 配置（多套，供用例绑定；派发测试任务前还原为 Pod 内 .mcp.json）
		v1.GET("/config/mcp-servers", mcpConfig.List)
		v1.POST("/config/mcp-servers", mcpConfig.Create)
		v1.GET("/config/mcp-servers/:id", mcpConfig.Get)
		v1.PUT("/config/mcp-servers/:id", mcpConfig.Update)
		v1.DELETE("/config/mcp-servers/:id", mcpConfig.Delete)

		// Skill 配置（多套，供用例绑定；派发测试任务前还原为 Pod 内 ~/.claude/skills/<name>/）
		v1.GET("/config/skills", skillConfig.List)
		v1.POST("/config/skills", skillConfig.Create)
		v1.GET("/config/skills/:id", skillConfig.Get)
		v1.PUT("/config/skills/:id", skillConfig.Update)
		v1.DELETE("/config/skills/:id", skillConfig.Delete)

		// 全局环境变量（加密存储；用例描述用 {{KEY}} 引用，派发测试任务时替换）
		v1.GET("/config/env-vars", envVar.List)
		v1.POST("/config/env-vars", envVar.Create)
		v1.GET("/config/env-vars/:id", envVar.Get)
		v1.PUT("/config/env-vars/:id", envVar.Update)
		v1.DELETE("/config/env-vars/:id", envVar.Delete)
	}
	return r
}
