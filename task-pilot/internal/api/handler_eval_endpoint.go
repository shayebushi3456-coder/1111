package api

import (
	"net/http"

	"task-pilot/internal/model"
	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

// EvalEndpointHandler 配置中心：评测模型端点 CRUD。复用被测端点的请求/响应 DTO。
type EvalEndpointHandler struct {
	svc *service.EvalEndpointService
}

func NewEvalEndpointHandler(svc *service.EvalEndpointService) *EvalEndpointHandler {
	return &EvalEndpointHandler{svc: svc}
}

func (h *EvalEndpointHandler) toResponse(ep *model.EvalEndpoint) EndpointResponse {
	return EndpointResponse{
		ID:           ep.ID,
		Name:         ep.Name,
		BaseURL:      ep.BaseURL,
		ModelName:    ep.ModelName,
		APIKeyMasked: h.svc.MaskedAPIKey(ep),
		IsDefault:    ep.IsDefault,
	}
}

func (h *EvalEndpointHandler) List(c *gin.Context) {
	eps, err := h.svc.ListEndpoints()
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

func (h *EvalEndpointHandler) Get(c *gin.Context) {
	ep, err := h.svc.GetEndpoint(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, h.toResponse(ep))
}

func (h *EvalEndpointHandler) Create(c *gin.Context) {
	var req UpsertEndpointRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	ep, err := h.svc.CreateEndpoint(service.UpsertEndpointInput{
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

func (h *EvalEndpointHandler) Update(c *gin.Context) {
	var req UpsertEndpointRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	ep, err := h.svc.UpdateEndpoint(c.Param("id"), service.UpsertEndpointInput{
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

func (h *EvalEndpointHandler) Delete(c *gin.Context) {
	if err := h.svc.DeleteEndpoint(c.Param("id")); err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}
