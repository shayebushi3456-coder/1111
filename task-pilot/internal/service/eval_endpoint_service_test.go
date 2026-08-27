package service

import (
	"os"
	"strings"
	"testing"

	"task-pilot/internal/config"
	"task-pilot/internal/model"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newEvalEndpointService(t *testing.T) *EvalEndpointService {
	t.Helper()
	dsn := "file:" + t.Name() + "?mode=memory&cache=shared"
	db, err := gorm.Open(sqlite.Open(dsn), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.EvalEndpoint{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	cfg := &config.Config{Eval: config.EvalConfig{EncryptionSecret: "unit-test-secret"}}
	return NewEvalEndpointService(db, cfg)
}

func TestEvalEndpointCreateEncryptsAndMasks(t *testing.T) {
	svc := newEvalEndpointService(t)
	ep, err := svc.CreateEndpoint(UpsertEndpointInput{
		Name: "eval-prod", BaseURL: "https://e/v1", ModelName: "judge-x", APIKey: "sk-secret1234", IsDefault: true,
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

func TestEvalEndpointDefaultUniqueness(t *testing.T) {
	svc := newEvalEndpointService(t)
	a, _ := svc.CreateEndpoint(UpsertEndpointInput{Name: "a", BaseURL: "u", ModelName: "m", IsDefault: true})
	b, _ := svc.CreateEndpoint(UpsertEndpointInput{Name: "b", BaseURL: "u", ModelName: "m", IsDefault: true})

	def, err := svc.DefaultEndpoint()
	if err != nil {
		t.Fatalf("default: %v", err)
	}
	if def.ID != b.ID {
		t.Errorf("default should be latest (b), got %s", def.ID)
	}
	reloadA, _ := svc.GetEndpoint(a.ID)
	if reloadA.IsDefault {
		t.Error("first endpoint should no longer be default")
	}
}

func TestEvalEndpointUpdateKeepsKeyWhenEmpty(t *testing.T) {
	svc := newEvalEndpointService(t)
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

func TestEvalEndpointCreateRequiresFields(t *testing.T) {
	svc := newEvalEndpointService(t)
	if _, err := svc.CreateEndpoint(UpsertEndpointInput{Name: "", BaseURL: "u", ModelName: "m"}); err == nil || !strings.Contains(err.Error(), "required") {
		t.Errorf("missing name should be rejected, got %v", err)
	}
}

// TestEvalEndpointSeedDefault 验证：首次 seed 生成默认端点并从 env 读取 api_key；重复 seed 幂等。
func TestEvalEndpointSeedDefault(t *testing.T) {
	svc := newEvalEndpointService(t)
	t.Setenv("EVAL_MODEL_API_KEY", "sk-env-key-7788")

	if err := svc.SeedDefault(); err != nil {
		t.Fatalf("seed: %v", err)
	}
	def, err := svc.DefaultEndpoint()
	if err != nil {
		t.Fatalf("default after seed: %v", err)
	}
	if def.Name != "default" || !def.IsDefault {
		t.Errorf("seeded endpoint wrong: name=%q default=%v", def.Name, def.IsDefault)
	}
	if def.BaseURL != config.Builtin.EvalModel.BaseURL || def.ModelName != config.Builtin.EvalModel.ModelName {
		t.Errorf("seeded endpoint should use builtin base_url/model")
	}
	plain, err := svc.ResolveAPIKey(def)
	if err != nil || plain != "sk-env-key-7788" {
		t.Errorf("seeded api_key = %q err=%v, want env value", plain, err)
	}

	// 幂等：再次 seed 不新增。
	if err := svc.SeedDefault(); err != nil {
		t.Fatalf("second seed: %v", err)
	}
	eps, _ := svc.ListEndpoints()
	if len(eps) != 1 {
		t.Errorf("seed must be idempotent, got %d endpoints", len(eps))
	}
	_ = os.Unsetenv("EVAL_MODEL_API_KEY")
}
