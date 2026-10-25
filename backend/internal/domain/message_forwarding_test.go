package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func forwardingScore(v uint32) *uint32 { return &v }
func TestMessageForwardingObservedAndUnknown(t *testing.T) {
	flag := true
	cases := []struct {
		name      string
		flag      *bool
		score     *uint32
		supported bool
		state     string
		counter   *uint32
	}{
		{"legacy", nil, nil, false, ForwardingUnknown, nil},
		{"observed original", nil, nil, true, ForwardingNotForwarded, forwardingScore(0)},
		{"forwarded missing count", &flag, nil, true, ForwardingForwarded, nil},
		{"score without flag", nil, forwardingScore(2), true, ForwardingForwarded, forwardingScore(2)},
		{"frequent", &flag, forwardingScore(5), true, ForwardingFrequentlyForwarded, forwardingScore(5)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ClassifyProviderForwarding(tc.flag, tc.score, tc.supported)
			if got.State != tc.state || (got.Score == nil) != (tc.counter == nil) || (got.Score != nil && *got.Score != *tc.counter) {
				t.Fatalf("classification %+v", got)
			}
		})
	}
	raw, _ := json.Marshal(MessageForwarding{})
	if string(raw) != `{"state":"unknown","score":null}` {
		t.Fatalf("legacy JSON %s", raw)
	}
}
func TestMessageForwardingMergeNeverDegradesOrInventsCounter(t *testing.T) {
	frequent := MessageForwarding{State: ForwardingFrequentlyForwarded, Score: forwardingScore(7)}
	for _, incoming := range []MessageForwarding{{}, {State: ForwardingNotForwarded}, {State: ForwardingForwarded, Score: forwardingScore(1)}} {
		got := MergeMessageForwarding(frequent, incoming)
		if got.State != ForwardingFrequentlyForwarded || got.Score == nil || *got.Score != 7 {
			t.Fatal(got)
		}
	}
	got := MergeMessageForwarding(MessageForwarding{State: ForwardingNotForwarded}, MessageForwarding{State: ForwardingForwarded})
	if got.State != ForwardingForwarded || got.Score != nil {
		t.Fatal("invented absent forwarding score", got)
	}
}
func TestMessageForwardingNextPreservesAuthorshipAndSaturates(t *testing.T) {
	original := Message{IsFromMe: true, Forwarding: MessageForwarding{State: ForwardingNotForwarded}}
	own, err := NextForwarding(original)
	if err != nil || own.State != ForwardingNotForwarded || own.Score == nil || *own.Score != 0 {
		t.Fatal(own, err)
	}
	original.IsFromMe = false
	received, err := NextForwarding(original)
	if err != nil || received.State != ForwardingForwarded || *received.Score != 1 {
		t.Fatal(received, err)
	}
	original.IsFromMe = true
	original.Forwarding = MessageForwarding{State: ForwardingForwarded, Score: forwardingScore(4)}
	forwarded, err := NextForwarding(original)
	if err != nil || forwarded.State != ForwardingFrequentlyForwarded || *forwarded.Score != 5 {
		t.Fatal(forwarded, err)
	}
	original.Forwarding.Score = forwardingScore(^uint32(0))
	saturated, err := NextForwarding(original)
	if err != nil || *saturated.Score != ^uint32(0) {
		t.Fatal(saturated, err)
	}
	original.Forwarding = MessageForwarding{}
	if _, err = NextForwarding(original); err == nil || !strings.Contains(err.Error(), "sincroniza") {
		t.Fatal("unknown source accepted")
	}
	original.Forwarding = MessageForwarding{State: ForwardingForwarded}
	if _, err = NextForwarding(original); err == nil {
		t.Fatal("invented missing score")
	}
}
func TestMessageForwardFingerprintIgnoresReceiptsButGuardsContent(t *testing.T) {
	body := "Original"
	m := &Message{Body: &body, Forwarding: MessageForwarding{State: ForwardingNotForwarded}}
	before := MessageForwardFingerprint(m)
	m.IsRead = true
	m.Status = &body
	if MessageForwardFingerprint(m) != before {
		t.Fatal("receipt invalidated source")
	}
	changed := "Changed"
	m.Body = &changed
	if MessageForwardFingerprint(m) == before {
		t.Fatal("content not bound")
	}
}
