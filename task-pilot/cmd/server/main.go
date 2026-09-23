package main

import (
	"context"
	"log"
	"time"

	"task-pilot/internal/api"
	"task-pilot/internal/config"
	"task-pilot/internal/db"
	"task-pilot/internal/filetransfer"
	jobbackend "task-pilot/internal/job"
	"task-pilot/internal/scheduler"
	"task-pilot/internal/service"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config failed: %v", err)
	}
	database, err := db.Open(cfg.Database.Path)
	if err != nil {
		log.Fatalf("open sqlite failed: %v", err)
	}
	jobClient, err := jobbackend.NewClient(cfg.Kubernetes.Kubeconfig)
	if err != nil {
		log.Fatalf("create kubernetes job client failed: %v", err)
	}
	taskService := service.NewTaskService(database, cfg, jobClient)
	fileService := filetransfer.NewService(database, cfg.FileTransfer)
	configService := service.NewConfigService(database, cfg)
	evalEndpointService := service.NewEvalEndpointService(database, cfg)
	caseSetService := service.NewCaseSetService(database)
	promptService := service.NewPromptService(database)
	mcpConfigService := service.NewMCPConfigService(database)
	skillConfigService := service.NewSkillConfigService(database)
	runtimeEnvConfigService := service.NewRuntimeEnvConfigService(database, cfg)
	authService := service.NewAuthService(database)
	if err := authService.BootstrapAdmin(); err != nil {
		log.Printf("bootstrap admin failed: %v", err)
	}
	userAdminService := service.NewUserAdminService(database)

	// 项目空间：先保证默认项目 IO-Eval 存在并把历史空 project_id 数据回填到该项目，
	// 同时把平台 bootstrap 管理员 ioadmin 设为默认项目的 owner；随后才能用默认项目 ID
	// 去做 eval-endpoint / eval-prompt 的按项目 SeedDefault（这两者依赖已存在的项目行）。
	projectService := service.NewProjectService(database)
	if err := projectService.SeedDefaultAndBackfill("ioadmin"); err != nil {
		log.Printf("seed default project and backfill failed: %v", err)
	}
	defaultProjectID, err := projectService.DefaultProjectID()
	if err != nil {
		log.Fatalf("resolve default project id failed: %v", err)
	}
	if err := evalEndpointService.SeedDefault(defaultProjectID); err != nil {
		log.Printf("seed default eval endpoint failed: %v", err)
	}
	if err := promptService.SeedDefault(defaultProjectID); err != nil {
		log.Printf("seed default eval prompt failed: %v", err)
	}
	evalService := service.NewEvalService(database, cfg, taskService, caseSetService, configService, evalEndpointService, fileService, promptService, mcpConfigService, skillConfigService, runtimeEnvConfigService)
	interval := time.Duration(cfg.Scheduler.ReconcileIntervalSeconds) * time.Second
	if interval <= 0 {
		interval = 10 * time.Second
	}
	reconciler := scheduler.NewReconciler(interval).
		Register("task", taskService.ReconcileOnce).
		Register("eval", evalService.ReconcileOnce).
		Register("eval-schedule", evalService.ScheduleOnce)
	go reconciler.Start(context.Background())

	router := api.NewRouter(
		api.NewHandler(taskService, fileService),
		api.NewAuthHandler(authService),
		api.NewAdminHandler(userAdminService),
		authService,
		api.NewConfigHandler(configService),
		api.NewEvalEndpointHandler(evalEndpointService),
		api.NewCaseSetHandler(caseSetService),
		api.NewEvalHandler(evalService),
		api.NewPromptHandler(promptService),
		api.NewLeaderboardHandler(evalService),
		api.NewMCPConfigHandler(mcpConfigService),
		api.NewSkillConfigHandler(skillConfigService),
		api.NewRuntimeEnvConfigHandler(runtimeEnvConfigService),
		api.NewProjectHandler(projectService),
		projectService,
	)
	log.Printf("task-pilot listening on %s", cfg.Server.Addr)
	if err := router.Run(cfg.Server.Addr); err != nil {
		log.Fatalf("server stopped: %v", err)
	}
}
