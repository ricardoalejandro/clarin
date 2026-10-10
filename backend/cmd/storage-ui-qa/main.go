// storage-ui-qa prepares small, synthetic browser fixtures in the explicitly
// selected local cloud laboratory. It never migrates or starts any service.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
	"golang.org/x/crypto/bcrypt"
)

const apiBase = "http://127.0.0.1:8080"
const manifestKind = "clarin-storage-ui-qa-v1"

type account struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}
type actor struct {
	ID          uuid.UUID   `json:"id"`
	AccountID   uuid.UUID   `json:"account_id"`
	Username    string      `json:"username"`
	Password    string      `json:"password"`
	Permissions []string    `json:"permissions"`
	Memberships []uuid.UUID `json:"memberships"`
}
type mediaFile struct {
	Label        string    `json:"label"`
	AccountID    uuid.UUID `json:"account_id"`
	ObjectKey    string    `json:"object_key"`
	Filename     string    `json:"filename"`
	MediaType    string    `json:"media_type"`
	ContentType  string    `json:"content_type"`
	SizeBytes    int       `json:"size_bytes"`
	SHA256       string    `json:"sha256"`
	AssetID      uuid.UUID `json:"asset_id"`
	ContactID    uuid.UUID `json:"contact_id"`
	ChatID       uuid.UUID `json:"chat_id"`
	MessageID    uuid.UUID `json:"message_id"`
	InitialState string    `json:"initial_state"`
}
type manifest struct {
	Kind      string             `json:"kind"`
	RunID     uuid.UUID          `json:"run_id"`
	CreatedAt time.Time          `json:"created_at"`
	State     string             `json:"state"`
	RoleID    uuid.UUID          `json:"role_id"`
	Accounts  map[string]account `json:"accounts"`
	Actors    map[string]actor   `json:"actors"`
	Files     []mediaFile        `json:"files"`
}
type laboratory struct {
	ctx   context.Context
	db    *pgxpool.Pool
	store *storage.Storage
}

func main() {
	if err := run(); err != nil {
		// Never include environment variables, HTTP request bodies or cookies.
		fmt.Fprintln(os.Stderr, "Storage browser fixture:", err)
		os.Exit(1)
	}
}

func run() error {
	action := flag.String("action", "", "create, age-trash, verify or cleanup")
	manifestPath := flag.String("manifest", "", "private manifest path under work/")
	assets := flag.String("assets", "", "tests/fixtures/storage directory")
	label := flag.String("label", "", "exact fixture file label for age-trash")
	expect := flag.String("expect", "", "verification expectations, e.g. restore=active,purge=purged")
	flag.Parse()
	if os.Getenv("CLARIN_STORAGE_UI_QA") != "1" {
		return errors.New("requires explicit CLARIN_STORAGE_UI_QA=1")
	}
	if *action != "create" && *action != "age-trash" && *action != "verify" && *action != "cleanup" {
		return errors.New("choose create, age-trash, verify or cleanup")
	}
	if *manifestPath == "" {
		return errors.New("private manifest path is required")
	}
	dbConfig, err := localDatabaseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	if os.Getenv("MINIO_ENDPOINT") != "127.0.0.1:19001" || os.Getenv("MINIO_BUCKET") != "clarin-cloud-media" || os.Getenv("MINIO_USE_SSL") == "true" {
		return errors.New("requires the local MinIO laboratory 127.0.0.1:19001, bucket clarin-cloud-media")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	db, err := pgxpool.NewWithConfig(ctx, dbConfig)
	if err != nil {
		return errors.New("cannot configure local PostgreSQL")
	}
	defer db.Close()
	if err := db.Ping(ctx); err != nil {
		return errors.New("local PostgreSQL is unavailable")
	}
	store, err := storage.New(storage.Config{Endpoint: os.Getenv("MINIO_ENDPOINT"), Bucket: os.Getenv("MINIO_BUCKET"), AccessKey: os.Getenv("MINIO_ACCESS_KEY"), SecretKey: os.Getenv("MINIO_SECRET_KEY"), PublicURL: apiBase})
	if err != nil {
		return errors.New("cannot connect to local MinIO")
	}
	lab := laboratory{ctx: ctx, db: db, store: store}
	if *action == "create" {
		if _, err := os.Lstat(*manifestPath); !os.IsNotExist(err) {
			return errors.New("manifest already exists; clean its fixtures and choose a new manifest path")
		}
		m, err := newManifest()
		if err != nil {
			return err
		}
		// Persist recovery scope before the first database/object mutation.
		if err := writePrivateJSON(*manifestPath, m); err != nil {
			return err
		}
		if err := lab.create(m, *assets, *manifestPath); err != nil {
			return fmt.Errorf("create failed; use cleanup with this private manifest: %w", err)
		}
		fmt.Printf("Created %d synthetic files in two local QA accounts. Private manifest saved.\n", len(m.Files))
		return nil
	}
	m, err := readManifest(*manifestPath)
	if err != nil {
		return err
	}
	if err := lab.verifyOwnership(m, *action == "cleanup"); err != nil {
		return err
	}
	switch *action {
	case "age-trash":
		if err := lab.ageTrash(m, *label); err != nil {
			return err
		}
		fmt.Println("Only the selected synthetic trash item is now older than seven days.")
	case "verify":
		report, err := lab.verify(m, *expect)
		if err != nil {
			return err
		}
		if err := writePrivateJSON(*manifestPath+".verification.json", report); err != nil {
			return err
		}
		fmt.Printf("Verified %d synthetic SQL/media states and exact remaining bytes. Report saved.\n", len(report))
	case "cleanup":
		if err := lab.cleanup(m); err != nil {
			return err
		}
		m.State = "cleaned"
		for name, actor := range m.Actors {
			actor.Password = ""
			m.Actors[name] = actor
		}
		return writePrivateJSON(*manifestPath, m)
	}
	return nil
}

// Both the visible URL and the effective pgx target must identify this exact
// laboratory. pgx query parameters, PG environment and service settings can
// override URL components or add fallback hosts; never reparse after checking.
func localDatabaseConfig(raw string) (*pgxpool.Config, error) {
	denied := errors.New("requires the local PostgreSQL laboratory 127.0.0.1:15439/clarin_cloud_dev without foreign overrides or fallbacks")
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() != "127.0.0.1" || parsed.Port() != "15439" || parsed.Path != "/clarin_cloud_dev" {
		return nil, denied
	}
	cfg, err := pgxpool.ParseConfig(raw)
	if err != nil {
		return nil, denied
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || cfg.ConnConfig.Port != 15439 || cfg.ConnConfig.Database != "clarin_cloud_dev" {
		return nil, denied
	}
	for _, fallback := range cfg.ConnConfig.Fallbacks {
		if fallback == nil || fallback.Host != "127.0.0.1" || fallback.Port != 15439 {
			return nil, denied
		}
	}
	return cfg, nil
}

func newManifest() (*manifest, error) {
	id := uuid.New()
	prefix := "QA almacenamiento " + id.String()[:8]
	a, b := account{uuid.New(), prefix + " · Cuenta A"}, account{uuid.New(), prefix + " · Cuenta B"}
	m := &manifest{Kind: manifestKind, RunID: id, CreatedAt: time.Now().UTC(), State: "preparing", RoleID: uuid.New(), Accounts: map[string]account{"a": a, "b": b}, Actors: map[string]actor{}}
	for _, name := range []string{"admin_a", "member_a"} {
		secret := make([]byte, 24)
		if _, err := rand.Read(secret); err != nil {
			return nil, err
		}
		permissions, memberships := []string{domain.PermAll}, []uuid.UUID{a.ID, b.ID}
		if name == "member_a" {
			permissions, memberships = []string{domain.PermChats, domain.PermSettings}, []uuid.UUID{a.ID}
		}
		m.Actors[name] = actor{ID: uuid.New(), AccountID: a.ID, Username: "storageqa-" + name + "-" + id.String()[:8], Password: base64.RawURLEncoding.EncodeToString(secret), Permissions: permissions, Memberships: memberships}
	}
	return m, nil
}

func writePrivateJSON(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if err := validatePrivateOutputTarget(path); err != nil {
		return err
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	// Keep the previous recovery scope intact until a complete replacement is
	// persisted. In particular, never truncate the sole manifest after SQL commit.
	file, err := os.CreateTemp(filepath.Dir(path), ".storage-ui-qa-*.tmp")
	if err != nil {
		return err
	}
	defer file.Close()
	defer os.Remove(file.Name())
	if err := file.Chmod(0600); err != nil {
		return err
	}
	if _, err = file.Write(append(data, '\n')); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err = validatePrivateOutputTarget(path); err != nil {
		return err
	}
	if err = os.Rename(file.Name(), path); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func validatePrivateOutputTarget(path string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("refusing a symlink or non-regular file for private QA output")
	}
	return nil
}

func readManifest(path string) (*manifest, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("manifest must be a regular private 0600 file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	m := &manifest{}
	if err := json.Unmarshal(data, m); err != nil || m.Kind != manifestKind || m.RunID == uuid.Nil || len(m.Accounts) != 2 || m.Accounts["a"].ID == uuid.Nil || m.Accounts["b"].ID == uuid.Nil || m.Accounts["a"].ID == m.Accounts["b"].ID {
		return nil, errors.New("not a valid storage browser QA manifest")
	}
	for _, file := range m.Files {
		if (file.AccountID != m.Accounts["a"].ID && file.AccountID != m.Accounts["b"].ID) || !strings.HasPrefix(file.ObjectKey, file.AccountID.String()+"/qa-browser/"+m.RunID.String()+"/") {
			return nil, errors.New("manifest object is outside the generated QA scope")
		}
	}
	return m, nil
}

func (lab laboratory) verifyOwnership(m *manifest, allowMissing bool) error {
	for _, key := range []string{"a", "b"} {
		a := m.Accounts[key]
		want := "QA almacenamiento " + m.RunID.String()[:8] + " · Cuenta " + strings.ToUpper(key)
		if a.Name != want {
			return errors.New("manifest account name is not owned by this QA run")
		}
		var got string
		err := lab.db.QueryRow(lab.ctx, `SELECT name FROM accounts WHERE id=$1`, a.ID).Scan(&got)
		if allowMissing && errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil || got != want {
			return errors.New("current account no longer matches this QA run; refusing mutation")
		}
	}
	return nil
}

func (lab laboratory) create(m *manifest, assets, manifestPath string) error {
	pdf, err := os.ReadFile(filepath.Join(assets, "preview.pdf"))
	if err != nil {
		return errors.New("read synthetic preview.pdf fixture")
	}
	video, err := os.ReadFile(filepath.Join(assets, "preview.webm"))
	if err != nil {
		return errors.New("read synthetic preview.webm fixture")
	}
	imageBytes, err := syntheticPNG(0)
	if err != nil {
		return err
	}
	type spec struct {
		label, filename, mediaType, contentType, initialState string
		payload                                               []byte
	}
	specs := []spec{
		{"photo", "Foto del espacio.png", "image", "image/png", "active", imageBytes},
		{"photo_two", "Agenda de actividades.png", "image", "image/png", "active", imageBytes},
		{"video", "Recorrido de prueba.webm", "video", "video/webm", "active", video},
		{"audio", "Bienvenida.wav", "audio", "audio/wav", "active", syntheticWAV(16000)},
		{"document", "Plan de actividades.pdf", "document", "application/pdf", "active", pdf},
		{"long_name", "Documento con un nombre deliberadamente largo para verificar lectura completa, accesibilidad y distribución de la lista de almacenamiento.pdf", "document", "application/pdf", "active", pdf},
		{"shared", "Compartido con respuesta rápida.pdf", "document", "application/pdf", "active", pdf},
		{"restore", "Solo retiro y restauración.pdf", "document", "application/pdf", "active", pdf},
		{"purge", "Borrado definitivo permitido.pdf", "document", "application/pdf", "trash", pdf},
		{"trash_recent", "Papelera reciente protegida.pdf", "document", "application/pdf", "trash", pdf},
		{"large_audio", "Grabación grande de prueba.wav", "audio", "audio/wav", "active", syntheticWAV(12 * 1024 * 1024)},
		{"other_account", "Privado de la cuenta B.pdf", "document", "application/pdf", "active", pdf},
	}
	for index, s := range specs {
		// Distinct valid bytes keep the production account/hash uniqueness rule
		// intact while browser scenarios retain independent file lifecycles.
		if s.mediaType == "document" {
			s.payload = append(append([]byte{}, s.payload...), []byte("\n% storage-browser-qa "+m.RunID.String()+" "+s.label+"\n")...)
		} else if s.label == "photo_two" {
			s.payload, err = syntheticPNG(1)
			if err != nil {
				return err
			}
		}
		specs[index].payload = s.payload
		accountID := m.Accounts["a"].ID
		if s.label == "other_account" {
			accountID = m.Accounts["b"].ID
		}
		digest := sha256.Sum256(s.payload)
		m.Files = append(m.Files, mediaFile{Label: s.label, AccountID: accountID, ObjectKey: accountID.String() + "/qa-browser/" + m.RunID.String() + "/" + s.label + filepath.Ext(s.filename), Filename: s.filename, MediaType: s.mediaType, ContentType: s.contentType, SizeBytes: len(s.payload), SHA256: hex.EncodeToString(digest[:]), AssetID: uuid.New(), ContactID: uuid.New(), ChatID: uuid.New(), MessageID: uuid.New(), InitialState: s.initialState})
	}
	if err := writePrivateJSON(manifestPath, m); err != nil {
		return err
	}
	tx, err := lab.db.Begin(lab.ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(lab.ctx)
	exec := func(query string, args ...any) error { _, err := tx.Exec(lab.ctx, query, args...); return err }
	for _, key := range []string{"a", "b"} {
		a := m.Accounts[key]
		if err := exec(`INSERT INTO accounts(id,name,storage_limit_bytes) VALUES($1,$2,1073741824)`, a.ID, a.Name); err != nil {
			return err
		}
	}
	if err := exec(`INSERT INTO roles(id,name,permissions) VALUES($1,$2,$3)`, m.RoleID, "storage-ui-qa-"+m.RunID.String(), []string{domain.PermChats, domain.PermSettings}); err != nil {
		return err
	}
	for _, name := range []string{"admin_a", "member_a"} {
		a := m.Actors[name]
		hash, err := bcrypt.GenerateFromPassword([]byte(a.Password), bcrypt.DefaultCost)
		if err != nil {
			return err
		}
		role, admin := "agent", false
		if name == "admin_a" {
			role, admin = "admin", true
		}
		if err := exec(`INSERT INTO users(id,account_id,username,email,password_hash,display_name,is_admin,is_super_admin,is_active,role) VALUES($1,$2,$3,$4,$5,$6,$7,false,true,$8)`, a.ID, a.AccountID, a.Username, a.Username+"@test.invalid", string(hash), "QA almacenamiento · "+name, admin, role); err != nil {
			return err
		}
		for _, accountID := range a.Memberships {
			if err := exec(`INSERT INTO user_accounts(user_id,account_id,role,role_id,is_default) VALUES($1,$2,$3,$4,$5)`, a.ID, accountID, role, m.RoleID, accountID == a.AccountID); err != nil {
				return err
			}
		}
	}
	for index, f := range m.Files {
		if _, err := lab.store.UploadObject(lab.ctx, f.ObjectKey, specs[index].payload, f.ContentType); err != nil {
			return fmt.Errorf("upload synthetic %s: %w", f.Label, err)
		}
		if err := exec(`INSERT INTO media_assets(id,account_id,content_hash,object_key,media_type,content_type,filename,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, f.AssetID, f.AccountID, f.SHA256, f.ObjectKey, f.MediaType, f.ContentType, f.Filename, f.SizeBytes); err != nil {
			return err
		}
		if err := exec(`INSERT INTO storage_objects(account_id,object_key,media_type,content_type,filename,size_bytes,source) VALUES($1,$2,$3,$4,$5,$6,'whatsapp')`, f.AccountID, f.ObjectKey, f.MediaType, f.ContentType, f.Filename, f.SizeBytes); err != nil {
			return err
		}
		jid := f.ContactID.String() + "@test.invalid"
		if err := exec(`INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,$4)`, f.ContactID, f.AccountID, jid, "Contacto sintético · "+f.Label); err != nil {
			return err
		}
		if err := exec(`INSERT INTO chats(id,account_id,jid,contact_id) VALUES($1,$2,$3,$4)`, f.ChatID, f.AccountID, jid, f.ContactID); err != nil {
			return err
		}
		if err := exec(`INSERT INTO messages(id,account_id,chat_id,message_id,body,message_type,media_url,media_mimetype,media_filename,media_size,media_asset_id,timestamp) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`, f.MessageID, f.AccountID, f.ChatID, uuid.NewString(), messageBody(f), f.MediaType, "/api/media/file/"+f.ObjectKey, f.ContentType, f.Filename, f.SizeBytes, f.AssetID); err != nil {
			return err
		}
		if f.Label == "shared" {
			if err := exec(`INSERT INTO quick_replies(account_id,shortcut,title,body,media_url,media_type,media_filename) VALUES($1,$2,'Respuesta compartida QA','Contenido sintético',$3,$4,$5)`, f.AccountID, "qa-"+m.RunID.String()[:8], "/api/media/file/"+f.ObjectKey, f.MediaType, f.Filename); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(lab.ctx); err != nil {
		return err
	}
	m.State = "seeded"
	if err := writePrivateJSON(manifestPath, m); err != nil {
		return err
	}
	client, err := newAPIClient()
	if err != nil {
		return err
	}
	a := m.Actors["admin_a"]
	if err := apiJSON(client, "/api/auth/login", map[string]any{"username": a.Username, "password": a.Password}, nil); err != nil {
		return err
	}
	defer apiJSON(client, "/api/auth/logout", map[string]any{}, nil)
	for _, f := range m.Files {
		if f.InitialState != "trash" {
			continue
		}
		var preview struct {
			PreviewID     uuid.UUID `json:"preview_id"`
			EligibleCount int       `json:"eligible_count"`
		}
		if err := apiJSON(client, "/api/storage/cleanup/preview", map[string]any{"action": "trash", "object_keys": []string{f.ObjectKey}}, &preview); err != nil {
			return err
		}
		if preview.PreviewID == uuid.Nil || preview.EligibleCount != 1 {
			return errors.New("synthetic trash preview was not eligible")
		}
		var confirmation struct {
			Status string `json:"status"`
		}
		if err := apiJSON(client, "/api/storage/cleanup/confirm", map[string]any{"preview_id": preview.PreviewID}, &confirmation); err != nil {
			return err
		}
		if confirmation.Status != "completed" {
			return errors.New("synthetic trash initialization did not complete")
		}
	}
	if err := lab.ageTrash(m, "purge"); err != nil {
		return err
	}
	m.State = "ready"
	return writePrivateJSON(manifestPath, m)
}

func newAPIClient() (*http.Client, error) {
	jar, err := cookiejar.New(nil)
	return &http.Client{Jar: jar, Timeout: 30 * time.Second}, err
}

func apiJSON(client *http.Client, path string, body any, target any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	res, err := client.Post(apiBase+path, "application/json", bytes.NewReader(encoded))
	if err != nil {
		return fmt.Errorf("local API unavailable at %s", path)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("local API %s returned HTTP %d", path, res.StatusCode)
	}
	if target != nil {
		return json.NewDecoder(res.Body).Decode(target)
	}
	_, err = io.Copy(io.Discard, res.Body)
	return err
}

func (lab laboratory) ageTrash(m *manifest, label string) error {
	for _, f := range m.Files {
		if f.Label != label {
			continue
		}
		tag, err := lab.db.Exec(lab.ctx, `UPDATE storage_media_trash SET removed_at=NOW()-INTERVAL '8 days',purge_after=NOW()-INTERVAL '1 day',updated_at=NOW() WHERE account_id=$1 AND object_key=$2 AND state='trash'`, f.AccountID, f.ObjectKey)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return errors.New("selected synthetic file is not currently in trash")
		}
		return nil
	}
	return errors.New("age-trash requires an exact file label from this manifest")
}

func messageBody(f mediaFile) string {
	return "Mensaje sintético de QA que debe conservarse · " + f.Label
}

func (lab laboratory) verify(m *manifest, expectations string) ([]map[string]any, error) {
	expected := map[string]string{}
	for _, item := range strings.Split(expectations, ",") {
		if item == "" {
			continue
		}
		parts := strings.SplitN(item, "=", 2)
		if len(parts) != 2 {
			return nil, errors.New("expected states use label=active,trash,purged")
		}
		expected[parts[0]] = parts[1]
	}
	report := make([]map[string]any, 0, len(m.Files))
	for _, f := range m.Files {
		var ledger, body, mediaURL string
		var deleted bool
		var assetID *uuid.UUID
		if err := lab.db.QueryRow(lab.ctx, `SELECT body,COALESCE(media_deleted,false),COALESCE(media_url,''),media_asset_id FROM messages WHERE account_id=$1 AND id=$2 AND chat_id=$3`, f.AccountID, f.MessageID, f.ChatID).Scan(&body, &deleted, &mediaURL, &assetID); err != nil {
			return nil, err
		}
		if body != messageBody(f) {
			return nil, fmt.Errorf("message history changed for %s", f.Label)
		}
		err := lab.db.QueryRow(lab.ctx, `SELECT state FROM storage_media_trash WHERE account_id=$1 AND object_key=$2`, f.AccountID, f.ObjectKey).Scan(&ledger)
		if errors.Is(err, pgx.ErrNoRows) {
			ledger = "none"
		} else if err != nil {
			return nil, err
		}
		state := ledger
		if state == "none" || state == "restored" {
			state = "active"
		}
		if want, ok := expected[f.Label]; ok {
			if want != state {
				return nil, fmt.Errorf("%s has state %s, expected %s", f.Label, state, want)
			}
			delete(expected, f.Label)
		}
		if state == "active" {
			if deleted || assetID == nil || *assetID != f.AssetID || mediaURL != "/api/media/file/"+f.ObjectKey {
				return nil, fmt.Errorf("active message attachment differs for %s", f.Label)
			}
		} else if !deleted || assetID != nil || mediaURL != "" {
			return nil, fmt.Errorf("removed attachment remains on message %s", f.Label)
		}
		info, err := lab.store.GetFileInfo(lab.ctx, f.ObjectKey)
		present := err == nil
		if err != nil && minio.ToErrorResponse(err).Code != "NoSuchKey" {
			return nil, fmt.Errorf("cannot inspect fixture bytes for %s", f.Label)
		}
		if state == "purged" && present {
			return nil, fmt.Errorf("purged object still exists for %s", f.Label)
		}
		if state != "purged" && !present {
			return nil, fmt.Errorf("retained fixture object missing for %s", f.Label)
		}
		if present {
			data, err := lab.store.GetFile(lab.ctx, f.ObjectKey)
			if err != nil {
				return nil, err
			}
			hash := sha256.Sum256(data)
			if info.Size != int64(f.SizeBytes) || hex.EncodeToString(hash[:]) != f.SHA256 {
				return nil, fmt.Errorf("exact bytes changed for %s", f.Label)
			}
		}
		var inventoryCount int
		if err := lab.db.QueryRow(lab.ctx, `SELECT COUNT(*) FROM storage_objects WHERE account_id=$1 AND object_key=$2 AND status='active'`, f.AccountID, f.ObjectKey).Scan(&inventoryCount); err != nil {
			return nil, err
		}
		if state == "purged" && inventoryCount != 0 {
			return nil, fmt.Errorf("purged inventory remains for %s", f.Label)
		}
		if state != "purged" && inventoryCount != 1 {
			return nil, fmt.Errorf("retained inventory missing for %s", f.Label)
		}
		var inventoryStatus, assetStatus string
		if err := lab.db.QueryRow(lab.ctx, `SELECT status FROM storage_objects WHERE account_id=$1 AND object_key=$2`, f.AccountID, f.ObjectKey).Scan(&inventoryStatus); err != nil {
			return nil, err
		}
		if err := lab.db.QueryRow(lab.ctx, `SELECT status FROM media_assets WHERE account_id=$1 AND id=$2`, f.AccountID, f.AssetID).Scan(&assetStatus); err != nil {
			return nil, err
		}
		if state == "purged" && (inventoryStatus != "deleted" || assetStatus != "deleted") {
			return nil, fmt.Errorf("purged inventory audit is not retained for %s", f.Label)
		}
		report = append(report, map[string]any{"label": f.Label, "account_id": f.AccountID, "state": state, "ledger_state": ledger, "message_preserved": true, "object_present": present, "exact_bytes_verified": present, "size_bytes": f.SizeBytes, "active_inventory_count": inventoryCount, "inventory_status": inventoryStatus, "asset_status": assetStatus})
	}
	if len(expected) != 0 {
		return nil, errors.New("unknown file label in verification expectations")
	}
	return report, nil
}

func (lab laboratory) cleanup(m *manifest) error {
	ids := []uuid.UUID{m.Accounts["a"].ID, m.Accounts["b"].ID}
	var count int
	var totalBytes int64
	for _, id := range ids {
		objects, err := lab.store.ListPrefix(lab.ctx, id.String()+"/")
		if err != nil {
			return err
		}
		count += len(objects)
		for _, object := range objects {
			totalBytes += object.Size
		}
	}
	// Remove account-owned references transactionally before removing bytes.
	// These lists are the defaults automatically created by membership triggers.
	tx, err := lab.db.Begin(lab.ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(lab.ctx)
	if _, err := tx.Exec(lab.ctx, `DELETE FROM task_lists WHERE account_id=ANY($1::uuid[])`, ids); err != nil {
		return err
	}
	if _, err := tx.Exec(lab.ctx, `DELETE FROM accounts WHERE id=ANY($1::uuid[])`, ids); err != nil {
		return err
	}
	if _, err := tx.Exec(lab.ctx, `DELETE FROM roles WHERE id=$1 AND name=$2`, m.RoleID, "storage-ui-qa-"+m.RunID.String()); err != nil {
		return err
	}
	if err := tx.Commit(lab.ctx); err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := lab.store.DeletePrefix(lab.ctx, id.String()+"/"); err != nil {
			return err
		}
		objects, err := lab.store.ListPrefix(lab.ctx, id.String()+"/")
		if err != nil || len(objects) != 0 {
			return errors.New("QA object cleanup did not finish; rerun cleanup")
		}
	}
	fmt.Printf("Removed only generated QA accounts and their %d remaining objects (%d bytes); remaining objects: 0.\n", count, totalBytes)
	return nil
}

func syntheticPNG(variation int) ([]byte, error) {
	picture := image.NewRGBA(image.Rect(0, 0, 640, 360))
	for y := 0; y < 360; y++ {
		for x := 0; x < 640; x++ {
			picture.SetRGBA(x, y, color.RGBA{R: uint8(40 + x/8), G: uint8(85 + y/3), B: uint8(170 + variation), A: 255})
		}
	}
	var encoded bytes.Buffer
	err := png.Encode(&encoded, picture)
	return encoded.Bytes(), err
}

func syntheticWAV(payloadSize int) []byte {
	data := make([]byte, 44+payloadSize)
	copy(data, "RIFF")
	binary.LittleEndian.PutUint32(data[4:], uint32(len(data)-8))
	copy(data[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(data[16:], 16)
	binary.LittleEndian.PutUint16(data[20:], 1)
	binary.LittleEndian.PutUint16(data[22:], 1)
	binary.LittleEndian.PutUint32(data[24:], 8000)
	binary.LittleEndian.PutUint32(data[28:], 16000)
	binary.LittleEndian.PutUint16(data[32:], 2)
	binary.LittleEndian.PutUint16(data[34:], 16)
	copy(data[36:], "data")
	binary.LittleEndian.PutUint32(data[40:], uint32(payloadSize))
	return data
}
