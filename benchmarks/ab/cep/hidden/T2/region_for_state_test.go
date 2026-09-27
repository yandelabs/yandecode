package postalcode

import "testing"

func TestRegionForState(t *testing.T) {
	cases := map[string]string{
		"AM": "Norte", "PA": "Norte",
		"BA": "Nordeste", "PE": "Nordeste",
		"DF": "Centro-Oeste", "GO": "Centro-Oeste",
		"SP": "Sudeste", "RJ": "Sudeste",
		"RS": "Sul", "SC": "Sul",
		"ZZ": "", "": "", "sp": "",
	}
	for code, want := range cases {
		if got := RegionForState(code); got != want {
			t.Errorf("RegionForState(%q) = %q, want %q", code, got, want)
		}
	}
}
