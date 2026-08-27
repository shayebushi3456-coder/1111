package filetransfer

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"mime/multipart"
	"os"
	"path/filepath"

	"task-pilot/internal/config"
	"task-pilot/internal/model"
	"task-pilot/internal/util"
	"gorm.io/gorm"
)

type Service struct {
	db  *gorm.DB
	cfg config.FileTransferConfig
}

func NewService(db *gorm.DB, cfg config.FileTransferConfig) *Service {
	return &Service{db: db, cfg: cfg}
}

func (s *Service) SaveUpload(fileHeader *multipart.FileHeader, purpose model.FilePurpose, taskID string) (*model.FileObject, error) {
	if fileHeader == nil {
		return nil, fmt.Errorf("file is required")
	}
	maxBytes := s.cfg.MaxFileSizeMB * 1024 * 1024
	if maxBytes <= 0 {
		maxBytes = 10 * 1024 * 1024
	}
	if fileHeader.Size > maxBytes {
		return nil, fmt.Errorf("file too large: %d bytes, max %d bytes", fileHeader.Size, maxBytes)
	}

	src, err := fileHeader.Open()
	if err != nil {
		return nil, err
	}
	defer src.Close()

	fileID := util.NewID("file")
	dir := filepath.Join(s.cfg.StorageDir, string(purpose), fileID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	dstPath := filepath.Join(dir, filepath.Base(fileHeader.Filename))
	dst, err := os.Create(dstPath)
	if err != nil {
		return nil, err
	}
	defer dst.Close()

	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(dst, hash), src)
	if err != nil {
		return nil, err
	}

	obj := &model.FileObject{
		ID:       fileID,
		TaskID:   taskID,
		Purpose:  purpose,
		Filename: filepath.Base(fileHeader.Filename),
		Path:     dstPath,
		Size:     written,
		Sha256:   hex.EncodeToString(hash.Sum(nil)),
	}
	if err := s.db.Create(obj).Error; err != nil {
		return nil, err
	}
	return obj, nil
}

// SaveBytes 直接把内存字节持久化为一个文件对象（供评测阶段生成 eval_input.json）。
func (s *Service) SaveBytes(data []byte, filename string, purpose model.FilePurpose, taskID string) (*model.FileObject, error) {
	fileID := util.NewID("file")
	dir := filepath.Join(s.cfg.StorageDir, string(purpose), fileID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	dstPath := filepath.Join(dir, filepath.Base(filename))
	if err := os.WriteFile(dstPath, data, 0o644); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	obj := &model.FileObject{
		ID:       fileID,
		TaskID:   taskID,
		Purpose:  purpose,
		Filename: filepath.Base(filename),
		Path:     dstPath,
		Size:     int64(len(data)),
		Sha256:   hex.EncodeToString(sum[:]),
	}
	if err := s.db.Create(obj).Error; err != nil {
		return nil, err
	}
	return obj, nil
}

func (s *Service) Get(id string) (*model.FileObject, error) {
	var obj model.FileObject
	if err := s.db.First(&obj, "id = ?", id).Error; err != nil {
		return nil, err
	}
	return &obj, nil
}

func (s *Service) ListArtifacts(taskID string) ([]model.FileObject, error) {
	var files []model.FileObject
	if err := s.db.Where("task_id = ? AND purpose = ?", taskID, model.FilePurposeArtifact).Order("created_at desc").Find(&files).Error; err != nil {
		return nil, err
	}
	return files, nil
}

func (s *Service) Open(id string) (*model.FileObject, *os.File, error) {
	obj, err := s.Get(id)
	if err != nil {
		return nil, nil, err
	}
	file, err := os.Open(obj.Path)
	if err != nil {
		return nil, nil, err
	}
	return obj, file, nil
}
