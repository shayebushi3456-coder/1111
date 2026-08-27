package api

import (
	"net/http"

	"task-pilot/internal/model"
	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

// ConfigHandler 配置中心：被测模型端点 CRUD。
type ConfigHandler struct {
	cfg *service.ConfigService
}

func NewConfigHandler(cfg *service.ConfigService) *ConfigHandler {
	return &ConfigHandler{cfg: cfg}
}

func (h *ConfigHandler) toResponse(ep *model.TargetEndpoint) EndpointResponse {
	return EndpointResponse{
		ID:           ep.ID,
		Name:         ep.Name,
		BaseURL:      ep.BaseURL,
		ModelName:    ep.ModelName,
		APIKeyMasked: h.cfg.MaskedAPIKey(ep),
		IsDefault:    ep.IsDefault,
	}
}

func (h *ConfigHandler) List(c *gin.Context) {
	eps, err := h.cfg.ListEndpoints()
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	items := make([]EndpointResponse, 0, len(eps))
	for i := range eps {
		items = append(items, h.toResponse(&eps[i]))
	}
	c.JSON(http.StatusOK, EndpointListResponse{Endpoints: items})
}

func (h *ConfigHandler) Get(c *gin.Context) {
	ep, err := h.cfg.GetEndpoint(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, h.toResponse(ep))
}

func (h *ConfigHandler) Create(c *gin.Context) {
	var req UpsertEndpointRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	ep, err := h.cfg.CreateEndpoint(service.UpsertEndpointInput{
		Name:      req.Name,
		BaseURL:   req.BaseURL,
		ModelName: req.ModelName,
		APIKey:    req.APIKey,
		IsDefault: req.IsDefault,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, h.toResponse(ep))
}

func (h *ConfigHandler) Update(c *gin.Context) {
	var req UpsertEndpointRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	ep, err := h.cfg.UpdateEndpoint(c.Param("id"), service.UpsertEndpointInput{
		Name:      req.Name,
		BaseURL:   req.BaseURL,
		ModelName: req.ModelName,
		APIKey:    req.APIKey,
		IsDefault: req.IsDefault,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, h.toResponse(ep))
}

func (h *ConfigHandler) Delete(c *gin.Context) {
	if err := h.cfg.DeleteEndpoint(c.Param("id")); err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}
