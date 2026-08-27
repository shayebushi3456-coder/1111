package api

import (
	"net/http"

	"task-pilot/internal/model"
	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

// PromptHandler 评测 prompt 管理：上传/查看/修改/删除。
type PromptHandler struct {
	prompts *service.PromptService
}

func NewPromptHandler(prompts *service.PromptService) *PromptHandler {
	return &PromptHandler{prompts: prompts}
}

func toPromptResponse(p *model.EvalPrompt) PromptResponse {
	return PromptResponse{
		ID:        p.ID,
		Name:      p.Name,
		Content:   p.Content,
		IsDefault: p.IsDefault,
	}
}

func (h *PromptHandler) Create(c *gin.Context) {
	var req UpsertPromptRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	p, err := h.prompts.Create(service.UpsertPromptInput{
		Name:      req.Name,
		Content:   req.Content,
		IsDefault: req.IsDefault,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, toPromptResponse(p))
}

func (h *PromptHandler) List(c *gin.Context) {
	ps, err := h.prompts.List()
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	items := make([]PromptResponse, 0, len(ps))
	for i := range ps {
		items = append(items, toPromptResponse(&ps[i]))
	}
	c.JSON(http.StatusOK, PromptListResponse{Prompts: items})
}

func (h *PromptHandler) Get(c *gin.Context) {
	p, err := h.prompts.Get(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, toPromptResponse(p))
}

func (h *PromptHandler) Update(c *gin.Context) {
	var req UpsertPromptRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	p, err := h.prompts.Update(c.Param("id"), service.UpsertPromptInput{
		Name:      req.Name,
		Content:   req.Content,
		IsDefault: req.IsDefault,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, toPromptResponse(p))
}

func (h *PromptHandler) Delete(c *gin.Context) {
	if err := h.prompts.Delete(c.Param("id")); err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}
