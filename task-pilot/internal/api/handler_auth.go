package api

import (
	"net/http"

	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

type AuthHandler struct{ auth *service.AuthService }

func NewAuthHandler(auth *service.AuthService) *AuthHandler { return &AuthHandler{auth: auth} }

type RegisterRequest struct {
	Username    string `json:"username" binding:"required"`
	Password    string `json:"password" binding:"required"`
	DisplayName string `json:"display_name"`
	Email       string `json:"email"`
}

type LoginRequest struct {
	Username string `json:"username" binding:"required"`
	Password string `json:"password" binding:"required"`
}

func (h *AuthHandler) Me(c *gin.Context) {
	user, _ := CurrentUser(c)
	c.JSON(http.StatusOK, service.AuthView(user))
}

func (h *AuthHandler) Register(c *gin.Context) {
	var req RegisterRequest
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()}); return }
	user, err := h.auth.Register(service.RegisterInput{Username: req.Username, Password: req.Password, DisplayName: req.DisplayName, Email: req.Email})
	if err != nil { c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()}); return }
	c.JSON(http.StatusCreated, gin.H{"user": user, "message": "注册成功，等待管理员审核"})
}

func (h *AuthHandler) Login(c *gin.Context) {
	var req LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(http.StatusBadRequest, ErrorResponse{Error: err.Error()}); return }
	user, token, err := h.auth.Login(service.LoginInput{Username: req.Username, Password: req.Password})
	if err != nil { c.JSON(http.StatusUnauthorized, ErrorResponse{Error: err.Error()}); return }
	c.SetCookie(service.SessionCookieName, token, int((7*24*timeHourSeconds())), "/", "", false, true)
	c.JSON(http.StatusOK, service.AuthView(user))
}

func timeHourSeconds() int { return 3600 }

func (h *AuthHandler) Logout(c *gin.Context) {
	token, _ := c.Cookie(service.SessionCookieName)
	_ = h.auth.Logout(token)
	c.SetCookie(service.SessionCookieName, "", -1, "/", "", false, true)
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}
