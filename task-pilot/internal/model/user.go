package model

import (
	"time"

	"gorm.io/gorm"
)

type UserRole string

const (
	RoleViewer   UserRole = "viewer"
	RoleOperator UserRole = "operator"
	RoleAdmin    UserRole = "admin"
)

type UserStatus string

const (
	UserPending  UserStatus = "pending"
	UserActive   UserStatus = "active"
	UserRejected UserStatus = "rejected"
	UserDisabled UserStatus = "disabled"
)

type User struct {
	ID           string         `gorm:"primaryKey;size:64" json:"id"`
	Username     string         `gorm:"uniqueIndex;size:128" json:"username"`
	DisplayName  string         `gorm:"size:128" json:"display_name"`
	Email        string         `gorm:"size:256" json:"email"`
	PasswordHash string         `gorm:"type:text" json:"-"`
	Role         UserRole       `gorm:"size:32;index" json:"role"`
	Status       UserStatus     `gorm:"size:32;index" json:"status"`
	LastLoginAt  *time.Time     `json:"last_login_at,omitempty"`
	CreatedAt    time.Time      `json:"created_at"`
	UpdatedAt    time.Time      `json:"updated_at"`
	DeletedAt    gorm.DeletedAt `gorm:"index" json:"-"`
}

type UserSession struct {
	ID         string         `gorm:"primaryKey;size:64" json:"id"`
	UserID     string         `gorm:"index;size:64" json:"user_id"`
	TokenHash  string         `gorm:"uniqueIndex;size:128" json:"-"`
	CreatedAt  time.Time      `json:"created_at"`
	ExpiresAt  time.Time      `gorm:"index" json:"expires_at"`
	RevokedAt  *time.Time     `gorm:"index" json:"revoked_at,omitempty"`
	LastSeenAt *time.Time     `json:"last_seen_at,omitempty"`
	DeletedAt  gorm.DeletedAt `gorm:"index" json:"-"`
}
