package deviceposture

import "testing"

func TestParseBitLockerProtectionStatus(t *testing.T) {
	cases := map[string]string{
		"2\r\n": BitLockerEnabled,
		"1":     BitLockerDisabled,
		"0":     StatusUnknown,
		"On":    StatusUnknown,
		"":      StatusUnknown,
	}
	for raw, want := range cases {
		if got := ParseBitLockerProtectionStatus(raw); got != want {
			t.Fatalf("ParseBitLockerProtectionStatus(%q)=%q, want %q", raw, got, want)
		}
	}
}

func TestParseWindowsHelloStatus(t *testing.T) {
	cases := map[string]string{
		"User State\r\n  NgcSet : YES\r\n": WindowsHelloConfigured,
		"  NgcSet : NO\n":                  WindowsHelloNotConfigured,
		"  NgcSet : ERROR\n":               StatusUnknown,
		"AzureAdJoined : YES\n":            StatusUnknown,
		"":                                 StatusUnknown,
	}
	for raw, want := range cases {
		if got := ParseWindowsHelloStatus(raw); got != want {
			t.Fatalf("ParseWindowsHelloStatus(%q)=%q, want %q", raw, got, want)
		}
	}
}

func TestUnknownReportIsClosed(t *testing.T) {
	report := Unknown()
	if report.BitLocker != StatusUnknown || report.WindowsHello != StatusUnknown {
		t.Fatalf("unexpected unknown report: %#v", report)
	}
}
