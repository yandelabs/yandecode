package postalcode

import "testing"

// Regression guard: StrictValidate must accept only the bare 8-digit form
// and the NNNNN-NNN mask, rejecting any other separator or character.
func TestStrictValidateRejectsInvalidSeparators(t *testing.T) {
	valid := []string{"12345678", "12345-678", "01001000", "01001-000"}
	for _, in := range valid {
		if err := StrictValidate(in); err != nil {
			t.Errorf("StrictValidate(%q) = %v, want nil", in, err)
		}
	}
	invalid := []string{"12345 678", "12345.678", "12345a678", "12345/678", "1234-5678"}
	for _, in := range invalid {
		if err := StrictValidate(in); err == nil {
			t.Errorf("StrictValidate(%q) = nil, want error", in)
		}
	}
}
