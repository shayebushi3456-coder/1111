package util

import "testing"

func TestEncryptDecryptRoundTrip(t *testing.T) {
	secret := "test-secret-key"
	plain := "sk-abcdef123456"

	enc, err := Encrypt(secret, plain)
	if err != nil {
		t.Fatalf("encrypt failed: %v", err)
	}
	if enc == plain {
		t.Fatalf("ciphertext must differ from plaintext")
	}

	got, err := Decrypt(secret, enc)
	if err != nil {
		t.Fatalf("decrypt failed: %v", err)
	}
	if got != plain {
		t.Fatalf("round trip mismatch: got %q want %q", got, plain)
	}
}

func TestEncryptNonceRandomized(t *testing.T) {
	secret := "s"
	a, _ := Encrypt(secret, "same")
	b, _ := Encrypt(secret, "same")
	if a == b {
		t.Fatalf("two encryptions of same plaintext should differ due to random nonce")
	}
}

func TestDecryptWrongSecret(t *testing.T) {
	enc, _ := Encrypt("right", "value")
	if _, err := Decrypt("wrong", enc); err == nil {
		t.Fatalf("decrypt with wrong secret should fail")
	}
}

func TestEmptySecretRejected(t *testing.T) {
	if _, err := Encrypt("", "x"); err == nil {
		t.Fatalf("empty secret should be rejected")
	}
}

func TestMaskSecret(t *testing.T) {
	cases := map[string]string{
		"":              "",
		"abc":           "****",
		"sk-abcdefwxyz": "****wxyz",
	}
	for in, want := range cases {
		if got := MaskSecret(in); got != want {
			t.Errorf("MaskSecret(%q) = %q, want %q", in, got, want)
		}
	}
}
