// This fixture opens only a deliberately named, disposable PostgreSQL database.
// It never creates a WhatsApp client, connects a session, or sends a message.
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	_ "github.com/jackc/pgx/v5/stdlib"
	"go.mau.fi/whatsmeow/proto/waAdv"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
)

var deviceJID = types.NewJID("51900000001", types.DefaultUserServer)
var chatJID = types.NewJID("51900000002", types.DefaultUserServer)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Whatsmeow migration QA:", err)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) != 2 || (os.Args[1] != "seed-v14" && os.Args[1] != "upgrade-v16" && os.Args[1] != "old-store-v16") {
		return errors.New("expected seed-v14, upgrade-v16, or old-store-v16")
	}
	dsn := os.Getenv("CLARIN_WHATSMEOW_QA_DATABASE_URL")
	config, err := pgx.ParseConfig(dsn)
	if dsn == "" || err != nil || !strings.HasPrefix(config.Database, "clarin_whatsmeow_upgrade_qa_") {
		return errors.New("use CLARIN_WHATSMEOW_QA_DATABASE_URL for a disposable database named clarin_whatsmeow_upgrade_qa_<suffix>")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return errors.New("could not open QA PostgreSQL")
	}
	defer db.Close()
	var actualDatabase string
	if err = db.QueryRowContext(ctx, "SELECT current_database()").Scan(&actualDatabase); err != nil {
		return errors.New("could not connect to QA PostgreSQL")
	}
	if actualDatabase != config.Database {
		return errors.New("database identity did not match the explicit QA target")
	}
	phase := os.Args[1]
	if phase == "seed-v14" {
		var count int
		if err = db.QueryRowContext(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").Scan(&count); err != nil {
			return err
		}
		if count != 0 {
			return errors.New("seed requires an empty public schema; no existing tables will be removed")
		}
	} else if err = assertVersion(ctx, db, map[string]int{"upgrade-v16": 14, "old-store-v16": 16}[phase]); err != nil {
		return err
	}

	// sqlstore.New runs the migration path used by Clarin startup. No client
	// is instantiated, so even the synthetic session can never reach WhatsApp.
	container, err := sqlstore.New(ctx, "pgx", dsn, nil)
	if err != nil {
		return fmt.Errorf("open SQL store: %w", err)
	}
	defer container.Close()
	if phase == "seed-v14" {
		if err = assertVersion(ctx, db, 14); err != nil {
			return err
		}
		device := container.NewDevice()
		device.ID = &deviceJID
		device.Platform = "isolated-qa-only"
		device.Account = &waAdv.ADVSignedDeviceIdentity{
			Details: []byte{}, AccountSignature: make([]byte, 64),
			AccountSignatureKey: make([]byte, 32), DeviceSignature: make([]byte, 64),
		}
		if err = device.Save(ctx); err != nil {
			return err
		}
		if err = device.ChatSettings.PutPinned(ctx, chatJID, true); err != nil {
			return err
		}
		if _, err = db.ExecContext(ctx, "CREATE TABLE clarin_whatsmeow_upgrade_qa_messages (id TEXT PRIMARY KEY); INSERT INTO clarin_whatsmeow_upgrade_qa_messages VALUES ('before-upgrade')"); err != nil {
			return err
		}
		fmt.Println("PASS seed: v14/compat8, synthetic device and pinned chat persisted")
		return nil
	}
	if err = assertVersion(ctx, db, 16); err != nil {
		return err
	}
	device, err := container.GetDevice(ctx, deviceJID)
	if err != nil || device == nil {
		return errors.New("existing synthetic device could not be loaded")
	}
	settings, err := device.ChatSettings.GetChatSettings(ctx, chatJID)
	if err != nil || !settings.Found || !settings.Pinned {
		return errors.New("existing pinned setting was not preserved")
	}
	if phase == "upgrade-v16" {
		if _, err = db.ExecContext(ctx, "UPDATE whatsmeow_device SET companion_meta_nonce='qa-nonce' WHERE jid=$1", deviceJID.String()); err != nil {
			return err
		}
		if _, err = db.ExecContext(ctx, "UPDATE whatsmeow_chat_settings SET wasa_root_secret_id='qa-root' WHERE our_jid=$1 AND chat_jid=$2", deviceJID.String(), chatJID.String()); err != nil {
			return err
		}
		if _, err = db.ExecContext(ctx, "INSERT INTO clarin_whatsmeow_upgrade_qa_messages VALUES ('after-upgrade')"); err != nil {
			return err
		}
		// Reopening the latest store proves that the version gate does not
		// execute either additive migration a second time.
		reopened, openErr := sqlstore.New(ctx, "pgx", dsn, nil)
		if openErr != nil {
			return fmt.Errorf("reopen migrated store: %w", openErr)
		}
		reopened.Close()
	} else {
		// Exercise old SELECT/UPSERT contracts after the latest store wrote
		// its new fields. They must leave those fields and later data intact.
		device.PushName = "old-store-after-upgrade"
		if err = device.Save(ctx); err != nil {
			return err
		}
		if err = device.ChatSettings.PutPinned(ctx, chatJID, false); err != nil {
			return err
		}
		if err = device.ChatSettings.PutPinned(ctx, chatJID, true); err != nil {
			return err
		}
	}
	var nonce, root string
	if err = db.QueryRowContext(ctx, "SELECT companion_meta_nonce FROM whatsmeow_device WHERE jid=$1", deviceJID.String()).Scan(&nonce); err != nil {
		return err
	}
	if err = db.QueryRowContext(ctx, "SELECT wasa_root_secret_id FROM whatsmeow_chat_settings WHERE our_jid=$1 AND chat_jid=$2", deviceJID.String(), chatJID.String()).Scan(&root); err != nil {
		return err
	}
	var messages int
	if err = db.QueryRowContext(ctx, "SELECT count(*) FROM clarin_whatsmeow_upgrade_qa_messages WHERE id IN ('before-upgrade', 'after-upgrade')").Scan(&messages); err != nil {
		return err
	}
	if nonce != "qa-nonce" || root != "qa-root" || messages != 2 {
		return errors.New("new columns or before/after synthetic messages were not preserved")
	}
	if err = assertVersion(ctx, db, 16); err != nil {
		return err
	}
	fmt.Printf("PASS %s: v16/compat8 retained; old and new fields and both synthetic messages preserved\n", phase)
	return nil
}

func assertVersion(ctx context.Context, db *sql.DB, expected int) error {
	var version, compat int
	if err := db.QueryRowContext(ctx, "SELECT version, compat FROM whatsmeow_version").Scan(&version, &compat); err != nil {
		return fmt.Errorf("read store version: %w", err)
	}
	if version != expected || compat != 8 {
		return fmt.Errorf("expected version=%d compat=8, got version=%d compat=%d", expected, version, compat)
	}
	return nil
}
