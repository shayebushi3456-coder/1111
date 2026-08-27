package service

import "testing"

func TestSubstituteEnvVars(t *testing.T) {
	got, err := SubstituteEnvVars("token={{API_TOKEN}} end", map[string]string{"API_TOKEN": "sk-secret"})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if got != "token=sk-secret end" {
		t.Fatalf("got %q", got)
	}
	_, err = SubstituteEnvVars("{{MISSING}}", map[string]string{})
	if err == nil {
		t.Fatal("expected missing key error")
	}
}
