package api

import (
	"net/http"

	"task-pilot/internal/model"
	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

// MCPConfigHandler MCP Server 配置管理：新增/查看/修改/删除，供用例绑定引用。
type MCPConfigHandler struct {
	mcp *service.MCPConfigService
}

func NewMCPConfigHandler(mcp *service.MCPConfigService) *MCPConfigHandler {
	return &MCPConfigHandler{mcp: mcp}
}

func toMCPConfigResponse(m *model.MCPConfig) MCPConfigResponse {
	return MCPConfigResponse{
		ID:          m.ID,
		Name:        m.Name,
		Description: m.Description,
		ConfigJSON:  m.ConfigJSON,
	}
}

func (h *MCPConfigHandler) Create(c *gin.Context) {
	var req UpsertMCPConfigRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	m, err := h.mcp.Create(service.UpsertMCPConfigInput{
		Name:        req.Name,
		Description: req.Description,
		ConfigJSON:  req.ConfigJSON,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, toMCPConfigResponse(m))
}

func (h *MCPConfigHandler) List(c *gin.Context) {
	items, err := h.mcp.List()
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	out := make([]MCPConfigResponse, 0, len(items))
	for i := range items {
		out = append(out, toMCPConfigResponse(&items[i]))
	}
	c.JSON(http.StatusOK, MCPConfigListResponse{MCPConfigs: out})
}

func (h *MCPConfigHandler) Get(c *gin.Context) {
	m, err := h.mcp.Get(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, toMCPConfigResponse(m))
}

func (h *MCPConfigHandler) Update(c *gin.Context) {
	var req UpsertMCPConfigRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	m, err := h.mcp.Update(c.Param("id"), service.UpsertMCPConfigInput{
		Name:        req.Name,
		Description: req.Description,
		ConfigJSON:  req.ConfigJSON,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, toMCPConfigResponse(m))
}

func (h *MCPConfigHandler) Delete(c *gin.Context) {
	if err := h.mcp.Delete(c.Param("id")); err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}
