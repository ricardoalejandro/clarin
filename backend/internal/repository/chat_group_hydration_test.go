package repository

import (
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestGroupMessageProjectionsRetainEveryScopedCopy(t *testing.T) {
	account, chat, id := uuid.New(), uuid.New(), uuid.New()
	target := &domain.Message{ID: id, AccountID: account, ChatID: chat}
	window := &domain.Message{ID: id, AccountID: account, ChatID: chat}
	other := &domain.Message{ID: uuid.New(), AccountID: account, ChatID: chat}
	foreignAccount := &domain.Message{ID: id, AccountID: uuid.New(), ChatID: chat}
	foreignChat := &domain.Message{ID: id, AccountID: account, ChatID: uuid.New()}
	ids, projections := groupMessageProjections(account, chat, []*domain.Message{target, nil, window, foreignAccount, other, foreignChat})
	if len(ids) != 2 || ids[0] != id || ids[1] != other.ID {
		t.Fatal("hydration must query each scoped message ID exactly once")
	}
	if len(projections[id]) != 2 || projections[id][0] != target || projections[id][1] != window {
		t.Fatal("target and window copies must both receive canonical hydration")
	}
	if len(projections[other.ID]) != 1 || projections[other.ID][0] != other {
		t.Fatal("distinct messages must retain their own projection")
	}
}
