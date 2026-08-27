package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"task-pilot/internal/config"
	jobbackend "task-pilot/internal/job"
	"task-pilot/internal/model"
	"task-pilot/internal/util"
	"gorm.io/gorm"
)

type CreateTaskInput struct {
	RequestID       string
	Name            string
	Namespace       string
	Image           string
	Command         string
	InputFiles      []model.InputFileSpec
	TimeoutSeconds  int64
	Env             map[string]string
	Role            string
	CaseExecutionID string
}

type TaskService struct {
	db        *gorm.DB
	cfg       *config.Config
	jobClient *jobbackend.Client
}

func NewTaskService(db *gorm.DB, cfg *config.Config, jobClient *jobbackend.Client) *TaskService {
	return &TaskService{db: db, cfg: cfg, jobClient: jobClient}
}

func (s *TaskService) CreateTask(ctx context.Context, req CreateTaskInput) (*model.Task, error) {
	if req.RequestID != "" {
		var existing model.Task
		if err := s.db.Where("request_id = ?", req.RequestID).First(&existing).Error; err == nil {
			return &existing, nil
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, err
		}
	}

	taskID := util.NewID("task")
	namespace := req.Namespace
	if namespace == "" {
		namespace = s.cfg.Kubernetes.Namespace
	}
	image := req.Image
	if image == "" {
		image = s.cfg.Kubernetes.DefaultImage
	}
	timeout := req.TimeoutSeconds
	if timeout <= 0 {
		timeout = s.cfg.Kubernetes.DefaultTimeoutSeconds
	}
	// request_id 为空表示"不做幂等"，但 tasks.request_id 有唯一索引，
	// 若直接存空串，多个内部任务（测试/评测）会撞唯一约束。这里生成一个
	// 唯一值入库，保持"每次新建"语义且不冲突；幂等去重仍以调用方传入的值为准。
	requestID := req.RequestID
	if requestID == "" {
		requestID = util.NewID("auto")
	}
	task := &model.Task{
		ID:              taskID,
		RequestID:       requestID,
		Name:            req.Name,
		Namespace:       namespace,
		JobName:         fmt.Sprintf("%s-job", taskID),
		Image:           image,
		Command:         req.Command,
		InputFilesJSON:  model.EncodeInputFiles(req.InputFiles),
		ExtraEnvJSON:    model.EncodeEnv(req.Env),
		Role:            req.Role,
		CaseExecutionID: req.CaseExecutionID,
		Status:          model.TaskStatusCreated,
		TimeoutSeconds:  timeout,
		TaskToken:       util.NewID("token"),
	}
	if err := s.db.Create(task).Error; err != nil {
		return nil, err
	}

	k8sJob := jobbackend.Build(task, s.cfg.Kubernetes, s.cfg.FileTransfer)
	if err := s.jobClient.Create(ctx, k8sJob); err != nil {
		now := time.Now()
		s.db.Model(task).Updates(map[string]any{"status": model.TaskStatusFailed, "error_message": err.Error(), "finished_at": &now})
		return nil, err
	}
	now := time.Now()
	if err := s.db.Model(task).Updates(map[string]any{"status": model.TaskStatusSubmitted, "started_at": &now}).Error; err != nil {
		return nil, err
	}
	return s.GetTask(task.ID)
}

func (s *TaskService) GetTask(id string) (*model.Task, error) {
	var task model.Task
	if err := s.db.First(&task, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &task, nil
}

func (s *TaskService) ValidateTaskToken(taskID, token string) error {
	if token == "" {
		return fmt.Errorf("missing X-Task-Token")
	}
	task, err := s.GetTask(taskID)
	if err != nil {
		return err
	}
	if task.TaskToken == "" || task.TaskToken != token {
		return fmt.Errorf("invalid task token")
	}
	return nil
}

func (s *TaskService) ListTasks() ([]model.Task, error) {
	var tasks []model.Task
	if err := s.db.Order("created_at desc").Limit(100).Find(&tasks).Error; err != nil {
		return nil, err
	}
	return tasks, nil
}

func (s *TaskService) CancelTask(ctx context.Context, id string) (*model.Task, error) {
	task, err := s.GetTask(id)
	if err != nil {
		return nil, err
	}
	if err := s.jobClient.Delete(ctx, task.Namespace, task.JobName); err != nil {
		task.ErrorMessage = err.Error()
	}
	now := time.Now()
	updates := map[string]any{"status": model.TaskStatusCancelled, "finished_at": &now}
	if task.ErrorMessage != "" {
		updates["error_message"] = task.ErrorMessage
	}
	if err := s.db.Model(task).Updates(updates).Error; err != nil {
		return nil, err
	}
	return s.GetTask(id)
}

func (s *TaskService) RetryTask(ctx context.Context, id string) (*model.Task, error) {
	old, err := s.GetTask(id)
	if err != nil {
		return nil, err
	}
	return s.CreateTask(ctx, CreateTaskInput{
		Name:           old.Name + "-retry",
		Namespace:      old.Namespace,
		Image:          old.Image,
		Command:        old.Command,
		InputFiles:     model.DecodeInputFiles(old.InputFilesJSON),
		TimeoutSeconds: old.TimeoutSeconds,
	})
}

func (s *TaskService) LogsSummary(ctx context.Context, id string) (map[string]any, error) {
	task, err := s.GetTask(id)
	if err != nil {
		return nil, err
	}
	podName := task.PodName
	if podName == "" {
		if pod, _ := s.jobClient.FindPod(ctx, task.Namespace, task.ID); pod != nil {
			podName = pod.Name
		}
	}
	logs, logErr := s.jobClient.Logs(ctx, task.Namespace, podName)
	result := map[string]any{
		"task_id":          task.ID,
		"job_name":         task.JobName,
		"pod_name":         podName,
		"kubectl_get_job":  fmt.Sprintf("kubectl get job %s -n %s -o yaml", task.JobName, task.Namespace),
		"kubectl_get_pods": fmt.Sprintf("kubectl get pods -n %s -l task-id=%s", task.Namespace, task.ID),
		"kubectl_logs":     fmt.Sprintf("kubectl logs -n %s -l task-id=%s --all-containers=true", task.Namespace, task.ID),
	}
	if logErr != nil {
		result["message"] = "无法读取 Pod 日志，可使用 kubectl_logs 命令排查"
		result["error"] = logErr.Error()
	} else {
		result["logs"] = logs
	}
	return result, nil
}

// FetchLogs 尽力返回某任务 executor 容器的最近日志（失败返回空串，不报错）。
// 供评测阶段把测试过程作为评测输入使用。
func (s *TaskService) FetchLogs(ctx context.Context, id string) string {
	task, err := s.GetTask(id)
	if err != nil {
		return ""
	}
	podName := task.PodName
	if podName == "" {
		if pod, _ := s.jobClient.FindPod(ctx, task.Namespace, task.ID); pod != nil {
			podName = pod.Name
		}
	}
	logs, err := s.jobClient.Logs(ctx, task.Namespace, podName)
	if err != nil {
		return ""
	}
	return logs
}

func (s *TaskService) ReconcileOnce(ctx context.Context) error {
	var tasks []model.Task
	if err := s.db.Where("status IN ?", []model.TaskStatus{model.TaskStatusSubmitted, model.TaskStatusRunning}).Find(&tasks).Error; err != nil {
		return err
	}
	for i := range tasks {
		task := tasks[i]
		status, err := s.jobClient.Status(ctx, task.Namespace, task.JobName, task.ID)
		if err != nil {
			continue
		}
		updates := map[string]any{}
		if status.PodName != "" {
			updates["pod_name"] = status.PodName
		}
		if status.ExitCode != nil {
			updates["exit_code"] = *status.ExitCode
		}
		switch status.Phase {
		case jobbackend.PhasePending, jobbackend.PhaseRunning:
			updates["status"] = model.TaskStatusRunning
		case jobbackend.PhaseSucceeded:
			updates["status"] = model.TaskStatusSucceeded
			now := time.Now()
			updates["finished_at"] = &now
		case jobbackend.PhaseFailed:
			updates["status"] = model.TaskStatusFailed
			updates["error_message"] = status.Message
			now := time.Now()
			updates["finished_at"] = &now
		}
		if len(updates) > 0 {
			_ = s.db.Model(&task).Updates(updates).Error
		}
	}
	return nil
}
