package model

import "time"

type FilePurpose string

const (
	FilePurposeInput    FilePurpose = "input"
	FilePurposeArtifact FilePurpose = "artifact"
)

type FileObject struct {
	ID        string      `gorm:"primaryKey;size:64" json:"file_id"`
	TaskID    string      `gorm:"index;size:64" json:"task_id,omitempty"`
	Purpose   FilePurpose `gorm:"size:32;index" json:"purpose"`
	Filename  string      `gorm:"size:255" json:"filename"`
	Path      string      `gorm:"size:1024" json:"-"`
	Size      int64       `json:"size"`
	Sha256    string      `gorm:"size:64" json:"sha256,omitempty"`
	CreatedAt time.Time   `json:"created_at"`
}
