package api

import (
	"net/http"
	"strconv"

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
		ProjectID:        CurrentProjectID(c),
		CaseSetID:        req.CaseSetID,
		Name:             req.Name,
		EndpointID:       req.EndpointID,
		EvalEndpointID:   req.EvalEndpointID,
		PromptID:         req.PromptID,
		MaxConcurrent:    req.MaxConcurrent,
		TestImage:          req.TestImage,
		EvalImage:          req.EvalImage,
		TestTimeoutSeconds: req.TestTimeoutSeconds,
		EvalTimeoutSeconds: req.EvalTimeoutSeconds,
		MaxEvalAttempts:    req.MaxEvalAttempts,
		TestModelCommand:   req.TestModelCommand,
		EvalModelCommand: req.EvalModelCommand,
		PrestartScriptFileID: req.PrestartScriptFileID,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusCreated, EvalRunResponse{EvalRun: run})
}

func parseListQuery(c *gin.Context) (page int, pageSize int, q string) {
	page, _ = strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ = strconv.Atoi(c.DefaultQuery("page_size", "20"))
	q = c.Query("q")
	return
}

func (h *EvalHandler) List(c *gin.Context) {
	page, pageSize, q := parseListQuery(c)
	res, err := h.eval.ListEvalRunsPaged(service.ListEvalRunsOptions{ProjectID: CurrentProjectID(c), Page: page, PageSize: pageSize, Query: q})
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, EvalRunListResponse{EvalRuns: res.Items, Total: res.Total, Page: res.Page, PageSize: res.PageSize})
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
	run, err := h.eval.GetEvalRunInProject(CurrentProjectID(c), c.Param("id"))
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
	run, err := h.eval.GetResults(CurrentProjectID(c), c.Param("id"))
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
	run, err := h.eval.StopEvalRun(c.Request.Context(), CurrentProjectID(c), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, EvalRunResponse{EvalRun: run})
}

func (h *EvalHandler) Delete(c *gin.Context) {
	if err := h.eval.DeleteEvalRun(c.Request.Context(), CurrentProjectID(c), c.Param("id")); err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "deleted"})
}

// ReEval 对单条用例重新评测：不重跑测试任务，仅用最新题面/校验点/Prompt 重判分。
func (h *EvalHandler) ReEval(c *gin.Context) {
	run, err := h.eval.ReEvalCaseExecution(c.Request.Context(), CurrentProjectID(c), c.Param("id"), c.Param("ce_id"))
	if err != nil {
		c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, EvalRunResponse{EvalRun: run})
}
