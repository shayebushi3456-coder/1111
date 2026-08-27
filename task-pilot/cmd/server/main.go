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
	if err := evalEndpointService.SeedDefault(); err != nil {
		log.Printf("seed default eval endpoint failed: %v", err)
	}
	caseSetService := service.NewCaseSetService(database)
	promptService := service.NewPromptService(database)
	if err := promptService.SeedDefault(); err != nil {
		log.Printf("seed default eval prompt failed: %v", err)
	}
	mcpConfigService := service.NewMCPConfigService(database)
	skillConfigService := service.NewSkillConfigService(database)
	envVarService := service.NewEnvVarService(database, cfg)
	evalService := service.NewEvalService(database, cfg, taskService, caseSetService, configService, evalEndpointService, fileService, promptService, mcpConfigService, skillConfigService, envVarService)
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
		api.NewConfigHandler(configService),
		api.NewEvalEndpointHandler(evalEndpointService),
		api.NewCaseSetHandler(caseSetService),
		api.NewEvalHandler(evalService),
		api.NewPromptHandler(promptService),
		api.NewLeaderboardHandler(evalService),
		api.NewMCPConfigHandler(mcpConfigService),
		api.NewSkillConfigHandler(skillConfigService),
		api.NewEnvVarHandler(envVarService),
	)
	log.Printf("task-pilot listening on %s", cfg.Server.Addr)
	if err := router.Run(cfg.Server.Addr); err != nil {
		log.Fatalf("server stopped: %v", err)
	}
}
