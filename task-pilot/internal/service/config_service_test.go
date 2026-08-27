package service

import (
	"strings"
	"testing"

	"task-pilot/internal/config"
	"task-pilot/internal/model"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newConfigService(t *testing.T) *ConfigService {
	t.Helper()
	dsn := "file:" + t.Name() + "?mode=memory&cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.TargetEndpoint{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	cfg := &config.Config{Eval: config.EvalConfig{EncryptionSecret: "unit-test-secret"}}
	return NewConfigService(db, cfg)
}

func TestEndpointCreateEncryptsAndMasks(t *testing.T) {
	svc := newConfigService(t)
	ep, err := svc.CreateEndpoint(UpsertEndpointInput{
		Name: "prod", BaseURL: "https://x/v1", ModelName: "gpt-x", APIKey: "sk-secret1234", IsDefault: true,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if ep.APIKeyEnc == "sk-secret1234" {
		t.Error("api_key must be stored encrypted")
	}
	if masked := svc.MaskedAPIKey(ep); masked != "****1234" {
		t.Errorf("masked = %q, want ****1234", masked)
	}
	plain, err := svc.ResolveAPIKey(ep)
	if err != nil || plain != "sk-secret1234" {
		t.Errorf("resolve = %q err=%v, want sk-secret1234", plain, err)
	}
}

func TestEndpointDefaultUniqueness(t *testing.T) {
	svc := newConfigService(t)
	a, _ := svc.CreateEndpoint(UpsertEndpointInput{Name: "a", BaseURL: "u", ModelName: "m", IsDefault: true})
	b, _ := svc.CreateEndpoint(UpsertEndpointInput{Name: "b", BaseURL: "u", ModelName: "m", IsDefault: true})

	def, err := svc.DefaultEndpoint()
	if err != nil {
		t.Fatalf("default: %v", err)
	}
	if def.ID != b.ID {
		t.Errorf("default should be latest (b), got %s", def.ID)
	}
	// a 应已被清除默认标记
	reloadA, _ := svc.GetEndpoint(a.ID)
	if reloadA.IsDefault {
		t.Error("first endpoint should no longer be default")
	}
}

func TestEndpointUpdateKeepsKeyWhenEmpty(t *testing.T) {
	svc := newConfigService(t)
	ep, _ := svc.CreateEndpoint(UpsertEndpointInput{Name: "a", BaseURL: "u", ModelName: "m", APIKey: "sk-keepme99"})
	oldEnc := ep.APIKeyEnc

	updated, err := svc.UpdateEndpoint(ep.ID, UpsertEndpointInput{ModelName: "m2", APIKey: ""})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.APIKeyEnc != oldEnc {
		t.Error("empty api_key on update must keep existing key")
	}
	if updated.ModelName != "m2" {
		t.Errorf("model_name not updated: %q", updated.ModelName)
	}
}

func TestEndpointCreateRequiresFields(t *testing.T) {
	svc := newConfigService(t)
	if _, err := svc.CreateEndpoint(UpsertEndpointInput{Name: "", BaseURL: "u", ModelName: "m"}); err == nil || !strings.Contains(err.Error(), "required") {
		t.Errorf("missing name should be rejected, got %v", err)
	}
}
