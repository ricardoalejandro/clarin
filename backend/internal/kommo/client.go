package kommo

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// Client is a rate-limited HTTP client for Kommo API v4.
type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
	mu         sync.Mutex
	lastReq    time.Time
}

// NewClient creates a new Kommo API client.
func NewClient(subdomain, accessToken string) *Client {
	return &Client{
		baseURL: fmt.Sprintf("https://%s.kommo.com/api/v4", subdomain),
		token:   accessToken,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// rateLimit ensures at most 5 requests per second.
func (c *Client) rateLimit() {
	c.mu.Lock()
	defer c.mu.Unlock()
	elapsed := time.Since(c.lastReq)
	if elapsed < 200*time.Millisecond {
		time.Sleep(200*time.Millisecond - elapsed)
	}
	c.lastReq = time.Now()
}

func (c *Client) get(path string) ([]byte, error) {
	c.rateLimit()

	req, err := http.NewRequest("GET", c.baseURL+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("kommo request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("kommo read body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("kommo API %s returned %d: %s", path, resp.StatusCode, string(body))
	}

	return body, nil
}

// --- Kommo API types ---

type KommoAccount struct {
	ID       int    `json:"id"`
	Name     string `json:"name"`
	Subdomain string `json:"subdomain"`
	Currency string `json:"currency"`
	Country  string `json:"country"`
}

type KommoPipeline struct {
	ID        int    `json:"id"`
	Name      string `json:"name"`
	Sort      int    `json:"sort"`
	IsMain    bool   `json:"is_main"`
	Statuses  []KommoPipelineStatus `json:"_embedded,omitempty"`
}

type KommoPipelineStatus struct {
	ID         int    `json:"id"`
	Name       string `json:"name"`
	Sort       int    `json:"sort"`
	Color      string `json:"color"`
	PipelineID int    `json:"pipeline_id"`
}

type KommoLead struct {
	ID            int                `json:"id"`
	Name          string             `json:"name"`
	Price         int                `json:"price"`
	StatusID      int                `json:"status_id"`
	PipelineID    int                `json:"pipeline_id"`
	ResponsibleID int               `json:"responsible_user_id"`
	CreatedAt     int64              `json:"created_at"`
	UpdatedAt     int64              `json:"updated_at"`
	Tags          []KommoTag         `json:"tags,omitempty"`
	CustomFields  []KommoCustomField `json:"custom_fields_values,omitempty"`
	Embedded      *KommoLeadEmbedded `json:"_embedded,omitempty"`
}

type KommoLeadEmbedded struct {
	Tags     []KommoTag     `json:"tags,omitempty"`
	Contacts []KommoContact `json:"contacts,omitempty"`
}

type KommoContact struct {
	ID            int                `json:"id"`
	Name          string             `json:"name"`
	FirstName     string             `json:"first_name"`
	LastName      string             `json:"last_name"`
	ResponsibleID int               `json:"responsible_user_id"`
	CreatedAt     int64              `json:"created_at"`
	UpdatedAt     int64              `json:"updated_at"`
	CustomFields  []KommoCustomField `json:"custom_fields_values,omitempty"`
	Embedded      *KommoContactEmbedded `json:"_embedded,omitempty"`
}

type KommoContactEmbedded struct {
	Tags []KommoTag `json:"tags,omitempty"`
}

type KommoTag struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

type KommoCustomField struct {
	FieldID   int    `json:"field_id"`
	FieldName string `json:"field_name"`
	FieldCode string `json:"field_code"`
	FieldType string `json:"field_type"`
	Values    []struct {
		Value    interface{} `json:"value"`
		EnumID   int         `json:"enum_id,omitempty"`
		EnumCode string      `json:"enum_code,omitempty"`
	} `json:"values"`
}

// --- API methods ---

// GetAccount returns the Kommo account info.
func (c *Client) GetAccount() (*KommoAccount, error) {
	data, err := c.get("/account")
	if err != nil {
		return nil, err
	}
	var acc KommoAccount
	if err := json.Unmarshal(data, &acc); err != nil {
		return nil, fmt.Errorf("kommo parse account: %w", err)
	}
	return &acc, nil
}

// GetPipelines returns all pipelines with their statuses.
func (c *Client) GetPipelines() ([]KommoPipeline, error) {
	data, err := c.get("/leads/pipelines")
	if err != nil {
		return nil, err
	}

	var resp struct {
		Embedded struct {
			Pipelines []json.RawMessage `json:"pipelines"`
		} `json:"_embedded"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, fmt.Errorf("kommo parse pipelines wrapper: %w", err)
	}

	var pipelines []KommoPipeline
	for _, raw := range resp.Embedded.Pipelines {
		var p struct {
			ID     int    `json:"id"`
			Name   string `json:"name"`
			Sort   int    `json:"sort"`
			IsMain bool   `json:"is_main"`
			Embedded struct {
				Statuses []KommoPipelineStatus `json:"statuses"`
			} `json:"_embedded"`
		}
		if err := json.Unmarshal(raw, &p); err != nil {
			continue
		}
		pipeline := KommoPipeline{
			ID:     p.ID,
			Name:   p.Name,
			Sort:   p.Sort,
			IsMain: p.IsMain,
		}
		pipeline.Statuses = p.Embedded.Statuses
		pipelines = append(pipelines, pipeline)
	}

	return pipelines, nil
}

// GetLeads returns leads with pagination. page starts at 1.
func (c *Client) GetLeads(page int) ([]KommoLead, bool, error) {
	limit := 250
	path := fmt.Sprintf("/leads?page=%d&limit=%d&with=contacts", page, limit)
	data, err := c.get(path)
	if err != nil {
		return nil, false, err
	}

	var resp struct {
		Page  int `json:"_page"`
		Embedded struct {
			Leads []KommoLead `json:"leads"`
		} `json:"_embedded"`
		Links struct {
			Next *struct {
				Href string `json:"href"`
			} `json:"next"`
		} `json:"_links"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, false, fmt.Errorf("kommo parse leads: %w", err)
	}

	hasMore := resp.Links.Next != nil
	return resp.Embedded.Leads, hasMore, nil
}

// GetLeadsForPipeline returns leads filtered by pipeline ID and optionally updated since a timestamp.
func (c *Client) GetLeadsForPipeline(pipelineID int, updatedSince int64, page int) ([]KommoLead, bool, error) {
	limit := 250
	path := fmt.Sprintf("/leads?page=%d&limit=%d&with=contacts&filter[pipeline_id][]=%d", page, limit, pipelineID)
	if updatedSince > 0 {
		path += fmt.Sprintf("&filter[updated_at][from]=%d", updatedSince)
	}
	data, err := c.get(path)
	if err != nil {
		return nil, false, err
	}

	var resp struct {
		Page     int `json:"_page"`
		Embedded struct {
			Leads []KommoLead `json:"leads"`
		} `json:"_embedded"`
		Links struct {
			Next *struct {
				Href string `json:"href"`
			} `json:"next"`
		} `json:"_links"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, false, fmt.Errorf("kommo parse leads: %w", err)
	}

	hasMore := resp.Links.Next != nil
	return resp.Embedded.Leads, hasMore, nil
}

// GetContactByID returns a single contact by Kommo ID.
func (c *Client) GetContactByID(contactID int) (*KommoContact, error) {
	data, err := c.get(fmt.Sprintf("/contacts/%d", contactID))
	if err != nil {
		return nil, err
	}
	var contact KommoContact
	if err := json.Unmarshal(data, &contact); err != nil {
		return nil, fmt.Errorf("kommo parse contact: %w", err)
	}
	return &contact, nil
}

// GetContacts returns contacts with pagination. page starts at 1.
func (c *Client) GetContacts(page int) ([]KommoContact, bool, error) {
	limit := 250
	path := fmt.Sprintf("/contacts?page=%d&limit=%d", page, limit)
	data, err := c.get(path)
	if err != nil {
		return nil, false, err
	}

	var resp struct {
		Page  int `json:"_page"`
		Embedded struct {
			Contacts []KommoContact `json:"contacts"`
		} `json:"_embedded"`
		Links struct {
			Next *struct {
				Href string `json:"href"`
			} `json:"next"`
		} `json:"_links"`
	}
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, false, fmt.Errorf("kommo parse contacts: %w", err)
	}

	hasMore := resp.Links.Next != nil
	return resp.Embedded.Contacts, hasMore, nil
}

// GetTags returns all tags for leads (with pagination).
func (c *Client) GetTags() ([]KommoTag, error) {
	var allTags []KommoTag
	page := 1

	for {
		path := fmt.Sprintf("/leads/tags?page=%d&limit=250", page)
		data, err := c.get(path)
		if err != nil {
			if len(allTags) > 0 {
				break
			}
			return nil, err
		}

		var resp struct {
			Embedded struct {
				Tags []KommoTag `json:"tags"`
			} `json:"_embedded"`
			Links struct {
				Next *struct {
					Href string `json:"href"`
				} `json:"next"`
			} `json:"_links"`
		}
		if err := json.Unmarshal(data, &resp); err != nil {
			return allTags, fmt.Errorf("kommo parse tags: %w", err)
		}

		allTags = append(allTags, resp.Embedded.Tags...)

		if resp.Links.Next == nil || len(resp.Embedded.Tags) == 0 {
			break
		}
		page++
	}

	return allTags, nil
}

// GetContactCustomFieldValue extracts a value from custom fields by field code.
func GetContactCustomFieldValue(fields []KommoCustomField, code string) string {
	for _, f := range fields {
		if f.FieldCode == code && len(f.Values) > 0 {
			if s, ok := f.Values[0].Value.(string); ok {
				return s
			}
		}
	}
	return ""
}

// GetContactPhone extracts the first PHONE custom field value.
func GetContactPhone(fields []KommoCustomField) string {
	for _, f := range fields {
		if f.FieldCode == "PHONE" && len(f.Values) > 0 {
			if s, ok := f.Values[0].Value.(string); ok {
				return s
			}
		}
	}
	return ""
}

// GetContactEmail extracts the first EMAIL custom field value.
func GetContactEmail(fields []KommoCustomField) string {
	for _, f := range fields {
		if f.FieldCode == "EMAIL" && len(f.Values) > 0 {
			if s, ok := f.Values[0].Value.(string); ok {
				return s
			}
		}
	}
	return ""
}
