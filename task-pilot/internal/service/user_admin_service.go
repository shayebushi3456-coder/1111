package service

import (
	"fmt"
	"strings"
	"time"

	"task-pilot/internal/model"
	"gorm.io/gorm"
)

type ListUsersOptions struct {
	Page     int
	PageSize int
	Query    string
	Status   string
	Role     string
}

type ListUsersResult struct {
	Items    []model.User
	Total    int64
	Page     int
	PageSize int
}

type UserAdminService struct{ db *gorm.DB }

func NewUserAdminService(db *gorm.DB) *UserAdminService { return &UserAdminService{db: db} }

func normalizeUserPage(opts *ListUsersOptions) {
	if opts.Page <= 0 { opts.Page = 1 }
	if opts.PageSize <= 0 { opts.PageSize = 20 }
	if opts.PageSize > 100 { opts.PageSize = 100 }
}

func (s *UserAdminService) List(opts ListUsersOptions) (ListUsersResult, error) {
	normalizeUserPage(&opts)
	db := s.db.Model(&model.User{})
	if q := strings.TrimSpace(opts.Query); q != "" {
		like := "%" + q + "%"
		db = db.Where("username LIKE ? OR display_name LIKE ? OR email LIKE ? OR id LIKE ?", like, like, like, like)
	}
	if opts.Status != "" { db = db.Where("status = ?", opts.Status) }
	if opts.Role != "" { db = db.Where("role = ?", opts.Role) }
	var total int64
	if err := db.Count(&total).Error; err != nil { return ListUsersResult{}, err }
	var users []model.User
	if err := db.Order("created_at desc").Limit(opts.PageSize).Offset((opts.Page-1)*opts.PageSize).Find(&users).Error; err != nil { return ListUsersResult{}, err }
	return ListUsersResult{Items: users, Total: total, Page: opts.Page, PageSize: opts.PageSize}, nil
}

func validRole(role string) (model.UserRole, error) {
	switch model.UserRole(role) {
	case model.RoleViewer, model.RoleOperator, model.RoleAdmin:
		return model.UserRole(role), nil
	default:
		return "", fmt.Errorf("invalid role")
	}
}

func (s *UserAdminService) activeAdminCount() (int64, error) {
	var n int64
	err := s.db.Model(&model.User{}).Where("role = ? AND status = ?", model.RoleAdmin, model.UserActive).Count(&n).Error
	return n, err
}

func (s *UserAdminService) Approve(id string, role string) (*model.User, error) {
	r, err := validRole(role); if err != nil { return nil, err }
	var u model.User
	if err := s.db.First(&u, "id = ?", id).Error; err != nil { return nil, err }
	u.Role = r; u.Status = model.UserActive
	if err := s.db.Save(&u).Error; err != nil { return nil, err }
	return &u, nil
}

func (s *UserAdminService) Reject(id string) (*model.User, error) {
	var u model.User
	if err := s.db.First(&u, "id = ?", id).Error; err != nil { return nil, err }
	u.Status = model.UserRejected
	if err := s.db.Save(&u).Error; err != nil { return nil, err }
	return &u, nil
}

func (s *UserAdminService) UpdateRole(id string, role string) (*model.User, error) {
	r, err := validRole(role); if err != nil { return nil, err }
	var u model.User
	if err := s.db.First(&u, "id = ?", id).Error; err != nil { return nil, err }
	if u.Role == model.RoleAdmin && r != model.RoleAdmin && u.Status == model.UserActive {
		n, err := s.activeAdminCount(); if err != nil { return nil, err }
		if n <= 1 { return nil, fmt.Errorf("cannot remove the last active admin") }
	}
	u.Role = r
	if err := s.db.Save(&u).Error; err != nil { return nil, err }
	return &u, nil
}

func (s *UserAdminService) Disable(id string) (*model.User, error) {
	var u model.User
	if err := s.db.First(&u, "id = ?", id).Error; err != nil { return nil, err }
	if u.Role == model.RoleAdmin && u.Status == model.UserActive {
		n, err := s.activeAdminCount(); if err != nil { return nil, err }
		if n <= 1 { return nil, fmt.Errorf("cannot disable the last active admin") }
	}
	u.Status = model.UserDisabled
	if err := s.db.Save(&u).Error; err != nil { return nil, err }
	now := time.Now()
	s.db.Model(&model.UserSession{}).Where("user_id = ? AND revoked_at IS NULL", u.ID).Update("revoked_at", &now)
	return &u, nil
}

func (s *UserAdminService) Enable(id string) (*model.User, error) {
	var u model.User
	if err := s.db.First(&u, "id = ?", id).Error; err != nil { return nil, err }
	u.Status = model.UserActive
	if err := s.db.Save(&u).Error; err != nil { return nil, err }
	return &u, nil
}
