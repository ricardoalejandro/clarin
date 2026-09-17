package deviceposture

import "strings"

const (
	BitLockerEnabled  = "enabled"
	BitLockerDisabled = "disabled"
	StatusUnknown     = "unknown"

	WindowsHelloConfigured    = "configured"
	WindowsHelloNotConfigured = "not_configured"
)

type Report struct {
	BitLocker    string `json:"bitlocker"`
	WindowsHello string `json:"windows_hello"`
}

func Unknown() Report {
	return Report{BitLocker: StatusUnknown, WindowsHello: StatusUnknown}
}

// ParseBitLockerProtectionStatus consumes the numeric ProtectionStatus value
// returned by Windows: 0 unknown, 1 off and 2 on. Numeric output avoids
// depending on the display language configured in PowerShell.
func ParseBitLockerProtectionStatus(raw string) string {
	switch strings.TrimSpace(raw) {
	case "2":
		return BitLockerEnabled
	case "1":
		return BitLockerDisabled
	default:
		return StatusUnknown
	}
}

// ParseWindowsHelloStatus consumes dsregcmd /status without retaining any of
// its identifiers. NgcSet is the documented current-user Hello key signal.
func ParseWindowsHelloStatus(raw string) string {
	for _, line := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 || !strings.EqualFold(strings.TrimSpace(parts[0]), "NgcSet") {
			continue
		}
		switch strings.ToUpper(strings.TrimSpace(parts[1])) {
		case "YES":
			return WindowsHelloConfigured
		case "NO":
			return WindowsHelloNotConfigured
		default:
			return StatusUnknown
		}
	}
	return StatusUnknown
}
