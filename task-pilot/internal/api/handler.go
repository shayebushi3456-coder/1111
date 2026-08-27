package api

import (
	"net/http"

	"task-pilot/internal/filetransfer"
	"task-pilot/internal/model"
	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

type Handler struct {
	tasks *service.TaskService
	files *filetransfer.Service
}

func NewHandler(tasks *service.TaskService, files *filetransfer.Service) *Handler {
	return &Handler{tasks: tasks, files: files}
}

func (h *Handler) Healthz(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "ok", "name": "task-pilot"})
}

func (h *Handler) UploadFile(c *gin.Context) {
	purpose := model.FilePurpose(c.DefaultPostForm("purpose", string(model.FilePurposeInput)))
	if purpose != model.FilePurposeInput && purpose != model.FilePurposeArtifact {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: "purpose must be input or artifact"})
		return
	}
	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	obj, err := h.files.SaveUpload(fileHeader, purpose, c.PostForm("task_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, toFileResponse(obj))
}

func (h *Handler) DownloadFile(c *gin.Context) {
	if taskID := c.Query("task_id"); taskID != "" {
		if err := h.tasks.ValidateTaskToken(taskID, c.GetHeader("X-Task-Token")); err != nil {
			c.JSON(http.StatusUnauthorized, ErrorResponse{Error: err.Error()})
			return
		}
	}
	obj, file, err := h.files.Open(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResponse{Error: err.Error()})
		return
	}
	defer file.Close()
	c.Header("Content-Disposition", "attachment; filename=\""+obj.Filename+"\"")
	c.File(obj.Path)
}

func (h *Handler) UploadArtifact(c *gin.Context) {
	taskID := c.Param("id")
	if err := h.tasks.ValidateTaskToken(taskID, c.GetHeader("X-Task-Token")); err != nil {
		c.JSON(http.StatusUnauthorized, ErrorResponse{Error: err.Error()})
		return
	}
	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	obj, err := h.files.SaveUpload(fileHeader, model.FilePurposeArtifact, taskID)
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, toFileResponse(obj))
}

func (h *Handler) ListArtifacts(c *gin.Context) {
	files, err := h.files.ListArtifacts(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	items := make([]FileResponse, 0, len(files))
	for i := range files {
		items = append(items, toFileResponse(&files[i]))
	}
	c.JSON(http.StatusOK, ArtifactListResponse{Artifacts: items})
}

func (h *Handler) CreateTask(c *gin.Context) {
	var req CreateTaskRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	task, err := h.tasks.CreateTask(c.Request.Context(), service.CreateTaskInput{
		RequestID:      req.RequestID,
		Name:           req.Name,
		Namespace:      req.Namespace,
		Image:          req.Image,
		Command:        req.Command,
		InputFiles:     req.InputFiles,
		TimeoutSeconds: req.TimeoutSeconds,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, TaskResponse{Task: task})
}

func (h *Handler) ListTasks(c *gin.Context) {
	tasks, err := h.tasks.ListTasks()
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, ListTaskResponse{Tasks: tasks})
}

func (h *Handler) GetTask(c *gin.Context) {
	task, err := h.tasks.GetTask(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, TaskResponse{Task: task})
}

func (h *Handler) CancelTask(c *gin.Context) {
	task, err := h.tasks.CancelTask(c.Request.Context(), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, TaskResponse{Task: task})
}

func (h *Handler) RetryTask(c *gin.Context) {
	task, err := h.tasks.RetryTask(c.Request.Context(), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, TaskResponse{Task: task})
}

func (h *Handler) Logs(c *gin.Context) {
	result, err := h.tasks.LogsSummary(c.Request.Context(), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, result)
}

func toFileResponse(obj *model.FileObject) FileResponse {
	return FileResponse{
		FileID:   obj.ID,
		Filename: obj.Filename,
		Size:     obj.Size,
		Purpose:  string(obj.Purpose),
		Sha256:   obj.Sha256,
	}
}
