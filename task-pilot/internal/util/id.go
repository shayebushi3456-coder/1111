package util

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
)

func NewID(prefix string) string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return strings.TrimSuffix(prefix, "-") + "-fallback"
	}
	return strings.TrimSuffix(prefix, "-") + "-" + hex.EncodeToString(buf)
}
