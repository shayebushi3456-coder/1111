package api

import (
	"net/http"

	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

// EnvVarHandler 全局环境变量配置中心。
type EnvVarHandler struct {
	env *service.EnvVarService
}

func NewEnvVarHandler(env *service.EnvVarService) *EnvVarHandler {
	return &EnvVarHandler{env: env}
}

func (h *EnvVarHandler) List(c *gin.Context) {
	items, err := h.env.List()
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	out := make([]EnvVarResponse, 0, len(items))
	for i := range items {
		out = append(out, EnvVarResponse{
			ID:          items[i].ID,
			Key:         items[i].Key,
			ValueMasked: h.env.MaskedValue(&items[i]),
			Description: items[i].Description,
		})
	}
	c.JSON(http.StatusOK, EnvVarListResponse{EnvVars: out})
}

func (h *EnvVarHandler) Get(c *gin.Context) {
	ev, err := h.env.Get(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, EnvVarResponse{
		ID:          ev.ID,
		Key:         ev.Key,
		ValueMasked: h.env.MaskedValue(ev),
		Description: ev.Description,
	})
}

func (h *EnvVarHandler) Create(c *gin.Context) {
	var req UpsertEnvVarRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	ev, err := h.env.Create(service.UpsertEnvVarInput{
		Key:         req.Key,
		Value:       req.Value,
		Description: req.Description,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, EnvVarResponse{
		ID:          ev.ID,
		Key:         ev.Key,
		ValueMasked: h.env.MaskedValue(ev),
		Description: ev.Description,
	})
}

func (h *EnvVarHandler) Update(c *gin.Context) {
	var req UpsertEnvVarRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	ev, err := h.env.Update(c.Param("id"), service.UpsertEnvVarInput{
		Key:         req.Key,
		Value:       req.Value,
		Description: req.Description,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, EnvVarResponse{
		ID:          ev.ID,
		Key:         ev.Key,
		ValueMasked: h.env.MaskedValue(ev),
		Description: ev.Description,
	})
}

func (h *EnvVarHandler) Delete(c *gin.Context) {
	if err := h.env.Delete(c.Param("id")); err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}
