package model

import (
	"encoding/json"
	"time"

	"gorm.io/gorm"
)

type TaskStatus string

const (
	TaskStatusCreated   TaskStatus = "CREATED"
	TaskStatusSubmitted TaskStatus = "SUBMITTED"
	TaskStatusRunning   TaskStatus = "RUNNING"
	TaskStatusSucceeded TaskStatus = "SUCCEEDED"
	TaskStatusFailed    TaskStatus = "FAILED"
	TaskStatusCancelled TaskStatus = "CANCELLED"
)

type InputFileSpec struct {
	FileID    string `json:"file_id"`
	Filename  string `json:"filename"`
	MountPath string `json:"mount_path"`
}

type Task struct {
	ID              string         `gorm:"primaryKey;size:64" json:"id"`
	RequestID       string         `gorm:"uniqueIndex;size:128" json:"request_id"`
	Name            string         `gorm:"size:128" json:"name"`
	Namespace       string         `gorm:"size:128" json:"namespace"`
	JobName         string         `gorm:"index;size:128" json:"job_name"`
	PodName         string         `gorm:"index;size:128" json:"pod_name,omitempty"`
	Image           string         `gorm:"size:256" json:"image"`
	Command         string         `gorm:"type:text" json:"command"`
	InputFilesJSON  string         `gorm:"type:text" json:"-"`
	ExtraEnvJSON    string         `gorm:"type:text" json:"-"`
	Role            string         `gorm:"size:16;index" json:"role,omitempty"`
	CaseExecutionID string         `gorm:"index;size:64" json:"case_execution_id,omitempty"`
	Status          TaskStatus     `gorm:"size:32;index" json:"status"`
	ExitCode        *int           `json:"exit_code,omitempty"`
	ErrorMessage    string         `gorm:"type:text" json:"error_message,omitempty"`
	TimeoutSeconds  int64          `json:"timeout_seconds"`
	TaskToken       string         `gorm:"size:128" json:"-"`
	CreatedAt       time.Time      `json:"created_at"`
	UpdatedAt       time.Time      `json:"updated_at"`
	StartedAt       *time.Time     `json:"started_at,omitempty"`
	FinishedAt      *time.Time     `json:"finished_at,omitempty"`
	DeletedAt       gorm.DeletedAt `gorm:"index" json:"-"`
}

func EncodeInputFiles(files []InputFileSpec) string {
	if len(files) == 0 {
		return ""
	}
	data, err := json.Marshal(files)
	if err != nil {
		return ""
	}
	return string(data)
}

func DecodeInputFiles(raw string) []InputFileSpec {
	if raw == "" {
		return nil
	}
	var files []InputFileSpec
	if err := json.Unmarshal([]byte(raw), &files); err != nil {
		return nil
	}
	return files
}

// EncodeEnv 将附加环境变量序列化存储。用于向执行器 Pod 注入被测端点参数。
func EncodeEnv(env map[string]string) string {
	if len(env) == 0 {
		return ""
	}
	data, err := json.Marshal(env)
	if err != nil {
		return ""
	}
	return string(data)
}

// DecodeEnv 反序列化附加环境变量。
func DecodeEnv(raw string) map[string]string {
	if raw == "" {
		return nil
	}
	var env map[string]string
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		return nil
	}
	return env
}
