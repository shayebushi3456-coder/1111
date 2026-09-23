package service

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"task-pilot/internal/model"
	"task-pilot/internal/util"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
)

const SessionCookieName = "tp_session"
const sessionTTL = 7 * 24 * time.Hour

type Permission string

const (
	PermEvalRunRead    Permission = "eval_run:read"
	PermEvalRunCreate  Permission = "eval_run:create"
	PermEvalRunStop    Permission = "eval_run:stop"
	PermEvalRunDelete  Permission = "eval_run:delete"
	PermEvalRunExport  Permission = "eval_run:export"
	PermCaseSetRead    Permission = "case_set:read"
	PermCaseSetWrite   Permission = "case_set:write"
	PermCaseSetExport  Permission = "case_set:export"
	PermConfigRead     Permission = "config:read"
	PermConfigWrite    Permission = "config:write"
	PermFileDownload   Permission = "file:download"
	PermUserRead       Permission = "user:read"
	PermUserApprove    Permission = "user:approve"
	PermUserUpdateRole Permission = "user:update_role"
	PermUserDisable    Permission = "user:disable"
	PermAdminGrant     Permission = "admin:grant"
)

type AuthUser struct {
	User        *model.User  `json:"user"`
	Role        string       `json:"role"`
	Permissions []Permission `json:"permissions"`
}

type RegisterInput struct {
	Username    string
	Password    string
	DisplayName string
	Email       string
}

type LoginInput struct {
	Username string
	Password string
}

type AuthService struct {
	db *gorm.DB
}

func NewAuthService(db *gorm.DB) *AuthService { return &AuthService{db: db} }

func RolePermissions(role model.UserRole) []Permission {
	switch role {
	case model.RoleAdmin:
		return []Permission{PermEvalRunRead, PermEvalRunCreate, PermEvalRunStop, PermEvalRunDelete, PermEvalRunExport, PermCaseSetRead, PermCaseSetWrite, PermCaseSetExport, PermConfigRead, PermConfigWrite, PermFileDownload, PermUserRead, PermUserApprove, PermUserUpdateRole, PermUserDisable, PermAdminGrant}
	case model.RoleOperator:
		return []Permission{PermEvalRunRead, PermEvalRunCreate, PermEvalRunStop, PermEvalRunDelete, PermEvalRunExport, PermCaseSetRead, PermCaseSetWrite, PermCaseSetExport, PermConfigRead, PermConfigWrite, PermFileDownload}
	case model.RoleViewer:
		return []Permission{PermEvalRunRead, PermCaseSetRead, PermCaseSetExport, PermConfigRead, PermFileDownload}
	default:
		return []Permission{PermEvalRunRead, PermCaseSetRead}
	}
}

func HasPermission(role model.UserRole, p Permission) bool {
	for _, item := range RolePermissions(role) {
		if item == p {
			return true
		}
	}
	return false
}

func (s *AuthService) BootstrapAdmin() error {
	return s.ensureBootstrapAdmin("ioadmin", "Wsj_37Yu")
}

func (s *AuthService) ensureBootstrapAdmin(username, password string) error {
	var count int64
	if err := s.db.Model(&model.User{}).Where("role = ? AND status = ?", model.RoleAdmin, model.UserActive).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	user := &model.User{ID: util.NewID("usr"), Username: username, DisplayName: username, PasswordHash: string(hash), Role: model.RoleAdmin, Status: model.UserActive}
	return s.db.Create(user).Error
}

func normalizeUsername(v string) string { return strings.TrimSpace(strings.ToLower(v)) }

func (s *AuthService) Register(in RegisterInput) (*model.User, error) {
	username := normalizeUsername(in.Username)
	if username == "" || len(strings.TrimSpace(in.Password)) < 8 {
		return nil, fmt.Errorf("username and password(min 8 chars) are required")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(in.Password), bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	user := &model.User{ID: util.NewID("usr"), Username: username, DisplayName: strings.TrimSpace(in.DisplayName), Email: strings.TrimSpace(in.Email), PasswordHash: string(hash), Role: model.RoleViewer, Status: model.UserPending}
	if user.DisplayName == "" { user.DisplayName = username }
	if err := s.db.Create(user).Error; err != nil { return nil, err }
	return user, nil
}

func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func randomToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil { return "", err }
	return hex.EncodeToString(b), nil
}

func (s *AuthService) Login(in LoginInput) (*model.User, string, error) {
	var user model.User
	if err := s.db.First(&user, "username = ?", normalizeUsername(in.Username)).Error; err != nil { return nil, "", fmt.Errorf("invalid username or password") }
	if user.Status != model.UserActive { return nil, "", fmt.Errorf("user status is %s", user.Status) }
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(in.Password)); err != nil { return nil, "", fmt.Errorf("invalid username or password") }
	token, err := randomToken(); if err != nil { return nil, "", err }
	now := time.Now()
	sess := &model.UserSession{ID: util.NewID("sess"), UserID: user.ID, TokenHash: tokenHash(token), CreatedAt: now, ExpiresAt: now.Add(sessionTTL), LastSeenAt: &now}
	if err := s.db.Create(sess).Error; err != nil { return nil, "", err }
	s.db.Model(&user).Updates(map[string]any{"last_login_at": &now})
	user.LastLoginAt = &now
	return &user, token, nil
}

func (s *AuthService) Logout(token string) error {
	if token == "" { return nil }
	now := time.Now()
	return s.db.Model(&model.UserSession{}).Where("token_hash = ? AND revoked_at IS NULL", tokenHash(token)).Update("revoked_at", &now).Error
}

func (s *AuthService) CurrentUser(token string) (*model.User, error) {
	if token == "" { return nil, nil }
	now := time.Now()
	var sess model.UserSession
	if err := s.db.First(&sess, "token_hash = ? AND revoked_at IS NULL AND expires_at > ?", tokenHash(token), now).Error; err != nil { return nil, nil }
	var user model.User
	if err := s.db.First(&user, "id = ?", sess.UserID).Error; err != nil { return nil, nil }
	if user.Status != model.UserActive { return nil, nil }
	s.db.Model(&sess).Update("last_seen_at", &now)
	return &user, nil
}

func AuthView(user *model.User) AuthUser {
	if user == nil { return AuthUser{User: nil, Role: "guest", Permissions: RolePermissions("")} }
	return AuthUser{User: user, Role: string(user.Role), Permissions: RolePermissions(user.Role)}
}
