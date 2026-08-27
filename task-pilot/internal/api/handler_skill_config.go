package api

import (
	"net/http"

	"task-pilot/internal/model"
	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

// SkillConfigHandler Skill 定义管理：新增/查看/修改/删除，供用例绑定引用。
type SkillConfigHandler struct {
	skills *service.SkillConfigService
}

func NewSkillConfigHandler(skills *service.SkillConfigService) *SkillConfigHandler {
	return &SkillConfigHandler{skills: skills}
}

func toSkillConfigResponse(sk *model.SkillConfig) SkillConfigResponse {
	return SkillConfigResponse{
		ID:          sk.ID,
		Name:        sk.Name,
		Description: sk.Description,
		ContentMD:   sk.ContentMD,
		ExtraFiles:  model.DecodeExtraFiles(sk.ExtraFilesJSON),
	}
}

func (h *SkillConfigHandler) Create(c *gin.Context) {
	var req UpsertSkillConfigRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	sk, err := h.skills.Create(service.UpsertSkillConfigInput{
		Name:        req.Name,
		Description: req.Description,
		ContentMD:   req.ContentMD,
		ExtraFiles:  req.ExtraFiles,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, toSkillConfigResponse(sk))
}

func (h *SkillConfigHandler) List(c *gin.Context) {
	items, err := h.skills.List()
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	out := make([]SkillConfigResponse, 0, len(items))
	for i := range items {
		out = append(out, toSkillConfigResponse(&items[i]))
	}
	c.JSON(http.StatusOK, SkillConfigListResponse{SkillConfigs: out})
}

func (h *SkillConfigHandler) Get(c *gin.Context) {
	sk, err := h.skills.Get(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, toSkillConfigResponse(sk))
}

func (h *SkillConfigHandler) Update(c *gin.Context) {
	var req UpsertSkillConfigRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	sk, err := h.skills.Update(c.Param("id"), service.UpsertSkillConfigInput{
		Name:        req.Name,
		Description: req.Description,
		ContentMD:   req.ContentMD,
		ExtraFiles:  req.ExtraFiles,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, toSkillConfigResponse(sk))
}

func (h *SkillConfigHandler) Delete(c *gin.Context) {
	if err := h.skills.Delete(c.Param("id")); err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}
