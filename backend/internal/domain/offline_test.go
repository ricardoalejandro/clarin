package domain

import (
	"encoding/json"
	"testing"
)

func TestOfflineTerminalJSONIncludesEmptyGrants(t *testing.T) {
	raw, err := json.Marshal(OfflineTerminal{Grants: []OfflineGrant{}})
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatal(err)
	}
	if string(payload["grants"]) != "[]" {
		t.Fatalf("grants=%s, want []", payload["grants"])
	}
}

func TestOfflineSelectionResourceTypesAreClosed(t *testing.T) {
	cases := map[string]string{
		OfflineResourceWhiteboard: OfflineModuleWhiteboards,
		OfflineResourceTaskList:   OfflineModuleTasks,
		OfflineResourceContact:    OfflineModuleContacts,
		OfflineResourceProgram:    OfflineModulePrograms,
	}
	for resourceType, wantModule := range cases {
		module, ok := OfflineModuleForResourceType(resourceType)
		if !ok || module != wantModule {
			t.Fatalf("resource %s mapped to %s,%v", resourceType, module, ok)
		}
	}
	for _, forbidden := range []string{"task", "folder", "account", "program_participant"} {
		if _, ok := OfflineModuleForResourceType(forbidden); ok {
			t.Fatalf("unsupported resource type %s was accepted", forbidden)
		}
	}
	if module, ok := OfflineModuleForOperationResourceType(OfflineEntityTask); !ok || module != OfflineModuleTasks {
		t.Fatal("task operation target was not mapped to the tasks module")
	}
}

func TestNormalizeOfflineDevicePostureIsClosedAndBackwardCompatible(t *testing.T) {
	unknown, ok := NormalizeOfflineDevicePosture(OfflineDevicePosture{})
	if !ok || unknown.BitLocker != OfflinePostureUnknown || unknown.WindowsHello != OfflinePostureUnknown {
		t.Fatalf("missing posture was not normalized safely: %#v, %v", unknown, ok)
	}
	secure, ok := NormalizeOfflineDevicePosture(OfflineDevicePosture{BitLocker: OfflineBitLockerEnabled, WindowsHello: OfflineWindowsHelloConfigured})
	if !ok || OfflineDevicePostureRequiresRiskAcknowledgement(secure) {
		t.Fatalf("secure posture unexpectedly requires acknowledgement: %#v, %v", secure, ok)
	}
	for _, invalid := range []OfflineDevicePosture{
		{BitLocker: "on", WindowsHello: OfflineWindowsHelloConfigured},
		{BitLocker: OfflineBitLockerEnabled, WindowsHello: "yes"},
	} {
		if _, ok := NormalizeOfflineDevicePosture(invalid); ok {
			t.Fatalf("invalid posture accepted: %#v", invalid)
		}
	}
}

func TestOfflineDevicePostureRequiresAcknowledgementUnlessFullyProtected(t *testing.T) {
	for _, posture := range []OfflineDevicePosture{
		{BitLocker: OfflineBitLockerDisabled, WindowsHello: OfflineWindowsHelloConfigured},
		{BitLocker: OfflineBitLockerEnabled, WindowsHello: OfflineWindowsHelloNotConfigured},
		{BitLocker: OfflinePostureUnknown, WindowsHello: OfflinePostureUnknown},
	} {
		if !OfflineDevicePostureRequiresRiskAcknowledgement(posture) {
			t.Fatalf("risk acknowledgement not required for %#v", posture)
		}
	}
}
