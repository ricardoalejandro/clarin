package google

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	peopleAPIBase   = "https://people.googleapis.com/v1"
	oauthTokenURL   = "https://oauth2.googleapis.com/token"
	oauthAuthURL    = "https://accounts.google.com/o/oauth2/v2/auth"
	contactsScope   = "https://www.googleapis.com/auth/contacts"
	maxBatchCreate  = 200
	maxBatchUpdate  = 200
	SyncLimitDefault = 20000
)

// Client interacts with Google People API for contact sync
type Client struct {
	httpClient   *http.Client
	clientID     string
	clientSecret string
	redirectURI  string
}

// NewClient creates a Google People API client
func NewClient(clientID, clientSecret, redirectURI string) *Client {
	return &Client{
		httpClient:   &http.Client{Timeout: 30 * time.Second},
		clientID:     clientID,
		clientSecret: clientSecret,
		redirectURI:  redirectURI,
	}
}

// TokenResponse from Google OAuth
type TokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	ExpiresIn    int    `json:"expires_in"`
	TokenType    string `json:"token_type"`
	Scope        string `json:"scope"`
}

// PersonName for Google People API
type PersonName struct {
	GivenName  string `json:"givenName,omitempty"`
	FamilyName string `json:"familyName,omitempty"`
}

// PhoneNumber for Google People API
type PhoneNumber struct {
	Value string `json:"value"`
	Type  string `json:"type,omitempty"`
}

// EmailAddress for Google People API
type EmailAddress struct {
	Value string `json:"value"`
	Type  string `json:"type,omitempty"`
}

// Organization for Google People API
type Organization struct {
	Name string `json:"name,omitempty"`
}

// Biography for Google People API (notes)
type Biography struct {
	Value       string `json:"value"`
	ContentType string `json:"contentType,omitempty"`
}

// Membership for Google People API (contact groups)
type Membership struct {
	ContactGroupMembership *ContactGroupMembership `json:"contactGroupMembership,omitempty"`
}

// ContactGroupMembership for Google People API
type ContactGroupMembership struct {
	ContactGroupResourceName string `json:"contactGroupResourceName"`
}

// Person represents a Google Contact
type Person struct {
	ResourceName   string          `json:"resourceName,omitempty"`
	Etag           string          `json:"etag,omitempty"`
	Names          []PersonName    `json:"names,omitempty"`
	PhoneNumbers   []PhoneNumber   `json:"phoneNumbers,omitempty"`
	EmailAddresses []EmailAddress  `json:"emailAddresses,omitempty"`
	Organizations  []Organization  `json:"organizations,omitempty"`
	Biographies    []Biography     `json:"biographies,omitempty"`
	Memberships    []Membership    `json:"memberships,omitempty"`
}

// ContactGroup represents a Google Contact Group
type ContactGroup struct {
	ResourceName string `json:"resourceName,omitempty"`
	Name         string `json:"name,omitempty"`
	GroupType    string `json:"groupType,omitempty"`
	MemberCount  int    `json:"memberCount,omitempty"`
}

// GetAuthURL returns the Google OAuth authorization URL
func (c *Client) GetAuthURL(state string) string {
	params := url.Values{
		"client_id":     {c.clientID},
		"redirect_uri":  {c.redirectURI},
		"response_type": {"code"},
		"scope":         {contactsScope + " email"},
		"access_type":   {"offline"},
		"prompt":        {"consent"},
		"state":         {state},
	}
	return oauthAuthURL + "?" + params.Encode()
}

// ExchangeCode exchanges an authorization code for tokens
func (c *Client) ExchangeCode(ctx context.Context, code string) (*TokenResponse, error) {
	data := url.Values{
		"code":          {code},
		"client_id":     {c.clientID},
		"client_secret": {c.clientSecret},
		"redirect_uri":  {c.redirectURI},
		"grant_type":    {"authorization_code"},
	}
	req, err := http.NewRequestWithContext(ctx, "POST", oauthTokenURL, strings.NewReader(data.Encode()))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("exchange code: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("exchange code: status %d: %s", resp.StatusCode, string(body))
	}

	var token TokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		return nil, fmt.Errorf("decode token: %w", err)
	}
	return &token, nil
}

// RefreshAccessToken refreshes an expired access token
func (c *Client) RefreshAccessToken(ctx context.Context, refreshToken string) (*TokenResponse, error) {
	data := url.Values{
		"refresh_token": {refreshToken},
		"client_id":     {c.clientID},
		"client_secret": {c.clientSecret},
		"grant_type":    {"refresh_token"},
	}
	req, err := http.NewRequestWithContext(ctx, "POST", oauthTokenURL, strings.NewReader(data.Encode()))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("refresh token: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("refresh token: status %d: %s", resp.StatusCode, string(body))
	}

	var token TokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		return nil, fmt.Errorf("decode token: %w", err)
	}
	return &token, nil
}

// GetUserEmail retrieves the email from the Google user info
func (c *Client) GetUserEmail(ctx context.Context, accessToken string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", "https://www.googleapis.com/oauth2/v2/userinfo", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var info struct {
		Email string `json:"email"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return "", err
	}
	return info.Email, nil
}

// apiCall makes an authenticated API call to Google People API
func (c *Client) apiCall(ctx context.Context, method, url string, accessToken string, body interface{}) ([]byte, int, error) {
	var reqBody io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, 0, fmt.Errorf("marshal body: %w", err)
		}
		reqBody = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, url, reqBody)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, err
	}
	return respBody, resp.StatusCode, nil
}

// CreateContactGroup creates a contact group in Google Contacts
func (c *Client) CreateContactGroup(ctx context.Context, accessToken, groupName string) (*ContactGroup, error) {
	payload := map[string]interface{}{
		"contactGroup": map[string]string{
			"name": groupName,
		},
	}
	body, status, err := c.apiCall(ctx, "POST", peopleAPIBase+"/contactGroups", accessToken, payload)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("create group: status %d: %s", status, string(body))
	}

	var result ContactGroup
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// ListContactGroups lists all contact groups
func (c *Client) ListContactGroups(ctx context.Context, accessToken string) ([]ContactGroup, error) {
	body, status, err := c.apiCall(ctx, "GET", peopleAPIBase+"/contactGroups?pageSize=100", accessToken, nil)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("list groups: status %d: %s", status, string(body))
	}

	var result struct {
		ContactGroups []ContactGroup `json:"contactGroups"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	return result.ContactGroups, nil
}

// CreateContact creates a new contact in Google Contacts
func (c *Client) CreateContact(ctx context.Context, accessToken string, person *Person) (*Person, error) {
	url := peopleAPIBase + "/people:createContact?personFields=names,phoneNumbers,emailAddresses,organizations,biographies,memberships"
	body, status, err := c.apiCall(ctx, "POST", url, accessToken, person)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("create contact: status %d: %s", status, string(body))
	}

	var result Person
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	log.Printf("[GOOGLE] Created contact: %s", result.ResourceName)
	return &result, nil
}

// UpdateContact updates an existing contact in Google Contacts
func (c *Client) UpdateContact(ctx context.Context, accessToken string, resourceName string, person *Person, etag string) (*Person, error) {
	// First get current etag if not provided
	if etag == "" {
		current, err := c.GetContact(ctx, accessToken, resourceName)
		if err != nil {
			return nil, fmt.Errorf("get etag: %w", err)
		}
		etag = current.Etag
		// Debug: log what Google currently has BEFORE our update
		if len(current.Names) > 0 {
			log.Printf("[GOOGLE] BEFORE update %s: givenName=%q familyName=%q", resourceName, current.Names[0].GivenName, current.Names[0].FamilyName)
		} else {
			log.Printf("[GOOGLE] BEFORE update %s: no names", resourceName)
		}
	}

	person.Etag = etag

	// Debug: log what we're sending
	if len(person.Names) > 0 {
		log.Printf("[GOOGLE] SENDING update %s: givenName=%q familyName=%q", resourceName, person.Names[0].GivenName, person.Names[0].FamilyName)
	}

	url := fmt.Sprintf("%s/%s:updateContact?updatePersonFields=names,phoneNumbers,emailAddresses,organizations,biographies&personFields=names,phoneNumbers,emailAddresses,organizations,biographies,memberships", peopleAPIBase, resourceName)
	body, status, err := c.apiCall(ctx, "PATCH", url, accessToken, person)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("update contact: status %d: %s", status, string(body))
	}

	var result Person
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}

	// Debug: log what Google returned AFTER our update
	if len(result.Names) > 0 {
		log.Printf("[GOOGLE] AFTER update %s: givenName=%q familyName=%q", result.ResourceName, result.Names[0].GivenName, result.Names[0].FamilyName)
	} else {
		log.Printf("[GOOGLE] AFTER update %s: no names in response!", result.ResourceName)
	}

	log.Printf("[GOOGLE] Updated contact: %s", result.ResourceName)
	return &result, nil
}

// GetContact retrieves a contact by resource name
func (c *Client) GetContact(ctx context.Context, accessToken, resourceName string) (*Person, error) {
	url := fmt.Sprintf("%s/%s?personFields=names,phoneNumbers,emailAddresses,organizations,biographies,memberships", peopleAPIBase, resourceName)
	body, status, err := c.apiCall(ctx, "GET", url, accessToken, nil)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("get contact: status %d: %s", status, string(body))
	}

	var result Person
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

// SearchContacts searches for contacts by phone number in the account
func (c *Client) SearchContacts(ctx context.Context, accessToken, query string) ([]Person, error) {
	reqURL := fmt.Sprintf("%s/people:searchContacts?query=%s&readMask=names,phoneNumbers,memberships&pageSize=10", peopleAPIBase, url.QueryEscape(query))
	body, status, err := c.apiCall(ctx, "GET", reqURL, accessToken, nil)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("search contacts: status %d: %s", status, string(body))
	}

	var result struct {
		Results []struct {
			Person Person `json:"person"`
		} `json:"results"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}

	persons := make([]Person, 0, len(result.Results))
	for _, r := range result.Results {
		persons = append(persons, r.Person)
	}
	return persons, nil
}

// DeleteContact deletes a contact from Google
func (c *Client) DeleteContact(ctx context.Context, accessToken, resourceName string) error {
	url := fmt.Sprintf("%s/%s:deleteContact", peopleAPIBase, resourceName)
	_, status, err := c.apiCall(ctx, "DELETE", url, accessToken, nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK && status != http.StatusNoContent {
		return fmt.Errorf("delete contact: status %d", status)
	}
	log.Printf("[GOOGLE] Deleted contact: %s", resourceName)
	return nil
}

// ModifyContactGroupMembers adds a contact to a group
func (c *Client) ModifyContactGroupMembers(ctx context.Context, accessToken, groupResourceName string, addResourceNames []string) error {
	payload := map[string]interface{}{
		"resourceNamesToAdd": addResourceNames,
	}
	url := fmt.Sprintf("%s/%s/members:modify", peopleAPIBase, groupResourceName)
	body, status, err := c.apiCall(ctx, "POST", url, accessToken, payload)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return fmt.Errorf("modify group members: status %d: %s", status, string(body))
	}
	return nil
}
