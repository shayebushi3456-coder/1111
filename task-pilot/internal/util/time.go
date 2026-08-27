package util

import "time"

func NowPtr() *time.Time {
	now := time.Now()
	return &now
}
