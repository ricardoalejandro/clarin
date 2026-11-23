package whatsapp

import (
	"sync"
	"sync/atomic"
	"testing"

	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
)

func TestDeviceStartupNeverImportsContactsForExistingSession(t *testing.T) {
	jid := types.NewADJID("51900000001", 0, 2)
	for _, device := range []*store.Device{nil, {ID: &jid}} {
		instance := &DeviceInstance{InitialPairing: deviceNeedsInitialContactSync(device)}
		for i := 0; i < 3; i++ {
			if instance.consumeInitialPairingContactSync() {
				t.Fatal("restart/reconnection scheduled CRM contact import")
			}
		}
	}
}

func TestDeviceFirstPairingImportsOnlyOnceAcrossReconnects(t *testing.T) {
	device := &store.Device{}
	instance := &DeviceInstance{InitialPairing: deviceNeedsInitialContactSync(device)}
	// Store.ID becomes available before Connected; the original pairing intent remains.
	jid := types.NewADJID("51900000001", 0, 2)
	device.ID = &jid
	if !instance.consumeInitialPairingContactSync() {
		t.Fatal("first QR pairing lost its initial contact import")
	}
	if instance.consumeInitialPairingContactSync() {
		t.Fatal("reconnection repeated CRM contact import")
	}
	restarted := &DeviceInstance{InitialPairing: deviceNeedsInitialContactSync(device)}
	if restarted.consumeInitialPairingContactSync() {
		t.Fatal("new runtime treated paired session as a new import")
	}
}

func TestDeviceConcurrentConnectedCallbacksConsumeInitialImportOnce(t *testing.T) {
	instance := &DeviceInstance{InitialPairing: true}
	var calls atomic.Int32
	var work sync.WaitGroup
	for i := 0; i < 20; i++ {
		work.Add(1)
		go func() {
			defer work.Done()
			if instance.consumeInitialPairingContactSync() {
				calls.Add(1)
			}
		}()
	}
	work.Wait()
	if calls.Load() != 1 {
		t.Fatalf("initial import scheduled %d times", calls.Load())
	}
}
