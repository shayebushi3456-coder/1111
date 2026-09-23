package api

import (
	"net/http"

	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

type AdminHandler struct{ users *service.UserAdminService }

func NewAdminHandler(users *service.UserAdminService) *AdminHandler { return &AdminHandler{users: users} }

type RoleRequest struct { Role string `json:"role" binding:"required"` }

func (h *AdminHandler) ListUsers(c *gin.Context) {
	page, pageSize, q := parseListQuery(c)
	res, err := h.users.List(service.ListUsersOptions{Page: page, PageSize: pageSize, Query: q, Status: c.Query("status"), Role: c.Query("role")})
	if err != nil { c.JSON(http.StatusInternalServerError, ErrorResponse{Error: err.Error()}); return }
	c.JSON(http.StatusOK, gin.H{"users": res.Items, "total": res.Total, "page": res.Page, "page_size": res.PageSize})
}

func (h *AdminHandler) Approve(c *gin.Context) {
	var req RoleRequest
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()}); return }
	u, err := h.users.Approve(c.Param("id"), req.Role)
	if err != nil { c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()}); return }
	c.JSON(http.StatusOK, u)
}

func (h *AdminHandler) Reject(c *gin.Context) {
	u, err := h.users.Reject(c.Param("id"))
	if err != nil { c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()}); return }
	c.JSON(http.StatusOK, u)
}

func (h *AdminHandler) UpdateRole(c *gin.Context) {
	var req RoleRequest
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()}); return }
	u, err := h.users.UpdateRole(c.Param("id"), req.Role)
	if err != nil { c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()}); return }
	c.JSON(http.StatusOK, u)
}

func (h *AdminHandler) Disable(c *gin.Context) {
	u, err := h.users.Disable(c.Param("id"))
	if err != nil { c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()}); return }
	c.JSON(http.StatusOK, u)
}

func (h *AdminHandler) Enable(c *gin.Context) {
	u, err := h.users.Enable(c.Param("id"))
	if err != nil { c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()}); return }
	c.JSON(http.StatusOK, u)
}
