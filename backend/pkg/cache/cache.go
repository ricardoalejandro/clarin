package cache

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var registerExpiringMemberScript = redis.NewScript(`
local now = tonumber(ARGV[1])
local expires = tonumber(ARGV[2])
local limit = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local existing = redis.call('ZSCORE', KEYS[1], ARGV[3])
if not existing and redis.call('ZCARD', KEYS[1]) >= limit then
  return 0
end
redis.call('ZADD', KEYS[1], expires, ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[6]))
redis.call('SET', KEYS[2], ARGV[5], 'PX', ARGV[7])
return 1
`)

var refreshExpiringMemberScript = redis.NewScript(`
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if not redis.call('ZSCORE', KEYS[1], ARGV[3]) then
  return 0
end
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[4]))
return 1
`)

type Cache struct {
	client *redis.Client
}

type PubSubSubscription struct {
	pubsub *redis.PubSub
}

func New(redisURL string) (*Cache, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	client := redis.NewClient(opts)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Ping(ctx).Err(); err != nil {
		return nil, err
	}
	return &Cache{client: client}, nil
}

func (c *Cache) Get(ctx context.Context, key string) ([]byte, error) {
	data, err := c.client.Get(ctx, key).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	return data, err
}

// Take atomically consumes a one-use value.
func (c *Cache) Take(ctx context.Context, key string) ([]byte, error) {
	data, err := c.client.GetDel(ctx, key).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	return data, err
}

func (c *Cache) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	return c.client.Set(ctx, key, value, ttl).Err()
}

func (c *Cache) SetNX(ctx context.Context, key string, value []byte, ttl time.Duration) (bool, error) {
	return c.client.SetNX(ctx, key, value, ttl).Result()
}

func (c *Cache) IncrWithTTL(ctx context.Context, key string, ttl time.Duration) (int64, error) {
	pipe := c.client.TxPipeline()
	incr := pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, ttl)
	if _, err := pipe.Exec(ctx); err != nil {
		return 0, err
	}
	return incr.Val(), nil
}

func (c *Cache) Del(ctx context.Context, keys ...string) error {
	return c.client.Del(ctx, keys...).Err()
}

func (c *Cache) DelPattern(ctx context.Context, pattern string) error {
	iter := c.client.Scan(ctx, 0, pattern, 100).Iterator()
	var keys []string
	for iter.Next(ctx) {
		keys = append(keys, iter.Val())
	}
	if err := iter.Err(); err != nil {
		return err
	}
	if len(keys) > 0 {
		return c.client.Del(ctx, keys...).Err()
	}
	return nil
}

// RegisterExpiringMember atomically prunes stale members, enforces a global
// capacity and stores the member payload with its own TTL. It is used by
// multi-instance realtime rooms where an in-memory count is insufficient.
func (c *Cache) RegisterExpiringMember(ctx context.Context, indexKey, valueKey, member string, value []byte, limit int, ttl time.Duration) (bool, error) {
	if c == nil || c.client == nil || indexKey == "" || valueKey == "" || member == "" || limit <= 0 || ttl <= 0 {
		return false, redis.Nil
	}
	now := time.Now().UnixMilli()
	ttlMillis := ttl.Milliseconds()
	result, err := registerExpiringMemberScript.Run(ctx, c.client, []string{indexKey, valueKey},
		strconv.FormatInt(now, 10), strconv.FormatInt(now+ttlMillis, 10), member,
		strconv.Itoa(limit), value, strconv.FormatInt(ttlMillis*2, 10), strconv.FormatInt(ttlMillis, 10)).Int()
	return result == 1, err
}

// RefreshExpiringMember extends an existing lease without recreating a member
// that has already been released or expired.
func (c *Cache) RefreshExpiringMember(ctx context.Context, indexKey, valueKey, member string, ttl time.Duration) (bool, error) {
	if c == nil || c.client == nil || indexKey == "" || valueKey == "" || member == "" || ttl <= 0 {
		return false, redis.Nil
	}
	now := time.Now().UnixMilli()
	ttlMillis := ttl.Milliseconds()
	result, err := refreshExpiringMemberScript.Run(ctx, c.client, []string{indexKey, valueKey},
		strconv.FormatInt(now, 10), strconv.FormatInt(now+ttlMillis, 10), member,
		strconv.FormatInt(ttlMillis, 10), strconv.FormatInt(ttlMillis*2, 10)).Int()
	return result == 1, err
}

// RemoveExpiringMember releases both the capacity slot and its payload.
func (c *Cache) RemoveExpiringMember(ctx context.Context, indexKey, valueKey, member string) error {
	pipe := c.client.TxPipeline()
	pipe.ZRem(ctx, indexKey, member)
	pipe.Del(ctx, valueKey)
	_, err := pipe.Exec(ctx)
	return err
}

// ListExpiringMembers returns live payloads in stable member order. Missing
// payload keys are removed from the index so crashed instances self-heal.
func (c *Cache) ListExpiringMembers(ctx context.Context, indexKey, valueKeyPrefix string) ([][]byte, error) {
	now := time.Now().UnixMilli()
	if err := c.client.ZRemRangeByScore(ctx, indexKey, "-inf", strconv.FormatInt(now, 10)).Err(); err != nil {
		return nil, err
	}
	members, err := c.client.ZRangeByScore(ctx, indexKey, &redis.ZRangeBy{Min: strconv.FormatInt(now+1, 10), Max: "+inf"}).Result()
	if err != nil || len(members) == 0 {
		return nil, err
	}
	keys := make([]string, len(members))
	for index, member := range members {
		keys[index] = valueKeyPrefix + member
	}
	values, err := c.client.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	payloads := make([][]byte, 0, len(values))
	stale := make([]any, 0)
	for index, value := range values {
		text, ok := value.(string)
		if !ok {
			stale = append(stale, members[index])
			continue
		}
		payloads = append(payloads, []byte(text))
	}
	if len(stale) > 0 {
		_ = c.client.ZRem(ctx, indexKey, stale...).Err()
	}
	return payloads, nil
}

// Publish sends an ephemeral cross-instance event. Durable whiteboard scene
// changes must be committed to PostgreSQL before this method is called.
func (c *Cache) Publish(ctx context.Context, channel string, payload []byte) error {
	return c.client.Publish(ctx, channel, payload).Err()
}

func (c *Cache) Subscribe(ctx context.Context, channels ...string) (*PubSubSubscription, error) {
	pubsub := c.client.Subscribe(ctx, channels...)
	if _, err := pubsub.Receive(ctx); err != nil {
		_ = pubsub.Close()
		return nil, err
	}
	return &PubSubSubscription{pubsub: pubsub}, nil
}

func (s *PubSubSubscription) Channel() <-chan *redis.Message {
	if s == nil || s.pubsub == nil {
		return nil
	}
	return s.pubsub.Channel()
}

func (s *PubSubSubscription) Close() error {
	if s == nil || s.pubsub == nil {
		return nil
	}
	return s.pubsub.Close()
}

// Ping checks Redis connectivity
func (c *Cache) Ping(ctx context.Context) error {
	return c.client.Ping(ctx).Err()
}

func (c *Cache) Close() error {
	return c.client.Close()
}
