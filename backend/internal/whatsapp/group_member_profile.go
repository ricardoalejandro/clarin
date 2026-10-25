package whatsapp

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/contactavatar"
	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
	"golang.org/x/sync/singleflight"
)

type groupMemberPhotoEntry struct {
	data    []byte
	err     error
	expires time.Time
}
type groupMemberPhotoMemory struct {
	sync.Mutex
	entries map[string]groupMemberPhotoEntry
	bytes   int
	flight  singleflight.Group
}

var groupMemberPhotos = groupMemberPhotoMemory{entries: map[string]groupMemberPhotoEntry{}}
var groupMemberPhotoSlots = make(chan struct{}, 4)

const groupMemberPhotoMaxBytes = 16 << 20
const groupMemberPhotoMaxEntries = 128

func groupMemberPhotoTTL(err error) time.Duration {
	if err == nil {
		return 10 * time.Minute
	}
	switch ProfilePictureErrorCode(err) {
	case ProfilePictureCodePrivate, ProfilePictureCodeNotSet:
		return time.Minute
	default:
		// A user retry must be able to recover immediately after a transient
		// provider/download failure or a cancelled request.
		return 0
	}
}

func groupMemberPhotoKey(accountID, deviceID uuid.UUID, group string, member domain.GroupParticipant, preview bool) string {
	return fmt.Sprintf("%s|%s|%s|%s|%s|%t", accountID, deviceID, group, member.JID, member.LID, preview)
}
func (c *groupMemberPhotoMemory) get(key string, now time.Time) (groupMemberPhotoEntry, bool) {
	c.Lock()
	defer c.Unlock()
	e, ok := c.entries[key]
	if ok && !now.Before(e.expires) {
		delete(c.entries, key)
		c.bytes -= len(e.data)
		ok = false
	}
	return e, ok
}
func (c *groupMemberPhotoMemory) put(key string, e groupMemberPhotoEntry) {
	c.Lock()
	defer c.Unlock()
	if old, ok := c.entries[key]; ok {
		c.bytes -= len(old.data)
		delete(c.entries, key)
	}
	for len(c.entries) >= groupMemberPhotoMaxEntries || c.bytes+len(e.data) > groupMemberPhotoMaxBytes {
		oldestKey := ""
		var oldest time.Time
		for k, v := range c.entries {
			if oldestKey == "" || v.expires.Before(oldest) {
				oldestKey, oldest = k, v.expires
			}
		}
		if oldestKey == "" {
			return
		}
		c.bytes -= len(c.entries[oldestKey].data)
		delete(c.entries, oldestKey)
	}
	c.entries[key] = e
	c.bytes += len(e.data)
}

// This read verifies current remote membership without creating CRM records.
func (p *DevicePool) FreshGroupParticipant(ctx context.Context, accountID, deviceID uuid.UUID, groupJID string, expected domain.GroupParticipant) (domain.GroupParticipant, error) {
	instance, err := p.reportDevice(accountID, deviceID)
	if err != nil {
		return domain.GroupParticipant{}, err
	}
	group, err := types.ParseJID(groupJID)
	if err != nil || group.Server != types.GroupServer {
		return domain.GroupParticipant{}, ErrGroupReportInvalidGroup
	}
	requestCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	info, err := instance.Client.GetGroupInfo(requestCtx, group)
	if err != nil {
		return domain.GroupParticipant{}, fmt.Errorf("%w: %v", ErrGroupReportUpstream, err)
	}
	if info == nil {
		return domain.GroupParticipant{}, ErrGroupReportGroupNotFound
	}
	var ownPN types.JID
	if instance.Client.Store.ID != nil {
		ownPN = instance.Client.Store.ID.ToNonAD()
	}
	_, members := groupProjection(info, ownPN, instance.Client.Store.LID, false)
	selfPresent := false
	for _, m := range members {
		selfPresent = selfPresent || m.IsSelf
	}
	if !selfPresent {
		return domain.GroupParticipant{}, ErrGroupReportGroupNotFound
	}
	for _, m := range members {
		if memberIdentityAliasesIntersect(m, expected) {
			m = p.ResolveCachedGroupParticipant(ctx, accountID, deviceID, m)
			m.JID = expected.JID
			return m, nil
		}
	}
	return domain.GroupParticipant{}, ErrGroupReportGroupNotFound
}

func memberIdentityAliasesIntersect(a, b domain.GroupParticipant) bool {
	for _, x := range []string{a.JID, a.LID} {
		if x != "" && (x == b.JID || x == b.LID) {
			return true
		}
	}
	return false
}

func (p *DevicePool) GroupParticipantAbout(ctx context.Context, accountID, deviceID uuid.UUID, member domain.GroupParticipant) (string, string, error) {
	instance, err := p.reportDevice(accountID, deviceID)
	if err != nil {
		return "", "unavailable", err
	}
	if member.Phone == "" {
		return "", "unavailable", nil
	}
	requestCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	jid := types.NewJID(member.Phone, types.DefaultUserServer)
	info, err := instance.Client.GetUserInfo(requestCtx, []types.JID{jid})
	if err != nil {
		return "", "unavailable", err
	}
	item, ok := info[jid]
	if !ok {
		return "", "unavailable", nil
	}
	text := strings.TrimSpace(item.Status)
	if text == "" {
		return "", "empty", nil
	}
	runes := []rune(text)
	if len(runes) > 2048 {
		text = string(runes[:2048])
	}
	return text, "available", nil
}

func (p *DevicePool) GroupParticipantPhoto(ctx context.Context, accountID, deviceID uuid.UUID, group string, member domain.GroupParticipant, preview bool) ([]byte, error) {
	// Check provider and device ownership before consulting this shared cache.
	if _, err := p.reportDevice(accountID, deviceID); err != nil {
		return nil, err
	}
	key := groupMemberPhotoKey(accountID, deviceID, group, member, preview)
	if entry, ok := groupMemberPhotos.get(key, time.Now()); ok {
		return entry.data, entry.err
	}
	result := groupMemberPhotos.flight.DoChan(key, func() (interface{}, error) {
		if entry, ok := groupMemberPhotos.get(key, time.Now()); ok {
			return entry.data, entry.err
		}
		select {
		case groupMemberPhotoSlots <- struct{}{}:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		defer func() { <-groupMemberPhotoSlots }()
		data, err := p.fetchGroupParticipantPhoto(ctx, accountID, deviceID, group, member, preview)
		ttl := groupMemberPhotoTTL(err)
		if ctx.Err() == nil && ttl > 0 {
			groupMemberPhotos.put(key, groupMemberPhotoEntry{data: data, err: err, expires: time.Now().Add(ttl)})
		}
		return data, err
	})
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case value := <-result:
		if value.Err != nil {
			return nil, value.Err
		}
		return value.Val.([]byte), nil
	}
}

func (p *DevicePool) fetchGroupParticipantPhoto(ctx context.Context, accountID, deviceID uuid.UUID, group string, member domain.GroupParticipant, preview bool) ([]byte, error) {
	operationCtx, release, err := p.retainDeviceOperation(ctx, accountID, deviceID)
	if err != nil {
		return nil, err
	}
	defer release()
	instance, err := p.reportDevice(accountID, deviceID)
	if err != nil {
		return nil, err
	}
	jid, err := types.ParseJID(member.JID)
	if err != nil || (jid.Server != types.DefaultUserServer && jid.Server != types.HiddenUserServer) {
		return nil, ErrGroupReportInvalidGroup
	}
	groupJID, err := types.ParseJID(group)
	if err != nil || groupJID.Server != types.GroupServer {
		return nil, ErrGroupReportInvalidGroup
	}
	requestCtx, cancel := context.WithTimeout(operationCtx, 12*time.Second)
	defer cancel()
	picture, err := instance.Client.GetProfilePictureInfo(requestCtx, jid, &whatsmeow.GetProfilePictureParams{Preview: preview, CommonGID: groupJID})
	if err = classifyProfilePictureLookup(picture, err); err != nil {
		return nil, err
	}
	parsed, err := url.Parse(picture.URL)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" {
		return nil, profilePictureError(ProfilePictureCodeUnavailable, "WhatsApp devolvió una foto no disponible")
	}
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 3 || req.URL.Scheme != "https" {
			return http.ErrUseLastResponse
		}
		return nil
	}}
	response, err := client.Do(request)
	if err != nil {
		return nil, profilePictureError(ProfilePictureCodeUnavailable, "No se pudo descargar la foto de WhatsApp")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 || response.ContentLength > contactavatar.MaxInputBytes {
		return nil, profilePictureError(ProfilePictureCodeUnavailable, "La foto de WhatsApp no está disponible")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, contactavatar.MaxInputBytes+1))
	if err != nil {
		return nil, err
	}
	data, err = contactavatar.Normalize(data)
	if err != nil {
		return nil, profilePictureError(ProfilePictureCodeUnavailable, "La foto de WhatsApp no es válida")
	}
	return data, nil
}
