package api

import (
	"net/http"

	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

type RuntimeEnvConfigHandler struct {
	svc *service.RuntimeEnvConfigService
}

func NewRuntimeEnvConfigHandler(svc *service.RuntimeEnvConfigService) *RuntimeEnvConfigHandler {
	return &RuntimeEnvConfigHandler{svc: svc}
}

func canReadRuntimeEnvPlain(c *gin.Context) bool {
	user, ok := CurrentUser(c)
	return ok && service.HasPermission(user.Role, service.PermConfigWrite)
}

func (h *RuntimeEnvConfigHandler) List(c *gin.Context) {
	items, err := h.svc.List(CurrentProjectID(c))
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	if !canReadRuntimeEnvPlain(c) {
		for i := range items {
			items[i].Value = ""
			items[i].MaskValue = true
		}
	}
	c.JSON(http.StatusOK, RuntimeEnvConfigListResponse{RuntimeEnvConfigs: items})
}

func (h *RuntimeEnvConfigHandler) Create(c *gin.Context) {
	var req RuntimeEnvConfigRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	item, err := h.svc.Create(CurrentProjectID(c), service.UpsertRuntimeEnvConfigInput{
		Key:         req.Key,
		Value:       req.Value,
		Description: req.Description,
		MaskValue:   req.MaskValue,
		Enabled:     req.Enabled,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, item)
}

func (h *RuntimeEnvConfigHandler) Get(c *gin.Context) {
	item, err := h.svc.GetInProject(CurrentProjectID(c), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResponse{Error: err.Error()})
		return
	}
	if !canReadRuntimeEnvPlain(c) {
		item.Value = ""
		item.MaskValue = true
	}
	c.JSON(http.StatusOK, item)
}

func (h *RuntimeEnvConfigHandler) Update(c *gin.Context) {
	var req RuntimeEnvConfigRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	item, err := h.svc.Update(CurrentProjectID(c), c.Param("id"), service.UpsertRuntimeEnvConfigInput{
		Key:         req.Key,
		Value:       req.Value,
		Description: req.Description,
		MaskValue:   req.MaskValue,
		Enabled:     req.Enabled,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, item)
}

func (h *RuntimeEnvConfigHandler) Delete(c *gin.Context) {
	if err := h.svc.Delete(CurrentProjectID(c), c.Param("id")); err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}
