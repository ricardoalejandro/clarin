package domain

import "testing"

func TestMessageSharingDefaultsAndStrictVariants(t *testing.T) {
	mode, err := NormalizeMessageSharingMode("")
	if err != nil || mode != MessageSharingNative {
		t.Fatal(mode, err)
	}
	variant, err := NormalizeMessageContentVariant("")
	if err != nil || variant != MessageContentOriginal {
		t.Fatal(variant, err)
	}
	for _, bad := range []string{"auto", "COPY", " copy "} {
		if _, err := NormalizeMessageSharingMode(bad); err == nil {
			t.Fatal("invalid mode accepted", bad)
		}
	}
	if _, err := NormalizeMessageContentVariant("infer"); err == nil {
		t.Fatal("variant guessed")
	}
}
func TestMessageSharingPolicyCannotBeLaunderedByCopy(t *testing.T) {
	for _, tc := range []struct {
		state string
		want  MessageSharingLimits
	}{{ForwardingUnknown, MessageSharingLimits{5, 5}}, {ForwardingNotForwarded, MessageSharingLimits{5, 5}}, {ForwardingForwarded, MessageSharingLimits{5, 1}}, {ForwardingFrequentlyForwarded, MessageSharingLimits{1, 1}}} {
		source := &Message{Forwarding: MessageForwarding{State: tc.state}}
		limits := EffectiveMessageSharingLimits(source)
		if limits != tc.want {
			t.Fatal(tc.state, limits)
		}
		copy := &Message{Forwarding: MessageForwarding{State: ForwardingNotForwarded}, SharingLimits: &limits}
		if got := EffectiveMessageSharingLimits(copy); got != tc.want {
			t.Fatal("copy widened", got)
		}
		wide := MessageSharingLimits{5, 5}
		copy.SharingLimits = MergeMessageSharingLimits(copy.SharingLimits, &wide)
		if got := EffectiveMessageSharingLimits(copy); got != tc.want {
			t.Fatal("echo widened", got)
		}
	}
	if MergeMessageSharingLimits(nil, nil) != nil {
		t.Fatal("legacy policy invented")
	}
	invalid := MessageSharingLimits{99, 99}
	if invalid.Valid() || invalid.Normalize() != (MessageSharingLimits{1, 1}) {
		t.Fatal("invalid policy is not fail closed")
	}
	if (MessageSharingLimits{1, 5}).Valid() {
		t.Fatal("group limit exceeds chat limit")
	}
}
func TestMessageSharingFingerprintPreservesLegacyAndFreezesPolicy(t *testing.T) {
	message := &Message{}
	if got := MessageForwardFingerprint(message); got != "caa088d72bd8bb05afd74ee1ecc3c03f45fcb9b1619e4c627376151401479bfb" {
		t.Fatal("nil-policy changed legacy fingerprint", got)
	}
	before := MessageForwardFingerprint(message)
	message.SharingLimits = &MessageSharingLimits{5, 1}
	if MessageForwardFingerprint(message) == before {
		t.Fatal("policy not frozen")
	}
	before = MessageForwardFingerprint(message)
	message.SharingLimits = &MessageSharingLimits{1, 1}
	if MessageForwardFingerprint(message) == before {
		t.Fatal("hardening not frozen")
	}
}

func TestNativeSharingOutputLimitsFreezePreparedForward(t *testing.T) {
	for _, tc := range []struct {
		name   string
		source Message
		want   MessageSharingLimits
	}{
		{"received original", Message{Forwarding: MessageForwarding{State: ForwardingNotForwarded}}, MessageSharingLimits{5, 1}},
		{"own original", Message{IsFromMe: true, Forwarding: MessageForwarding{State: ForwardingNotForwarded}}, MessageSharingLimits{5, 5}},
		{"frequent threshold", Message{Forwarding: MessageForwarding{State: ForwardingForwarded, Score: forwardingScore(4)}}, MessageSharingLimits{1, 1}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := MessageForwardFingerprint(&tc.source)
			limits, err := MessageSharingOutputLimits(&tc.source, MessageSharingNative)
			if err != nil || limits != tc.want {
				t.Fatal(limits, err)
			}
			incompleteEcho := &Message{IsFromMe: true, SharingLimits: &limits}
			if got := EffectiveMessageSharingLimits(incompleteEcho); got != tc.want {
				t.Fatal("incomplete echo widened", got)
			}
			copyLimits, err := MessageSharingOutputLimits(&tc.source, MessageSharingCopy)
			if err != nil || copyLimits != EffectiveMessageSharingLimits(&tc.source) {
				t.Fatal("copy changed source policy", copyLimits, err)
			}
			if MessageForwardFingerprint(&tc.source) != before {
				t.Fatal("output computation mutated source flags")
			}
		})
	}
	if _, err := MessageSharingOutputLimits(&Message{}, MessageSharingNative); err == nil {
		t.Fatal("native unknown metadata accepted")
	}
}
