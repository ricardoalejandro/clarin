package whiteboard

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"testing"
)

type reconcileGoldenCorpus struct {
	Metadata struct {
		ExcalidrawVersion          string `json:"excalidrawVersion"`
		FractionalIndexingVersion  string `json:"fractionalIndexingVersion"`
		FractionalIndexingLicense  string `json:"fractionalIndexingLicense"`
		FractionalIndexingSource   string `json:"fractionalIndexingSourceSHA256"`
		UpstreamOrderCases         int    `json:"upstreamOrderCases"`
		TotalCases                 int    `json:"totalCases"`
		FractionalCases            int    `json:"fractionalCases"`
		FractionalErrorCases       int    `json:"fractionalErrorCases"`
		DeterministicIndexMutation struct {
			VersionNonceStart int64 `json:"versionNonceStart"`
			Updated           int64 `json:"updated"`
		} `json:"deterministicMutation"`
	} `json:"metadata"`
	Cases                []reconcileGoldenCase  `json:"cases"`
	FractionalCases      []fractionalGoldenCase `json:"fractionalCases"`
	FractionalErrorCases []fractionalErrorCase  `json:"fractionalErrorCases"`
}

type reconcileGoldenCase struct {
	Name                      string            `json:"name"`
	Origin                    string            `json:"origin"`
	AssertConvergent          bool              `json:"assertConvergent"`
	Local                     []json.RawMessage `json:"local"`
	Remote                    []json.RawMessage `json:"remote"`
	Expected                  []json.RawMessage `json:"expected"`
	ExpectedReverse           []json.RawMessage `json:"expectedReverse"`
	ExpectedRemoteRereconcile []json.RawMessage `json:"expectedRemoteRereconcile"`
}

type fractionalGoldenCase struct {
	Name     string   `json:"name"`
	Lower    *string  `json:"lower"`
	Upper    *string  `json:"upper"`
	Count    int      `json:"count"`
	Expected []string `json:"expected"`
}

type fractionalErrorCase struct {
	Name  string  `json:"name"`
	Lower *string `json:"lower"`
	Upper *string `json:"upper"`
	Count int     `json:"count"`
	Error string  `json:"error"`
}

func deterministicGoldenMutation(start, updated int64) elementIndexMutation {
	nonce := start
	return func(_ decodedElement, _ string) (int64, int64, error) {
		current := nonce
		nonce++
		return current, updated, nil
	}
}

func decodeElementObjects(t *testing.T, elements []json.RawMessage) []map[string]any {
	t.Helper()
	objects := make([]map[string]any, len(elements))
	for index, raw := range elements {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		if err := decoder.Decode(&objects[index]); err != nil {
			t.Fatalf("decode element %d: %v", index, err)
		}
	}
	return objects
}

func assertGoldenElements(t *testing.T, got, want []json.RawMessage) {
	t.Helper()
	gotObjects := decodeElementObjects(t, got)
	wantObjects := decodeElementObjects(t, want)
	if !reflect.DeepEqual(gotObjects, wantObjects) {
		gotJSON, _ := json.MarshalIndent(gotObjects, "", "  ")
		wantJSON, _ := json.MarshalIndent(wantObjects, "", "  ")
		t.Fatalf("differential mismatch\ngot:  %s\nwant: %s", gotJSON, wantJSON)
	}
}

func TestReconcileElementsMatchesExcalidrawV0181GoldenCorpus(t *testing.T) {
	raw, err := os.ReadFile("testdata/reconcile_v0.18.1_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus reconcileGoldenCorpus
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	if corpus.Metadata.ExcalidrawVersion != "0.18.1" ||
		corpus.Metadata.FractionalIndexingVersion != "3.2.0" ||
		corpus.Metadata.FractionalIndexingLicense != "CC0-1.0" ||
		corpus.Metadata.FractionalIndexingSource != "4166ec4320aa4c0233598c9a9b27b204090540c41c9ab1075a04f5957390a2a4" ||
		corpus.Metadata.UpstreamOrderCases != 54 ||
		corpus.Metadata.TotalCases != len(corpus.Cases) ||
		corpus.Metadata.FractionalCases != len(corpus.FractionalCases) ||
		corpus.Metadata.FractionalErrorCases != len(corpus.FractionalErrorCases) {
		t.Fatalf("unexpected golden metadata: %+v", corpus.Metadata)
	}
	start := corpus.Metadata.DeterministicIndexMutation.VersionNonceStart
	updated := corpus.Metadata.DeterministicIndexMutation.Updated
	for _, fixture := range corpus.Cases {
		fixture := fixture
		t.Run(fixture.Name, func(t *testing.T) {
			forward, err := reconcileElements(
				fixture.Local,
				fixture.Remote,
				deterministicGoldenMutation(start, updated),
			)
			if err != nil {
				t.Fatalf("forward reconciliation: %v", err)
			}
			assertGoldenElements(t, forward, fixture.Expected)

			reverse, err := reconcileElements(
				fixture.Remote,
				fixture.Local,
				deterministicGoldenMutation(start, updated),
			)
			if err != nil {
				t.Fatalf("reverse reconciliation: %v", err)
			}
			assertGoldenElements(t, reverse, fixture.ExpectedReverse)

			rereconciled, err := reconcileElements(
				fixture.Remote,
				forward,
				deterministicGoldenMutation(start, updated),
			)
			if err != nil {
				t.Fatalf("remote re-reconciliation: %v", err)
			}
			assertGoldenElements(t, rereconciled, fixture.ExpectedRemoteRereconcile)

			if fixture.AssertConvergent {
				forwardIDs := elementIDs(t, forward)
				if reverseIDs := elementIDs(t, reverse); !reflect.DeepEqual(forwardIDs, reverseIDs) {
					t.Fatalf("bidirectional IDs diverged: forward=%v reverse=%v", forwardIDs, reverseIDs)
				}
				if rereconciledIDs := elementIDs(t, rereconciled); !reflect.DeepEqual(forwardIDs, rereconciledIDs) {
					t.Fatalf("re-reconciled IDs diverged: forward=%v remote=%v", forwardIDs, rereconciledIDs)
				}
			}
		})
	}
}

func TestFractionalIndexPortMatchesVersion320GoldenCorpus(t *testing.T) {
	raw, err := os.ReadFile("testdata/reconcile_v0.18.1_golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus reconcileGoldenCorpus
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range corpus.FractionalCases {
		fixture := fixture
		t.Run(fixture.Name, func(t *testing.T) {
			got, err := generateNKeysBetween(fixture.Lower, fixture.Upper, fixture.Count)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, fixture.Expected) {
				t.Fatalf("got %v, want %v", got, fixture.Expected)
			}
			for index := range got {
				if fixture.Lower != nil && got[index] <= *fixture.Lower {
					t.Fatalf("key %q is not above lower bound %q", got[index], *fixture.Lower)
				}
				if fixture.Upper != nil && got[index] >= *fixture.Upper {
					t.Fatalf("key %q is not below upper bound %q", got[index], *fixture.Upper)
				}
				if index > 0 && got[index] <= got[index-1] {
					t.Fatalf("keys are not strictly ordered: %v", got)
				}
			}
		})
	}
	for _, fixture := range corpus.FractionalErrorCases {
		fixture := fixture
		t.Run("reject-"+fixture.Name, func(t *testing.T) {
			if _, err := generateNKeysBetween(fixture.Lower, fixture.Upper, fixture.Count); err == nil {
				t.Fatalf("expected rejection corresponding to fractional-indexing error %q", fixture.Error)
			}
		})
	}
}

func TestNormalizeElementsForStorageIsDeterministic(t *testing.T) {
	elements := []json.RawMessage{
		rawElement(t, `{"id":"a","version":1,"versionNonce":2,"future":{"preserved":true}}`),
		rawElement(t, `{"id":"b","version":3,"versionNonce":4}`),
	}
	first, err := NormalizeElementsForStorage(elements)
	if err != nil {
		t.Fatal(err)
	}
	second, err := NormalizeElementsForStorage(elements)
	if err != nil {
		t.Fatal(err)
	}
	assertGoldenElements(t, first, second)
	for index, raw := range first {
		var element struct {
			Version int64 `json:"version"`
			Updated int64 `json:"updated"`
		}
		if err := json.Unmarshal(raw, &element); err != nil {
			t.Fatal(err)
		}
		if element.Version != []int64{2, 4}[index] || element.Updated != 1 {
			t.Fatalf("element %d was not normalized with upstream mutation semantics: %s", index, raw)
		}
	}
}

func TestReconcileElementsRepairsTwentyThousandMissingIndices(t *testing.T) {
	const count = 20_000
	elements := make([]json.RawMessage, count)
	for index := range elements {
		elements[index] = json.RawMessage(fmt.Sprintf(
			`{"id":"element-%05d","version":1,"versionNonce":%d}`,
			index,
			index,
		))
	}
	merged, err := reconcileElements(
		nil,
		elements,
		deterministicGoldenMutation(10_000, 1),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(merged) != count {
		t.Fatalf("got %d elements, want %d", len(merged), count)
	}
	previous := ""
	for index, raw := range merged {
		var element struct {
			Index   string `json:"index"`
			Version int64  `json:"version"`
		}
		if err := json.Unmarshal(raw, &element); err != nil {
			t.Fatal(err)
		}
		if element.Index == "" || (previous != "" && element.Index <= previous) {
			t.Fatalf("invalid generated index at %d: previous=%q current=%q", index, previous, element.Index)
		}
		if element.Version != 2 {
			t.Fatalf("element %d mutated %d times", index, element.Version-1)
		}
		previous = element.Index
	}
}
