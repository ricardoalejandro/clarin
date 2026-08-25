package repository

import (
	"math"
	"testing"

	"github.com/google/uuid"
)

func TestPlanWhiteboardFolderPlacementUsesSparseOrders(t *testing.T) {
	target := uuid.New()
	first := uuid.New()
	second := uuid.New()
	siblings := []whiteboardFolderSiblingOrder{
		{ID: first, SortOrder: 1024},
		{ID: second, SortOrder: 4096},
	}

	plan, err := planWhiteboardFolderPlacement(target, &second, siblings)
	if err != nil {
		t.Fatal(err)
	}
	if plan.TargetSortOrder != 2560 || len(plan.Rebalanced) != 0 {
		t.Fatalf("expected sparse midpoint without rebalance, got %#v", plan)
	}

	plan, err = planWhiteboardFolderPlacement(target, nil, siblings)
	if err != nil {
		t.Fatal(err)
	}
	if plan.TargetSortOrder != 5120 || len(plan.Rebalanced) != 0 {
		t.Fatalf("expected sparse final order without rebalance, got %#v", plan)
	}
}

func TestPlanWhiteboardFolderPlacementRebalancesAtomicallyWhenGapIsExhausted(t *testing.T) {
	target := uuid.New()
	first := uuid.New()
	second := uuid.New()
	siblings := []whiteboardFolderSiblingOrder{
		{ID: first, SortOrder: math.MinInt64},
		{ID: second, SortOrder: math.MinInt64 + 1},
	}

	plan, err := planWhiteboardFolderPlacement(target, &second, siblings)
	if err != nil {
		t.Fatal(err)
	}
	if plan.TargetSortOrder != 2048 || plan.Rebalanced[first] != 1024 || plan.Rebalanced[second] != 3072 {
		t.Fatalf("unexpected canonical rebalance: %#v", plan)
	}
}

func TestPlanWhiteboardFolderPlacementRejectsUnknownAnchor(t *testing.T) {
	unknown := uuid.New()
	_, err := planWhiteboardFolderPlacement(uuid.New(), &unknown, []whiteboardFolderSiblingOrder{{ID: uuid.New(), SortOrder: 1024}})
	if err != ErrWhiteboardInvalid {
		t.Fatalf("expected invalid anchor, got %v", err)
	}
}

func TestMidpointWhiteboardFolderOrderHandlesFullSignedRange(t *testing.T) {
	middle, ok := midpointWhiteboardFolderOrder(math.MinInt64, 0)
	if !ok || middle <= math.MinInt64 || middle >= 0 {
		t.Fatalf("expected safe midpoint across the signed range, got %d (ok=%v)", middle, ok)
	}
}
