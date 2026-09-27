package dto

import (
	"testing"

	"github.com/whoisclebs/cep-api/internal/domain/postalcode"
)

// The base path must be a single exported constant, and the self-link
// must be derived from it (no duplicated literal).
func TestSelfLinkDerivesFromBasePath(t *testing.T) {
	if PostalCodeBasePath != "/v1/postal-codes" {
		t.Fatalf("PostalCodeBasePath = %q, want %q", PostalCodeBasePath, "/v1/postal-codes")
	}
	rec := postalcode.PostalCodeRecord{PostalCode: "01001000"}
	got := NewPostalCodeResponse(rec).Links.Self.Href
	want := PostalCodeBasePath + "/01001000"
	if got != want {
		t.Errorf("self href = %q, want %q", got, want)
	}
}
