package api

import "testing"

func TestTaskCreatePayloadHashIgnoresTransportIdentityAndGrantConfirmation(t *testing.T) {
	one, err := taskCreatePayloadHash([]byte(`{"title":"A","priority":"high","operation_id":"one","confirm_grants":false}`))
	if err != nil {
		t.Fatal(err)
	}
	two, err := taskCreatePayloadHash([]byte(`{ "confirm_grants":true, "operation_id":"two", "priority":"high", "title":"A" }`))
	if err != nil {
		t.Fatal(err)
	}
	if one != two {
		t.Fatal("retry hash changed")
	}
	other, _ := taskCreatePayloadHash([]byte(`{"title":"B","priority":"high"}`))
	if one == other {
		t.Fatal("different payload accepted")
	}
}
