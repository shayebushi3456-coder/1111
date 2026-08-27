package db

import (
	"os"
	"path/filepath"
	"strings"

	"task-pilot/internal/model"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func Open(path string) (*gorm.DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}

	// SQLite 并发调优（内存 DSN 不加 pragma，避免破坏 :memory: / mode=memory 语义）。
	//   _journal_mode=WAL   读写分离：写不再阻塞读、多读可并发，显著降低锁争用。
	//   _busy_timeout=5000  写冲突时最多等待 5s 再重试，而非立刻返回 SQLITE_BUSY(database is locked)。
	//   _txlock=immediate   事务一开始即取写锁，避免"升级锁"导致的死锁。
	dsn := path
	if !strings.Contains(path, ":memory:") && !strings.Contains(path, "mode=memory") {
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		dsn = path + sep + "_journal_mode=WAL&_busy_timeout=5000&_txlock=immediate"
	}

	database, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		return nil, err
	}

	// SQLite 只允许单一写者：把写连接收敛为 1，杜绝多连接争锁产生的 database is locked。
	// 读连接可适度放开（WAL 下多读并发安全）。
	sqlDB, err := database.DB()
	if err != nil {
		return nil, err
	}
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)

	if err := database.AutoMigrate(
		&model.Task{},
		&model.FileObject{},
		&model.CaseSet{},
		&model.Case{},
		&model.Checkpoint{},
		&model.TargetEndpoint{},
		&model.EvalEndpoint{},
		&model.EvalRun{},
		&model.CaseExecution{},
		&model.EvalPrompt{},
		&model.MCPConfig{},
		&model.SkillConfig{},
		&model.EnvVar{},
	); err != nil {
		return nil, err
	}

	// 一次性状态归一化：历史 CaseExecution 的 score_status 是 gorm 零值（空字符串），
	// 统一置为 NOT_APPLICABLE，避免聚合查询把它们当成“待处理”或误计入统计分母。
	// 只处理已生成报告的历史行；非 REPORTED 的用例（ERROR/STOPPED 等）不涉及分数概念，
	// 留空即可，聚合查询按 score_status='OK' 过滤时自然排除。
	if err := database.Model(&model.CaseExecution{}).
		Where("score_status = ? AND status = ?", "", model.CaseExecReported).
		Update("score_status", model.ScoreNotApplicable).Error; err != nil {
		return nil, err
	}

	return database, nil
}
