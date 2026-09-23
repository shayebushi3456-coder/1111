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
	if purpose != model.FilePurposeInput && purpose != model.FilePurposeArtifact && purpose != model.FilePurposePrestart {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: "purpose must be input, artifact, or prestart"})
		return
	}
	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	obj, err := h.files.SaveUpload(fileHeader, purpose, c.PostForm("task_id"), CurrentProjectID(c))
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, toFileResponse(obj))
}

func (h *Handler) ListFiles(c *gin.Context) {
	purpose := model.FilePurpose(c.Query("purpose"))
	if purpose != model.FilePurposePrestart {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: "purpose must be prestart"})
		return
	}
	files, err := h.files.ListByPurpose(CurrentProjectID(c), purpose)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	out := make([]FileResponse, 0, len(files))
	for i := range files {
		out = append(out, toFileResponse(&files[i]))
	}
	c.JSON(http.StatusOK, gin.H{"files": out})
}

func (h *Handler) GetFile(c *gin.Context) {
	obj, err := h.files.Get(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, toFileResponse(obj))
}

func (h *Handler) DeleteFile(c *gin.Context) {
	obj, err := h.files.Get(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResponse{Error: err.Error()})
		return
	}
	if obj.Purpose != model.FilePurposePrestart {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: "only prestart scripts can be deleted"})
		return
	}
	if obj.ProjectID != "" && obj.ProjectID != CurrentProjectID(c) {
		c.JSON(http.StatusForbidden, ErrorResponse{Error: "file not in current project"})
		return
	}
	if err := h.files.Delete(c.Param("id")); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}

func (h *Handler) DownloadFile(c *gin.Context) {
	if taskID := c.Query("task_id"); taskID != "" {
		if err := h.tasks.ValidateTaskToken(taskID, c.GetHeader("X-Task-Token")); err != nil {
			c.JSON(http.StatusUnauthorized, ErrorResponse{Error: err.Error()})
			return
		}
	} else if c.Query("inline") != "1" {
		user, ok := CurrentUser(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, ErrorResponse{Error: "login required", Code: "LOGIN_REQUIRED", Permission: string(service.PermFileDownload)})
			return
		}
		if !service.HasPermission(user.Role, service.PermFileDownload) {
			c.JSON(http.StatusForbidden, ErrorResponse{Error: "permission denied", Code: "PERMISSION_DENIED", Permission: string(service.PermFileDownload)})
			return
		}
		// 平台角色权限（file:download）只是必要条件；项目内是否允许下载/导出还须叠加项目
		// 权限（非成员/访客即便平台角色允许下载也不可导出，管理员绕过）。
		if !CurrentProjectAccess(c).CanExport() {
			c.JSON(http.StatusForbidden, ErrorResponse{Error: "project permission denied", Code: "PROJECT_PERMISSION_DENIED"})
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
	// 执行器只持有 task_id（不知道所属项目），因此项目归属必须从 Task 记录反查，
	// 而不能取自 ProjectContext（该中间件解析的是发起 HTTP 请求方的项目头，与执行器上传
	// 场景无关；执行器请求也不会带 X-Project-ID）。
	task, err := h.tasks.GetTask(taskID)
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	obj, err := h.files.SaveUpload(fileHeader, model.FilePurposeArtifact, taskID, task.ProjectID)
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
		ProjectID:      CurrentProjectID(c),
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
	tasks, err := h.tasks.ListTasks(CurrentProjectID(c))
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, ListTaskResponse{Tasks: tasks})
}

func (h *Handler) GetTask(c *gin.Context) {
	task, err := h.tasks.GetTaskInProject(CurrentProjectID(c), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, TaskResponse{Task: task})
}

func (h *Handler) CancelTask(c *gin.Context) {
	task, err := h.tasks.CancelTask(c.Request.Context(), CurrentProjectID(c), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, TaskResponse{Task: task})
}

func (h *Handler) RetryTask(c *gin.Context) {
	task, err := h.tasks.RetryTask(c.Request.Context(), CurrentProjectID(c), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, TaskResponse{Task: task})
}

func (h *Handler) Logs(c *gin.Context) {
	result, err := h.tasks.LogsSummary(c.Request.Context(), CurrentProjectID(c), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, result)
}

func toFileResponse(obj *model.FileObject) FileResponse {
	return FileResponse{
		FileID:    obj.ID,
		Filename:  obj.Filename,
		Size:      obj.Size,
		Purpose:   string(obj.Purpose),
		Sha256:    obj.Sha256,
		CreatedAt: obj.CreatedAt,
	}
}
