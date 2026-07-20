package whatsappcloud

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	baseURL   string
	version   string
	appID     string
	appSecret string
	http      *http.Client
}

func NewClient(baseURL, version, appID, appSecret string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{
			Timeout: 20 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	return &Client{
		baseURL:   strings.TrimRight(strings.TrimSpace(baseURL), "/"),
		version:   strings.Trim(strings.TrimSpace(version), "/"),
		appID:     strings.TrimSpace(appID),
		appSecret: strings.TrimSpace(appSecret),
		http:      httpClient,
	}
}

type GraphError struct {
	HTTPStatus int
	Message    string
	Type       string
	Code       int
	Subcode    int
	TraceID    string
}

func (e *GraphError) Error() string {
	if e == nil {
		return "Meta Graph API error"
	}
	if e.Code != 0 {
		return fmt.Sprintf("Meta Graph API rejected the request (code %d): %s", e.Code, e.Message)
	}
	return fmt.Sprintf("Meta Graph API rejected the request (HTTP %d): %s", e.HTTPStatus, e.Message)
}

type OAuthToken struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int64  `json:"expires_in"`
}

type PhoneNumber struct {
	ID                     string `json:"id"`
	DisplayPhoneNumber     string `json:"display_phone_number"`
	VerifiedName           string `json:"verified_name"`
	QualityRating          string `json:"quality_rating"`
	CodeVerificationStatus string `json:"code_verification_status"`
	IsOnBizApp             bool   `json:"is_on_biz_app"`
	PlatformType           string `json:"platform_type"`
}

type Template struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Status         string          `json:"status"`
	Category       string          `json:"category"`
	Language       string          `json:"language"`
	Components     json.RawMessage `json:"components"`
	RejectedReason string          `json:"rejected_reason"`
}

type SendRequest struct {
	To       string
	Text     string
	Template *TemplateMessage
}

type TemplateMessage struct {
	Name       string          `json:"name"`
	Language   string          `json:"language"`
	Components json.RawMessage `json:"components,omitempty"`
}

type SendResult struct {
	MessageID string
	WAID      string
}

var ErrSendOutcomeUnknown = errors.New("Meta send outcome is unknown")

func (c *Client) ExchangeCode(ctx context.Context, code string) (*OAuthToken, error) {
	if c.appID == "" || c.appSecret == "" {
		return nil, errors.New("Meta App ID/App Secret are not configured")
	}
	values := url.Values{}
	values.Set("client_id", c.appID)
	values.Set("client_secret", c.appSecret)
	values.Set("code", strings.TrimSpace(code))
	endpoint := c.baseURL + "/" + c.version + "/oauth/access_token"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(values.Encode()))
	if err != nil {
		return nil, errors.New("could not create Meta OAuth request")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, errors.New("Meta OAuth service is unavailable")
	}
	defer resp.Body.Close()
	var result OAuthToken
	if err := decodeGraphResponse(resp, &result); err != nil {
		return nil, redactGraphError(err, c.appSecret, code)
	}
	if strings.TrimSpace(result.AccessToken) == "" {
		return nil, errors.New("Meta returned an empty business token")
	}
	return &result, nil
}

func (c *Client) SubscribeApp(ctx context.Context, accessToken, wabaID string) error {
	return c.do(ctx, http.MethodPost, c.objectURL(wabaID, "subscribed_apps"), accessToken, map[string]any{}, nil)
}

func (c *Client) GetPhoneNumber(ctx context.Context, accessToken, phoneNumberID string) (*PhoneNumber, error) {
	endpoint := c.objectURL(phoneNumberID, "") + "?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,is_on_biz_app,platform_type"
	var phone PhoneNumber
	if err := c.do(ctx, http.MethodGet, endpoint, accessToken, nil, &phone); err != nil {
		return nil, err
	}
	if phone.ID == "" {
		phone.ID = strings.TrimSpace(phoneNumberID)
	}
	return &phone, nil
}

func (c *Client) FindCoexistencePhone(ctx context.Context, accessToken, wabaID, requestedPhoneNumberID string) (*PhoneNumber, error) {
	requestedPhoneNumberID = strings.TrimSpace(requestedPhoneNumberID)
	endpoint := c.objectURL(wabaID, "phone_numbers") + "?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,is_on_biz_app,platform_type&limit=100"
	matches := make([]PhoneNumber, 0, 1)
	for page := 0; endpoint != ""; page++ {
		if page >= 20 {
			return nil, errors.New("Meta phone number pagination exceeded the safe limit")
		}
		var response struct {
			Data   []PhoneNumber `json:"data"`
			Paging struct {
				Next string `json:"next"`
			} `json:"paging"`
		}
		if err := c.do(ctx, http.MethodGet, endpoint, accessToken, nil, &response); err != nil {
			return nil, err
		}
		for _, phone := range response.Data {
			if requestedPhoneNumberID != "" && phone.ID != requestedPhoneNumberID {
				continue
			}
			if phone.IsOnBizApp && strings.EqualFold(strings.TrimSpace(phone.PlatformType), "CLOUD_API") {
				matches = append(matches, phone)
			} else if requestedPhoneNumberID != "" {
				return nil, errors.New("the selected number is not confirmed by Meta for WhatsApp Business App coexistence")
			}
		}
		var err error
		endpoint, err = c.nextPageURL(response.Paging.Next)
		if err != nil {
			return nil, err
		}
	}
	if len(matches) == 0 {
		return nil, errors.New("Meta returned no WhatsApp Business App coexistence number for this WABA")
	}
	if len(matches) > 1 {
		return nil, errors.New("Meta returned multiple coexistence numbers; select the number again in Embedded Signup")
	}
	return &matches[0], nil
}

func (c *Client) ValidatePhoneBelongsToWABA(ctx context.Context, accessToken, wabaID, phoneNumberID string) error {
	endpoint := c.objectURL(wabaID, "phone_numbers") + "?fields=id&limit=100"
	for page := 0; endpoint != ""; page++ {
		if page >= 20 {
			return errors.New("Meta phone number pagination exceeded the safe limit")
		}
		var response struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
			Paging struct {
				Next string `json:"next"`
			} `json:"paging"`
		}
		if err := c.do(ctx, http.MethodGet, endpoint, accessToken, nil, &response); err != nil {
			return err
		}
		for _, phone := range response.Data {
			if phone.ID == strings.TrimSpace(phoneNumberID) {
				return nil
			}
		}
		var err error
		endpoint, err = c.nextPageURL(response.Paging.Next)
		if err != nil {
			return err
		}
	}
	return errors.New("the selected phone number does not belong to the selected WhatsApp Business Account")
}

func (c *Client) ListTemplates(ctx context.Context, accessToken, wabaID string) ([]Template, error) {
	endpoint := c.objectURL(wabaID, "message_templates") + "?fields=id,name,status,category,language,components,rejected_reason&limit=100"
	templates := make([]Template, 0)
	for page := 0; endpoint != ""; page++ {
		if page >= 20 {
			return nil, errors.New("Meta template pagination exceeded the safe limit")
		}
		var response struct {
			Data   []Template `json:"data"`
			Paging struct {
				Next string `json:"next"`
			} `json:"paging"`
		}
		if err := c.do(ctx, http.MethodGet, endpoint, accessToken, nil, &response); err != nil {
			return nil, err
		}
		templates = append(templates, response.Data...)
		var err error
		endpoint, err = c.nextPageURL(response.Paging.Next)
		if err != nil {
			return nil, err
		}
	}
	return templates, nil
}

func (c *Client) Send(ctx context.Context, accessToken, phoneNumberID string, input SendRequest) (*SendResult, error) {
	payload := map[string]any{
		"messaging_product": "whatsapp",
		"recipient_type":    "individual",
		"to":                strings.TrimSpace(input.To),
	}
	if input.Template != nil {
		template := map[string]any{
			"name": input.Template.Name,
			"language": map[string]string{
				"code": input.Template.Language,
			},
		}
		if len(input.Template.Components) > 0 && string(input.Template.Components) != "null" && string(input.Template.Components) != "[]" {
			var components any
			if err := json.Unmarshal(input.Template.Components, &components); err != nil {
				return nil, fmt.Errorf("invalid template components: %w", err)
			}
			template["components"] = components
		}
		payload["type"] = "template"
		payload["template"] = template
	} else {
		payload["type"] = "text"
		payload["text"] = map[string]any{"preview_url": false, "body": input.Text}
	}
	var response struct {
		Contacts []struct {
			WAID string `json:"wa_id"`
		} `json:"contacts"`
		Messages []struct {
			ID string `json:"id"`
		} `json:"messages"`
	}
	if err := c.do(ctx, http.MethodPost, c.objectURL(phoneNumberID, "messages"), accessToken, payload, &response); err != nil {
		var graphError *GraphError
		if errors.As(err, &graphError) {
			return nil, err
		}
		return nil, fmt.Errorf("%w: Meta did not provide a definitive response", ErrSendOutcomeUnknown)
	}
	if len(response.Messages) == 0 || response.Messages[0].ID == "" {
		return nil, errors.New("Meta accepted no message")
	}
	result := &SendResult{MessageID: response.Messages[0].ID}
	if len(response.Contacts) > 0 {
		result.WAID = response.Contacts[0].WAID
	}
	return result, nil
}

func (c *Client) MarkRead(ctx context.Context, accessToken, phoneNumberID, messageID string) error {
	payload := map[string]any{
		"messaging_product": "whatsapp",
		"status":            "read",
		"message_id":        strings.TrimSpace(messageID),
	}
	return c.do(ctx, http.MethodPost, c.objectURL(phoneNumberID, "messages"), accessToken, payload, nil)
}

func (c *Client) objectURL(id, edge string) string {
	endpoint := c.baseURL + "/" + c.version + "/" + url.PathEscape(strings.TrimSpace(id))
	if strings.TrimSpace(edge) != "" {
		endpoint += "/" + strings.Trim(strings.TrimSpace(edge), "/")
	}
	return endpoint
}

func (c *Client) do(ctx context.Context, method, endpoint, accessToken string, payload any, target any) error {
	var body io.Reader
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("encode Meta request: %w", err)
		}
		body = bytes.NewReader(raw)
	}
	appSecretProof := ""
	if strings.TrimSpace(accessToken) != "" && c.appSecret != "" {
		parsed, err := url.Parse(endpoint)
		if err != nil {
			return fmt.Errorf("parse Meta endpoint: %w", err)
		}
		mac := hmac.New(sha256.New, []byte(c.appSecret))
		_, _ = mac.Write([]byte(strings.TrimSpace(accessToken)))
		query := parsed.Query()
		appSecretProof = hex.EncodeToString(mac.Sum(nil))
		query.Set("appsecret_proof", appSecretProof)
		parsed.RawQuery = query.Encode()
		endpoint = parsed.String()
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return fmt.Errorf("create Meta request: %w", err)
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if strings.TrimSpace(accessToken) != "" {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(accessToken))
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return errors.New("Meta Graph API is unavailable")
	}
	defer resp.Body.Close()
	return redactGraphError(decodeGraphResponse(resp, target), accessToken, c.appSecret, appSecretProof)
}

func decodeGraphResponse(resp *http.Response, target any) error {
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return fmt.Errorf("read Meta Graph API response: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var graphResponse struct {
			Error struct {
				Message      string `json:"message"`
				Type         string `json:"type"`
				Code         int    `json:"code"`
				ErrorSubcode int    `json:"error_subcode"`
				TraceID      string `json:"fbtrace_id"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &graphResponse)
		message := strings.TrimSpace(graphResponse.Error.Message)
		if message == "" {
			message = http.StatusText(resp.StatusCode)
		}
		return &GraphError{
			HTTPStatus: resp.StatusCode,
			Message:    message,
			Type:       graphResponse.Error.Type,
			Code:       graphResponse.Error.Code,
			Subcode:    graphResponse.Error.ErrorSubcode,
			TraceID:    graphResponse.Error.TraceID,
		}
	}
	if target == nil || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("decode Meta Graph API response: %w", err)
	}
	return nil
}

func sanitizePagingURL(value, allowedBaseURL string) string {
	if strings.TrimSpace(value) == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	allowed, err := url.Parse(strings.TrimRight(strings.TrimSpace(allowedBaseURL), "/"))
	if err != nil || parsed.Scheme != allowed.Scheme || parsed.Host != allowed.Host {
		return ""
	}
	query := parsed.Query()
	query.Del("access_token")
	query.Del("appsecret_proof")
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func (c *Client) nextPageURL(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", nil
	}
	clean := sanitizePagingURL(value, c.baseURL)
	if clean == "" {
		return "", errors.New("Meta returned an invalid cross-origin paging URL")
	}
	return clean, nil
}

func redactGraphError(err error, secrets ...string) error {
	if err == nil {
		return nil
	}
	graphError, ok := err.(*GraphError)
	if !ok {
		return err
	}
	redacted := *graphError
	for _, secret := range secrets {
		secret = strings.TrimSpace(secret)
		if secret != "" {
			redacted.Message = strings.ReplaceAll(redacted.Message, secret, "[redacted]")
		}
	}
	return &redacted
}
