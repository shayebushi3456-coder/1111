package api

import (
	"net/http"

	"task-pilot/internal/model"
	"task-pilot/internal/service"
	"github.com/gin-gonic/gin"
)

const currentUserKey = "current_user"

func AuthMiddleware(auth *service.AuthService) gin.HandlerFunc {
	return func(c *gin.Context) {
		token, _ := c.Cookie(service.SessionCookieName)
		user, _ := auth.CurrentUser(token)
		if user != nil {
			c.Set(currentUserKey, user)
		}
		c.Next()
	}
}

func CurrentUser(c *gin.Context) (*model.User, bool) {
	v, ok := c.Get(currentUserKey)
	if !ok {
		return nil, false
	}
	user, ok := v.(*model.User)
	return user, ok && user != nil
}

func RequirePermission(p service.Permission) gin.HandlerFunc {
	return func(c *gin.Context) {
		user, ok := CurrentUser(c)
		if !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, ErrorResponse{Error: "login required", Code: "LOGIN_REQUIRED", Permission: string(p)})
			return
		}
		if user.Status != model.UserActive || !service.HasPermission(user.Role, p) {
			c.AbortWithStatusJSON(http.StatusForbidden, ErrorResponse{Error: "permission denied", Code: "PERMISSION_DENIED", Permission: string(p)})
			return
		}
		c.Next()
	}
}
