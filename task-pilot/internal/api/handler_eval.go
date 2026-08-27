package api

import (
	"net/http"

	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

// EvalHandler 执行任务（EvalRun）接口。
type EvalHandler struct {
	eval *service.EvalService
}

func NewEvalHandler(eval *service.EvalService) *EvalHandler {
	return &EvalHandler{eval: eval}
}

func (h *EvalHandler) Create(c *gin.Context) {
	var req CreateEvalRunRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	run, err := h.eval.CreateEvalRun(c.Request.Context(), service.CreateEvalRunInput{
		CaseSetID:        req.CaseSetID,
		Name:             req.Name,
		EndpointID:       req.EndpointID,
		EvalEndpointID:   req.EvalEndpointID,
		PromptID:         req.PromptID,
		MaxConcurrent:    req.MaxConcurrent,
		TestImage:        req.TestImage,
		EvalImage:        req.EvalImage,
		TestModelCommand: req.TestModelCommand,
		EvalModelCommand: req.EvalModelCommand,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, EvalRunResponse{EvalRun: run})
}

func (h *EvalHandler) List(c *gin.Context) {
	runs, err := h.eval.ListEvalRuns()
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, EvalRunListResponse{EvalRuns: runs})
}

// Running 返回当前正在执行的评测用例（跨所有 EvalRun，测试/评测阶段）。
func (h *EvalHandler) Running(c *gin.Context) {
	ces, err := h.eval.ListRunningCaseExecutions()
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, RunningCaseExecutionsResponse{Count: len(ces), CaseExecutions: ces})
}

func (h *EvalHandler) Get(c *gin.Context) {
	run, err := h.eval.GetEvalRun(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResponse{Error: err.Error()})
		return
	}
	summary, err := h.eval.GetScoreSummary(run.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, EvalRunResponse{EvalRun: run, ScoreSummary: summary})
}

// Results 返回完整结果（含每条用例的逐条校验点判定）。
func (h *EvalHandler) Results(c *gin.Context) {
	run, err := h.eval.GetResults(c.Param("id"))
	if err != nil {
		c.JSON(http.StatusNotFound, ErrorResponse{Error: err.Error()})
		return
	}
	summary, err := h.eval.GetScoreSummary(run.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, EvalRunResponse{EvalRun: run, ScoreSummary: summary})
}

func (h *EvalHandler) Stop(c *gin.Context) {
	run, err := h.eval.StopEvalRun(c.Request.Context(), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, EvalRunResponse{EvalRun: run})
}

func (h *EvalHandler) Delete(c *gin.Context) {
	if err := h.eval.DeleteEvalRun(c.Request.Context(), c.Param("id")); err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}
