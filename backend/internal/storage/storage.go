package storage

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/url"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// Storage handles file storage operations
type Storage struct {
	client        *minio.Client
	bucket        string
	privateBucket string
	publicURL     string
	internalURL   string // internal endpoint (for URL replacement)
}

const privateObjectFolder = "_private"
const legacyStatusObjectFolder = "statuses"

type ObjectSummary struct {
	Key          string
	Size         int64
	LastModified time.Time
}

// Config holds MinIO configuration
type Config struct {
	Endpoint  string
	AccessKey string
	SecretKey string
	Bucket    string
	UseSSL    bool
	PublicURL string
}

// New creates a new Storage instance
func New(cfg Config) (*Storage, error) {
	client, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: cfg.UseSSL,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create minio client: %w", err)
	}

	// Build the internal URL for later replacement
	scheme := "http"
	if cfg.UseSSL {
		scheme = "https"
	}
	internalURL := fmt.Sprintf("%s://%s", scheme, cfg.Endpoint)

	s := &Storage{
		client:        client,
		bucket:        cfg.Bucket,
		privateBucket: cfg.Bucket + "-private",
		publicURL:     cfg.PublicURL,
		internalURL:   internalURL,
	}

	// Ensure bucket exists
	if err := s.ensureBucket(context.Background()); err != nil {
		return nil, err
	}
	if err := s.ensurePrivateBucket(context.Background()); err != nil {
		return nil, err
	}

	return s, nil
}

// PrivateObjectKey builds an account-scoped key that is always stored in the
// private bucket. It remains account-prefixed so quota, inventory, and purge
// operations can keep using the same tenant boundary.
func PrivateObjectKey(accountID uuid.UUID, parts ...string) string {
	elements := []string{accountID.String(), privateObjectFolder}
	elements = append(elements, parts...)
	return path.Join(elements...)
}

// IsPrivateObjectKey identifies keys that must never be served by the public
// proxy or returned as direct MinIO URLs.
func IsPrivateObjectKey(objectKey string) bool {
	cleaned := strings.TrimPrefix(path.Clean("/"+strings.TrimSpace(objectKey)), "/")
	parts := strings.Split(cleaned, "/")
	return len(parts) >= 3 && parts[1] == privateObjectFolder
}

// IsLegacyStatusObjectKey recognizes the public-bucket namespace used by an
// intermediate status implementation. New status media must never be written
// there, but it remains protected while existing objects are migrated.
func IsLegacyStatusObjectKey(objectKey string) bool {
	cleaned := strings.TrimPrefix(path.Clean("/"+strings.TrimSpace(objectKey)), "/")
	parts := strings.Split(cleaned, "/")
	if len(parts) < 3 || parts[1] != legacyStatusObjectFolder {
		return false
	}
	_, err := uuid.Parse(parts[0])
	return err == nil
}

func IsProtectedStatusObjectKey(objectKey string) bool {
	return IsPrivateObjectKey(objectKey) || IsLegacyStatusObjectKey(objectKey)
}

// IsAccountStatusObjectKey is the stricter predicate required before a
// destructive operation. It rejects normalized traversal, another account's
// key, and private namespaces that are not the status-media namespace.
func IsAccountPrivateStatusObjectKey(accountID uuid.UUID, objectKey string) bool {
	raw := strings.TrimSpace(objectKey)
	if raw == "" || strings.HasPrefix(raw, "/") || path.Clean(raw) != raw {
		return false
	}
	privatePrefix := accountID.String() + "/" + privateObjectFolder + "/" + legacyStatusObjectFolder + "/"
	return strings.HasPrefix(raw, privatePrefix)
}

// IsAccountPrivateAvatarObjectKey recognizes only the Contact-avatar private
// namespace. It is used to keep generic storage deletion from bypassing the
// Contact replacement transaction and its reference-aware GC.
func IsAccountPrivateAvatarObjectKey(accountID uuid.UUID, objectKey string) bool {
	raw := strings.TrimSpace(objectKey)
	if raw == "" || strings.HasPrefix(raw, "/") || path.Clean(raw) != raw {
		return false
	}
	avatarPrefix := accountID.String() + "/" + privateObjectFolder + "/avatars/"
	return strings.HasPrefix(raw, avatarPrefix)
}

func IsAccountLegacyStatusObjectKey(accountID uuid.UUID, objectKey string) bool {
	raw := strings.TrimSpace(objectKey)
	if raw == "" || strings.HasPrefix(raw, "/") || path.Clean(raw) != raw {
		return false
	}
	legacyPrefix := accountID.String() + "/" + legacyStatusObjectFolder + "/"
	return strings.HasPrefix(raw, legacyPrefix)
}

func IsAccountStatusObjectKey(accountID uuid.UUID, objectKey string) bool {
	return IsAccountPrivateStatusObjectKey(accountID, objectKey) || IsAccountLegacyStatusObjectKey(accountID, objectKey)
}

func (s *Storage) bucketForObjectKey(objectKey string) string {
	if IsPrivateObjectKey(objectKey) {
		return s.privateBucket
	}
	return s.bucket
}

func accountScopedObjectKey(accountID uuid.UUID, folder, filename string) (string, error) {
	objectKey := path.Join(accountID.String(), folder, filename)
	if !strings.HasPrefix(objectKey, accountID.String()+"/") || IsProtectedStatusObjectKey(objectKey) {
		return "", fmt.Errorf("object key is outside the account scope")
	}
	return objectKey, nil
}

// ensureBucket creates the bucket if it doesn't exist
func (s *Storage) ensureBucket(ctx context.Context) error {
	exists, err := s.client.BucketExists(ctx, s.bucket)
	if err != nil {
		return fmt.Errorf("failed to check bucket: %w", err)
	}

	if !exists {
		if err := s.client.MakeBucket(ctx, s.bucket, minio.MakeBucketOptions{}); err != nil {
			return fmt.Errorf("failed to create bucket: %w", err)
		}
	}

	// Keep ordinary media public for backwards compatibility, but explicitly
	// omit both the historical status namespace and any accidentally uploaded
	// private key. Authenticated service credentials can still read these keys
	// so the reconciliation worker can move them into the private bucket.
	policy := fmt.Sprintf(`{
		"Version": "2012-10-17",
		"Statement": [
			{
				"Effect": "Allow",
				"Principal": {"AWS": ["*"]},
				"Action": ["s3:GetObject"],
				"NotResource": [
					"arn:aws:s3:::%s/*/%s/*",
					"arn:aws:s3:::%s/*/%s/*"
				]
			}
		]
	}`, s.bucket, legacyStatusObjectFolder, s.bucket, privateObjectFolder)
	if err := s.client.SetBucketPolicy(ctx, s.bucket, policy); err != nil {
		return fmt.Errorf("failed to enforce public bucket policy: %w", err)
	}

	return nil
}

func (s *Storage) ensurePrivateBucket(ctx context.Context) error {
	exists, err := s.client.BucketExists(ctx, s.privateBucket)
	if err != nil {
		return fmt.Errorf("failed to check private bucket: %w", err)
	}
	if !exists {
		if err := s.client.MakeBucket(ctx, s.privateBucket, minio.MakeBucketOptions{}); err != nil {
			return fmt.Errorf("failed to create private bucket: %w", err)
		}
	}
	// SetBucketPolicy with an empty policy removes anonymous access. Do this on
	// every startup so an accidental policy change cannot expose status media.
	policy, err := s.client.GetBucketPolicy(ctx, s.privateBucket)
	if err != nil {
		return fmt.Errorf("failed to inspect private bucket policy: %w", err)
	}
	if strings.TrimSpace(policy) != "" {
		if err := s.client.SetBucketPolicy(ctx, s.privateBucket, ""); err != nil {
			return fmt.Errorf("failed to enforce private bucket policy: %w", err)
		}
	}
	return nil
}

// UploadFile uploads a file to storage and returns the public URL
func (s *Storage) UploadFile(ctx context.Context, accountID uuid.UUID, folder, filename string, data []byte, contentType string) (string, error) {
	// Generate object key: accountID/folder/filename
	objectKey, err := accountScopedObjectKey(accountID, folder, filename)
	if err != nil {
		return "", err
	}

	bucket := s.bucketForObjectKey(objectKey)
	_, err = s.client.PutObject(ctx, bucket, objectKey, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{
		ContentType: contentType,
	})
	if err != nil {
		return "", fmt.Errorf("failed to upload file: %w", err)
	}

	// Return the public URL
	return s.GetPublicURL(objectKey), nil
}

// UploadObject stores a file using an already-built object key.
func (s *Storage) UploadObject(ctx context.Context, objectKey string, data []byte, contentType string) (string, error) {
	bucket := s.bucketForObjectKey(objectKey)
	_, err := s.client.PutObject(ctx, bucket, objectKey, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{
		ContentType: contentType,
	})
	if err != nil {
		return "", fmt.Errorf("failed to upload object: %w", err)
	}
	return s.GetPublicURL(objectKey), nil
}

// UploadReader uploads from a reader
func (s *Storage) UploadReader(ctx context.Context, accountID uuid.UUID, folder, filename string, reader io.Reader, size int64, contentType string) (string, error) {
	objectKey, err := accountScopedObjectKey(accountID, folder, filename)
	if err != nil {
		return "", err
	}

	bucket := s.bucketForObjectKey(objectKey)
	_, err = s.client.PutObject(ctx, bucket, objectKey, reader, size, minio.PutObjectOptions{
		ContentType: contentType,
	})
	if err != nil {
		return "", fmt.Errorf("failed to upload file: %w", err)
	}

	return s.GetPublicURL(objectKey), nil
}

// GetPresignedUploadURL generates a presigned URL for direct upload
func (s *Storage) GetPresignedUploadURL(ctx context.Context, accountID uuid.UUID, folder, filename string) (string, error) {
	objectKey, err := accountScopedObjectKey(accountID, folder, filename)
	if err != nil {
		return "", err
	}

	presignedURL, err := s.client.PresignedPutObject(ctx, s.bucketForObjectKey(objectKey), objectKey, 15*time.Minute)
	if err != nil {
		return "", fmt.Errorf("failed to generate presigned URL: %w", err)
	}

	// Replace internal URL with public URL for browser access
	urlStr := presignedURL.String()
	if s.publicURL != "" && s.internalURL != "" {
		urlStr = strings.Replace(urlStr, s.internalURL, s.publicURL, 1)
	}

	return urlStr, nil
}

// GetFile retrieves a file from storage
func (s *Storage) GetFile(ctx context.Context, objectKey string) ([]byte, error) {
	object, err := s.client.GetObject(ctx, s.bucketForObjectKey(objectKey), objectKey, minio.GetObjectOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to get file: %w", err)
	}
	defer object.Close()

	data, err := io.ReadAll(object)
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}

	return data, nil
}

// GetFileInfo retrieves file metadata (size, content-type) from storage
func (s *Storage) GetFileInfo(ctx context.Context, objectKey string) (minio.ObjectInfo, error) {
	return s.client.StatObject(ctx, s.bucketForObjectKey(objectKey), objectKey, minio.StatObjectOptions{})
}

// GetFileRange retrieves a byte range of a file from storage
func (s *Storage) GetFileRange(ctx context.Context, objectKey string, offset, length int64) ([]byte, error) {
	opts := minio.GetObjectOptions{}
	if length > 0 {
		opts.SetRange(offset, offset+length-1)
	} else {
		opts.SetRange(offset, 0)
	}
	object, err := s.client.GetObject(ctx, s.bucketForObjectKey(objectKey), objectKey, opts)
	if err != nil {
		return nil, fmt.Errorf("failed to get file range: %w", err)
	}
	defer object.Close()

	data, err := io.ReadAll(object)
	if err != nil {
		return nil, fmt.Errorf("failed to read file range: %w", err)
	}

	return data, nil
}

// DeleteFile removes a file from storage
func (s *Storage) DeleteFile(ctx context.Context, objectKey string) error {
	if err := s.client.RemoveObject(ctx, s.bucketForObjectKey(objectKey), objectKey, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("failed to delete file: %w", err)
	}
	return nil
}

func (s *Storage) CountPrefix(ctx context.Context, prefix string) (int64, error) {
	var count int64
	for _, bucket := range []string{s.bucket, s.privateBucket} {
		for object := range s.client.ListObjects(ctx, bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
			if object.Err != nil {
				return count, object.Err
			}
			count++
		}
	}
	return count, nil
}

func (s *Storage) ListPrefix(ctx context.Context, prefix string) ([]ObjectSummary, error) {
	objects := make([]ObjectSummary, 0)
	for _, bucket := range []string{s.bucket, s.privateBucket} {
		for object := range s.client.ListObjects(ctx, bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
			if object.Err != nil {
				return objects, object.Err
			}
			if strings.HasSuffix(object.Key, "/") {
				continue
			}
			objects = append(objects, ObjectSummary{
				Key:          object.Key,
				Size:         object.Size,
				LastModified: object.LastModified,
			})
		}
	}
	return objects, nil
}

func (s *Storage) UsagePrefix(ctx context.Context, prefix string) (int64, int64, error) {
	var size int64
	var count int64
	for _, bucket := range []string{s.bucket, s.privateBucket} {
		for object := range s.client.ListObjects(ctx, bucket, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
			if object.Err != nil {
				return size, count, object.Err
			}
			if strings.HasSuffix(object.Key, "/") {
				continue
			}
			size += object.Size
			count++
		}
	}
	return size, count, nil
}

func (s *Storage) DeletePrefix(ctx context.Context, prefix string) (int64, error) {
	var deleted int64
	for _, bucket := range []string{s.bucket, s.privateBucket} {
		objectsCh := make(chan minio.ObjectInfo)
		go func(bucketName string) {
			defer close(objectsCh)
			for object := range s.client.ListObjects(ctx, bucketName, minio.ListObjectsOptions{Prefix: prefix, Recursive: true}) {
				if object.Err != nil {
					objectsCh <- minio.ObjectInfo{Key: object.Key, Err: object.Err}
					return
				}
				objectsCh <- object
			}
		}(bucket)

		for result := range s.client.RemoveObjectsWithResult(ctx, bucket, objectsCh, minio.RemoveObjectsOptions{}) {
			if result.Err != nil {
				return deleted, result.Err
			}
			deleted++
		}
	}
	return deleted, nil
}

// GetPublicURL returns the public URL for an object
func (s *Storage) GetPublicURL(objectKey string) string {
	if IsProtectedStatusObjectKey(objectKey) {
		return ""
	}
	return fmt.Sprintf("%s/%s/%s", s.publicURL, s.bucket, objectKey)
}

// ExtractObjectKey extracts the object key from a full URL
func (s *Storage) ExtractObjectKey(fullURL string) (string, error) {
	parsed, err := url.Parse(fullURL)
	if err != nil {
		return "", err
	}

	// Remove leading slash and bucket name from path
	objectPath := parsed.Path
	for _, bucket := range []string{s.bucket, s.privateBucket} {
		prefix := "/" + bucket + "/"
		if strings.HasPrefix(objectPath, prefix) && len(objectPath) > len(prefix) {
			return objectPath[len(prefix):], nil
		}
	}

	return objectPath, nil
}

// GenerateMediaPath creates a path for media storage
func GenerateMediaPath(chatID uuid.UUID, messageID string, extension string) string {
	return path.Join("chats", chatID.String(), messageID+extension)
}

// GenerateAvatarPath creates a path for avatar storage
func GenerateAvatarPath(jid string) string {
	return path.Join("avatars", jid+".jpg")
}

// GenerateBroadcastPath creates a path for broadcast media (shared)
func GenerateBroadcastPath(extension string) string {
	return path.Join("broadcast", uuid.New().String()+extension)
}
