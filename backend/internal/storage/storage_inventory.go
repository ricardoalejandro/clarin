package storage

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
)

// InventoryObject is an observation of bytes, independent of a module's
// attachment lifecycle. BucketKind is deliberately explicit: legacy misplaced
// objects still consume quota but must not become authorized download targets.
type InventoryObject struct {
	Key          string
	Size         int64
	ETag         string
	LastModified time.Time
	ObservedAt   time.Time
}

func (s *Storage) inventoryBucket(kind string) (string, error) {
	switch kind {
	case "ordinary":
		return s.bucket, nil
	case "private":
		return s.privateBucket, nil
	default:
		return "", fmt.Errorf("invalid inventory bucket")
	}
}

// ListInventoryPage bounds both memory and work. The lexical checkpoint can be
// persisted and resumed after a restart. A complete traversal is not an S3
// snapshot; callers must stat missing candidates before recording absence.
func (s *Storage) ListInventoryPage(ctx context.Context, accountID uuid.UUID, kind, after string, limit int) ([]InventoryObject, bool, error) {
	if accountID == uuid.Nil || limit < 1 || limit > 1000 {
		return nil, false, fmt.Errorf("invalid inventory page")
	}
	prefix := accountID.String() + "/"
	if after != "" && !strings.HasPrefix(after, prefix) {
		return nil, false, fmt.Errorf("inventory cursor outside account")
	}
	bucket, err := s.inventoryBucket(kind)
	if err != nil {
		return nil, false, err
	}
	pageCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	observedAt := time.Now().UTC()
	items := make([]InventoryObject, 0, limit)
	for object := range s.client.ListObjects(pageCtx, bucket, minio.ListObjectsOptions{Prefix: prefix, StartAfter: after, Recursive: true, MaxKeys: limit}) {
		if object.Err != nil {
			return nil, false, object.Err
		}
		items = append(items, InventoryObject{Key: object.Key, Size: object.Size, ETag: object.ETag, LastModified: object.LastModified, ObservedAt: observedAt})
		if len(items) == limit {
			return items, true, nil
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	return items, false, nil
}

func (s *Storage) StatInventoryObject(ctx context.Context, accountID uuid.UUID, kind, key string) (minio.ObjectInfo, error) {
	if accountID == uuid.Nil || !strings.HasPrefix(key, accountID.String()+"/") {
		return minio.ObjectInfo{}, fmt.Errorf("inventory key outside account")
	}
	bucket, err := s.inventoryBucket(kind)
	if err != nil {
		return minio.ObjectInfo{}, err
	}
	return s.client.StatObject(ctx, bucket, key, minio.StatObjectOptions{})
}
