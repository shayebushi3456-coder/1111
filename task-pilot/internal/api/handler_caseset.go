package api

import (
	"net/http"

	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

// CaseSetHandler 用例集 CRUD。
type CaseSetHandler struct {
	cases *service.CaseSetService
}

func NewCaseSetHandler(cases *service.CaseSetService) *CaseSetHandler {
	return &CaseSetHandler{cases: cases}
}

func toCaseSetInput(req CaseSetRequest) service.CaseSetInput {
	cases := make([]service.CaseInput, 0, len(req.Cases))
	for _, c := range req.Cases {
		checkpoints := make([]service.CheckpointInput, 0, len(c.Checkpoints))
		for _, cp := range c.Checkpoints {
			checkpoints = append(checkpoints, service.CheckpointInput{
				Description: cp.Description,
				FileIDs:     cp.FileIDs,
			})
		}
		cases = append(cases, service.CaseInput{
			Name:                c.Name,
			Description:         c.Description,
			FileIDs:             c.FileIDs,
			Checkpoints:         checkpoints,
			MCPIDs:              c.MCPIDs,
			SkillIDs:            c.SkillIDs,
			Level1Type:          c.Level1Type,
			Level2Type:          c.Level2Type,
			TaskTypes:           c.TaskTypes,
			Difficulty:          c.Difficulty,
			SkipHTMLVisualScore: c.SkipHTMLVisualScore,
		})
	}
	return service.CaseSetInput{
		Name:        req.Name,
		Description: req.Description,
		Cases:       cases,
	}
}

func (h *CaseSetHandler) Create(c *gin.Context) {
	var req CaseSetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	cs, err := h.cases.Create(toCaseSetInput(req))
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, CaseSetResponse{CaseSet: cs})
}

func (h *CaseSetHandler) List(c *gin.Context) {
	sets, err := h.cases.List()
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, CaseSetListResponse{CaseSets: sets})
}

func (h *CaseSetHandler) Get(c *gin.Context) {
	cs, err := h.cases.Get(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, CaseSetResponse{CaseSet: cs})
}

func (h *CaseSetHandler) Update(c *gin.Context) {
	var req CaseSetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	cs, err := h.cases.Update(c.Param("id"), toCaseSetInput(req))
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, CaseSetResponse{CaseSet: cs})
}

func (h *CaseSetHandler) Delete(c *gin.Context) {
	if err := h.cases.Delete(c.Param("id")); err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}
