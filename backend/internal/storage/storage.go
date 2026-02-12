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
	client       *minio.Client
	bucket       string
	publicURL    string
	internalURL  string // internal endpoint (for URL replacement)
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
		client:      client,
		bucket:      cfg.Bucket,
		publicURL:   cfg.PublicURL,
		internalURL: internalURL,
	}

	// Ensure bucket exists
	if err := s.ensureBucket(context.Background()); err != nil {
		return nil, err
	}

	return s, nil
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

		// Set public read policy for the bucket
		policy := fmt.Sprintf(`{
			"Version": "2012-10-17",
			"Statement": [
				{
					"Effect": "Allow",
					"Principal": {"AWS": ["*"]},
					"Action": ["s3:GetObject"],
					"Resource": ["arn:aws:s3:::%s/*"]
				}
			]
		}`, s.bucket)

		if err := s.client.SetBucketPolicy(ctx, s.bucket, policy); err != nil {
			return fmt.Errorf("failed to set bucket policy: %w", err)
		}
	}

	return nil
}

// UploadFile uploads a file to storage and returns the public URL
func (s *Storage) UploadFile(ctx context.Context, accountID uuid.UUID, folder, filename string, data []byte, contentType string) (string, error) {
	// Generate object key: accountID/folder/filename
	objectKey := path.Join(accountID.String(), folder, filename)

	_, err := s.client.PutObject(ctx, s.bucket, objectKey, bytes.NewReader(data), int64(len(data)), minio.PutObjectOptions{
		ContentType: contentType,
	})
	if err != nil {
		return "", fmt.Errorf("failed to upload file: %w", err)
	}

	// Return the public URL
	return fmt.Sprintf("%s/%s/%s", s.publicURL, s.bucket, objectKey), nil
}

// UploadReader uploads from a reader
func (s *Storage) UploadReader(ctx context.Context, accountID uuid.UUID, folder, filename string, reader io.Reader, size int64, contentType string) (string, error) {
	objectKey := path.Join(accountID.String(), folder, filename)

	_, err := s.client.PutObject(ctx, s.bucket, objectKey, reader, size, minio.PutObjectOptions{
		ContentType: contentType,
	})
	if err != nil {
		return "", fmt.Errorf("failed to upload file: %w", err)
	}

	return fmt.Sprintf("%s/%s/%s", s.publicURL, s.bucket, objectKey), nil
}

// GetPresignedUploadURL generates a presigned URL for direct upload
func (s *Storage) GetPresignedUploadURL(ctx context.Context, accountID uuid.UUID, folder, filename string) (string, error) {
	objectKey := path.Join(accountID.String(), folder, filename)

	presignedURL, err := s.client.PresignedPutObject(ctx, s.bucket, objectKey, 15*time.Minute)
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
	object, err := s.client.GetObject(ctx, s.bucket, objectKey, minio.GetObjectOptions{})
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
	return s.client.StatObject(ctx, s.bucket, objectKey, minio.StatObjectOptions{})
}

// GetFileRange retrieves a byte range of a file from storage
func (s *Storage) GetFileRange(ctx context.Context, objectKey string, offset, length int64) ([]byte, error) {
	opts := minio.GetObjectOptions{}
	if length > 0 {
		opts.SetRange(offset, offset+length-1)
	} else {
		opts.SetRange(offset, 0)
	}
	object, err := s.client.GetObject(ctx, s.bucket, objectKey, opts)
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
	if err := s.client.RemoveObject(ctx, s.bucket, objectKey, minio.RemoveObjectOptions{}); err != nil {
		return fmt.Errorf("failed to delete file: %w", err)
	}
	return nil
}

// GetPublicURL returns the public URL for an object
func (s *Storage) GetPublicURL(objectKey string) string {
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
	prefix := "/" + s.bucket + "/"
	if len(objectPath) > len(prefix) {
		return objectPath[len(prefix):], nil
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
