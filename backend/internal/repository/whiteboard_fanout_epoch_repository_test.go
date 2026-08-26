package repository

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWhiteboardFanoutEpochHoldsBoardShareLockAcrossCallback(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve repository source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "whiteboard_fanout_epoch_repository.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	lock := strings.Index(source, "SELECT access_revision FROM whiteboards")
	share := strings.Index(source, "FOR SHARE")
	callback := strings.Index(source, "callback(revision)")
	release := strings.LastIndex(source, "release()")
	if lock < 0 || share <= lock || callback <= share || release <= callback {
		t.Fatalf("fanout epoch must lock board -> run enqueue callback -> release: lock=%d share=%d callback=%d release=%d",
			lock, share, callback, release)
	}
	if strings.Contains(source, "task_location_views") || strings.Contains(source, "task_folders") || strings.Contains(source, "task_lists") {
		t.Fatal("fanout epoch acquired a Work parent lock and can invert parent -> view -> board order")
	}
	if strings.Contains(source, "return tx.Rollback") || !strings.Contains(source, "context.WithTimeout(context.Background(), time.Second)") {
		t.Fatal("post-enqueue lock release can be reported as a false authorization failure")
	}
}
