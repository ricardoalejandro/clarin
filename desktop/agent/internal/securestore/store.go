package securestore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
)

var safeName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`)

type Protector interface {
	Protect(plain, entropy []byte) ([]byte, error)
	Unprotect(ciphertext, entropy []byte) ([]byte, error)
}

type Store struct {
	dir       string
	entropy   []byte
	protector Protector
}

func New(dir, terminalID string) (*Store, error) {
	protector, err := platformProtector()
	if err != nil {
		return nil, err
	}
	return NewWithProtector(dir, terminalID, protector)
}

func NewWithProtector(dir, terminalID string, protector Protector) (*Store, error) {
	if dir == "" || terminalID == "" || protector == nil {
		return nil, errors.New("secure store requires directory, terminal identity, and protector")
	}
	return &Store{dir: dir, entropy: []byte("clarin-offline-v2:" + terminalID), protector: protector}, nil
}

func (s *Store) Save(name string, value any) error {
	path, err := s.path(name)
	if err != nil {
		return err
	}
	plain, err := json.Marshal(value)
	if err != nil {
		return err
	}
	protected, err := s.protector.Protect(plain, s.entropy)
	if err != nil {
		return fmt.Errorf("protect offline state: %w", err)
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return err
	}
	tmp := path + ".next"
	file, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err = file.Write(protected); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	backup := path + ".previous"
	_ = os.Remove(backup)
	if _, statErr := os.Stat(path); statErr == nil {
		if err := os.Rename(path, backup); err != nil {
			return err
		}
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Rename(backup, path)
		return err
	}
	_ = os.Remove(backup)
	return nil
}

func (s *Store) Load(name string, value any) error {
	path, err := s.path(name)
	if err != nil {
		return err
	}
	target := reflect.ValueOf(value)
	if target.Kind() != reflect.Pointer || target.IsNil() {
		return errors.New("secure-store load target must be a non-nil pointer")
	}
	var lastErr error
	for _, candidate := range []string{path, path + ".previous", path + ".next"} {
		protected, readErr := os.ReadFile(candidate)
		if errors.Is(readErr, os.ErrNotExist) {
			continue
		}
		if readErr != nil {
			lastErr = readErr
			continue
		}
		plain, unprotectErr := s.protector.Unprotect(protected, s.entropy)
		if unprotectErr != nil {
			lastErr = fmt.Errorf("unprotect offline state: %w", unprotectErr)
			continue
		}
		candidateValue := reflect.New(target.Elem().Type())
		if decodeErr := json.Unmarshal(plain, candidateValue.Interface()); decodeErr != nil {
			lastErr = fmt.Errorf("decode offline state: %w", decodeErr)
			continue
		}
		target.Elem().Set(candidateValue.Elem())
		return nil
	}
	if lastErr != nil {
		return lastErr
	}
	return os.ErrNotExist
}

func (s *Store) Delete(name string) error {
	path, err := s.path(name)
	if err != nil {
		return err
	}
	for _, candidate := range []string{path, path + ".previous", path + ".next"} {
		if err := os.Remove(candidate); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (s *Store) Size(name string) (int64, error) {
	path, err := s.path(name)
	if err != nil {
		return 0, err
	}
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

func (s *Store) path(name string) (string, error) {
	if !safeName.MatchString(name) {
		return "", errors.New("unsafe secure-store item name")
	}
	return filepath.Join(s.dir, name+".dpapi"), nil
}
