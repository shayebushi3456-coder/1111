package api

import (
	"net/http"
	"strconv"

	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

// LeaderboardHandler 被测模型 Leaderboard 接口。
type LeaderboardHandler struct {
	eval *service.EvalService
}

func NewLeaderboardHandler(eval *service.EvalService) *LeaderboardHandler {
	return &LeaderboardHandler{eval: eval}
}

// periodDays 把 period 查询参数（30d/90d/all）转换为天数；0 表示不限时间。
// 未识别的取值回退到 30d，不报错——排行榜是展示型接口，容错优先于严格校验。
func periodDays(period string) int {
	switch period {
	case "90d":
		return 90
	case "all":
		return 0
	case "30d", "":
		return 30
	default:
		if n, err := strconv.Atoi(period); err == nil && n > 0 {
			return n
		}
		return 30
	}
}

// Get 返回按被测模型端点聚合的机评排行榜。
// Query 参数：period=30d|90d|all（默认 30d），仅统计 score_status=OK 的用例执行。
func (h *LeaderboardHandler) Get(c *gin.Context) {
	period := c.DefaultQuery("period", "30d")
	items, err := h.eval.GetLeaderboard(periodDays(period))
	if err != nil {
		c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()})
		return
	}
	c.JSON(http.StatusOK, LeaderboardResponse{Period: period, Items: items})
}
