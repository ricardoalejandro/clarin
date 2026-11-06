package cache

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

// The session may remain in Redis briefly beyond its logical idle deadline
// so authentication can distinguish inactivity from revocation.
const sessionValidForWrite = `
local session = redis.call('GET', KEYS[1])
local marker = redis.call('GET', KEYS[2])
local clock = redis.call('TIME')
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
if session ~= ARGV[1] or (marker and marker ~= ARGV[2]) or now >= tonumber(ARGV[3]) then
  return 0
end
`

var updateAuthSessionScript = redis.NewScript(sessionValidForWrite + `
redis.call('SET', KEYS[1], ARGV[4], 'PXAT', ARGV[5])
return 1
`)

var rotateAuthCredentialScript = redis.NewScript(sessionValidForWrite + `
if redis.call('GET', KEYS[3]) ~= ARGV[4] then
  return 0
end
redis.call('SET', KEYS[4], ARGV[5], 'PXAT', ARGV[6])
redis.call('SET', KEYS[3], ARGV[7], 'PX', 30000)
if ARGV[8] ~= '' then
  redis.call('SET', KEYS[5], ARGV[8], 'PXAT', ARGV[9])
  redis.call('DEL', KEYS[1])
end
return 1
`)

func (c *Cache) UpdateAuthSession(ctx context.Context, sessionKey, markerKey string, expected []byte, marker string, deadline time.Time, value []byte, expiresAt time.Time) (bool, error) {
	result, err := updateAuthSessionScript.Run(ctx, c.client, []string{sessionKey, markerKey},
		expected, marker, deadline.UnixMilli(), value, expiresAt.UnixMilli()).Int()
	return result == 1, err
}

type AuthCredentialRotation struct {
	SessionKey, MarkerKey, OldCredentialKey, NewCredentialKey string
	ExpectedSession, ExpectedCredential, Credential           []byte
	Marker, ConsumedMarker                                    string
	Deadline, CredentialExpiresAt                             time.Time
	NewSessionKey                                             string
	NewSession                                                []byte
	NewSessionExpiresAt                                       time.Time
}

// RotateAuthCredential consumes one refresh credential once. During an account
// switch the replacement session becomes visible in the same Redis operation.
func (c *Cache) RotateAuthCredential(ctx context.Context, rotation AuthCredentialRotation) (bool, error) {
	result, err := rotateAuthCredentialScript.Run(ctx, c.client,
		[]string{rotation.SessionKey, rotation.MarkerKey, rotation.OldCredentialKey, rotation.NewCredentialKey, rotation.NewSessionKey},
		rotation.ExpectedSession, rotation.Marker, rotation.Deadline.UnixMilli(),
		rotation.ExpectedCredential, rotation.Credential, rotation.CredentialExpiresAt.UnixMilli(), rotation.ConsumedMarker,
		rotation.NewSession, rotation.NewSessionExpiresAt.UnixMilli()).Int()
	return result == 1, err
}
