package service

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func TestOfflineV3TaskEffectRejectsInvalidBindingBeforeEffects(t *testing.T) {
	valid := repository.OfflineV3TaskEffect{ID: uuid.New(), GrantID: uuid.New(), AccountID: uuid.New(), OperationID: uuid.New(), TaskID: uuid.New(), ActorID: uuid.New(), Action: domain.OfflineV3ActionTasksComplete, TaskVersion: 2}
	for name, mutate := range map[string]func(*repository.OfflineV3TaskEffect){
		"grant":   func(e *repository.OfflineV3TaskEffect) { e.GrantID = uuid.Nil },
		"actor":   func(e *repository.OfflineV3TaskEffect) { e.ActorID = uuid.Nil },
		"version": func(e *repository.OfflineV3TaskEffect) { e.TaskVersion = 0 },
		"action":  func(e *repository.OfflineV3TaskEffect) { e.Action = "tasks.delete" },
		"origin":  func(e *repository.OfflineV3TaskEffect) { e.Origin = "untrusted_import" },
		"recurrence account": func(e *repository.OfflineV3TaskEffect) {
			e.RecurrenceSeed = &domain.Task{ID: e.TaskID, AccountID: uuid.New()}
		},
		"recurrence task": func(e *repository.OfflineV3TaskEffect) {
			e.RecurrenceSeed = &domain.Task{ID: uuid.New(), AccountID: e.AccountID}
		},
	} {
		t.Run(name, func(t *testing.T) {
			effect := valid
			mutate(&effect)
			if err := (&TaskService{}).ApplyOfflineV3TaskEffect(context.Background(), effect); err == nil {
				t.Fatal("invalid effect accepted")
			}
		})
	}
}

func TestOfflineV3TaskEffectReconcilesCurrentCanonicalVersion(t *testing.T) {
	for _, action := range []string{domain.OfflineV3ActionTasksCreate, domain.OfflineV3ActionTasksComplete} {
		effect := repository.OfflineV3TaskEffect{Action: action, TaskVersion: 3}
		if got := offlineV3TaskEffectAction(effect, 4); got != "updated" {
			t.Fatalf("stale effect rewound canonical action: %s", got)
		}
		want := "completed"
		if action == domain.OfflineV3ActionTasksCreate {
			want = "created"
		}
		if got := offlineV3TaskEffectAction(effect, 3); got != want {
			t.Fatalf("action %s want%s", got, want)
		}
	}
}
