package whatsappcloud

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestClientSendUsesBearerProofAndOfficialPayload(t *testing.T) {
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get("Authorization") != "Bearer business-token" {
			t.Fatalf("missing business token bearer header")
		}
		if request.URL.Query().Get("appsecret_proof") == "" {
			t.Fatalf("missing appsecret_proof")
		}
		raw, _ := io.ReadAll(request.Body)
		body := string(raw)
		for _, expected := range []string{`"messaging_product":"whatsapp"`, `"type":"text"`, `"to":"51999999999"`} {
			if !strings.Contains(body, expected) {
				t.Fatalf("payload missing %s: %s", expected, body)
			}
		}
		return &http.Response{
			StatusCode: 200,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"contacts":[{"wa_id":"51999999999"}],"messages":[{"id":"wamid.1"}]}`)),
		}, nil
	})
	client := NewClient("https://graph.example", "v23.0", "app-id", "app-secret", &http.Client{Transport: transport})
	result, err := client.Send(context.Background(), "business-token", "phone-id", SendRequest{To: "51999999999", Text: "Hola"})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if result.MessageID != "wamid.1" || result.WAID != "51999999999" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestGraphErrorDoesNotExposeCredentials(t *testing.T) {
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: 400,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"error":{"message":"Invalid business-token for app-secret","code":100}}`)),
		}, nil
	})
	client := NewClient("https://graph.example", "v23.0", "app-id", "app-secret", &http.Client{Transport: transport})
	_, err := client.Send(context.Background(), "business-token", "phone-id", SendRequest{To: "51999999999", Text: "Hola"})
	if err == nil {
		t.Fatal("expected Graph error")
	}
	if strings.Contains(err.Error(), "business-token") || strings.Contains(err.Error(), "app-secret") {
		t.Fatalf("error exposed a credential: %v", err)
	}
}

func TestExchangeCodeKeepsOAuthSecretsOutOfURL(t *testing.T) {
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodPost {
			t.Fatalf("expected POST token exchange, got %s", request.Method)
		}
		if request.URL.Query().Get("client_secret") != "" || strings.Contains(request.URL.String(), "one-time-code") {
			t.Fatalf("OAuth credential leaked into URL: %s", request.URL.String())
		}
		raw, _ := io.ReadAll(request.Body)
		body := string(raw)
		if !strings.Contains(body, "client_secret=app-secret") || !strings.Contains(body, "code=one-time-code") {
			t.Fatalf("OAuth form is incomplete: %s", body)
		}
		return &http.Response{
			StatusCode: 200,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"access_token":"business-token","token_type":"bearer"}`)),
		}, nil
	})
	client := NewClient("https://graph.example", "v23.0", "app-id", "app-secret", &http.Client{Transport: transport})
	result, err := client.ExchangeCode(context.Background(), "one-time-code")
	if err != nil {
		t.Fatalf("ExchangeCode: %v", err)
	}
	if result.AccessToken != "business-token" {
		t.Fatalf("unexpected token response")
	}
}

func TestSanitizePagingURLRemovesProviderCredentials(t *testing.T) {
	clean := sanitizePagingURL("https://graph.example/v23.0/items?after=cursor&access_token=secret&appsecret_proof=proof", "https://graph.example")
	if strings.Contains(clean, "secret") || strings.Contains(clean, "proof") || !strings.Contains(clean, "after=cursor") {
		t.Fatalf("unexpected sanitized URL: %s", clean)
	}
	if malicious := sanitizePagingURL("https://attacker.example/steal?after=cursor", "https://graph.example"); malicious != "" {
		t.Fatalf("cross-origin paging URL was accepted: %s", malicious)
	}
}

func TestFindCoexistencePhoneRequiresMetaCoexistenceFlags(t *testing.T) {
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/v23.0/12345/phone_numbers" {
			t.Fatalf("unexpected path: %s", request.URL.Path)
		}
		return &http.Response{
			StatusCode: 200,
			Header:     make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{"data":[
				{"id":"11111","display_phone_number":"+51 999 999 999","verified_name":"Clarin","is_on_biz_app":true,"platform_type":"CLOUD_API"},
				{"id":"22222","display_phone_number":"+51 988 888 888","is_on_biz_app":false,"platform_type":"CLOUD_API"}
			]}`)),
		}, nil
	})
	client := NewClient("https://graph.example", "v23.0", "app-id", "app-secret", &http.Client{Transport: transport})
	phone, err := client.FindCoexistencePhone(context.Background(), "business-token", "12345", "")
	if err != nil {
		t.Fatalf("FindCoexistencePhone: %v", err)
	}
	if phone.ID != "11111" || !phone.IsOnBizApp || phone.PlatformType != "CLOUD_API" {
		t.Fatalf("unexpected coexistence phone: %#v", phone)
	}
	if _, err := client.FindCoexistencePhone(context.Background(), "business-token", "12345", "22222"); err == nil {
		t.Fatal("a standard Cloud API number was accepted as Coexistence")
	}
}

func TestSendNetworkFailureHasUnknownOutcome(t *testing.T) {
	transport := roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		return nil, errors.New("connection reset")
	})
	client := NewClient("https://graph.example", "v23.0", "app-id", "app-secret", &http.Client{Transport: transport})
	_, err := client.Send(context.Background(), "business-token", "phone-id", SendRequest{To: "51999999999", Text: "Hola"})
	if !errors.Is(err, ErrSendOutcomeUnknown) {
		t.Fatalf("network failure must have an ambiguous send outcome: %v", err)
	}
	if strings.Contains(err.Error(), "connection reset") {
		t.Fatalf("transport detail escaped the Cloud API boundary: %v", err)
	}
}
