package main

import (
	"errors"
	"fmt"
	"net/url"
	"time"
)

func fixtureMediaURL(m *manifest, f mediaFile) string {
	path := "/api/media/file/" + f.ObjectKey
	if m.Profile != "regression" || f.Label == "legacy_plain" {
		return path
	}
	return (&url.URL{Path: path}).String()
}

// Both operations are restricted to a generated, ownership-checked regression
// manifest. They never migrate, alter configuration or touch another account.
func (lab laboratory) regressionNoise(m *manifest) error {
	if m.Profile != "regression" || m.State == "cleaned" {
		return errors.New("noise requires a live regression fixture")
	}
	var target *mediaFile
	for index := range m.Files {
		if m.Files[index].Label == "legacy_unicode" {
			target = &m.Files[index]
			break
		}
	}
	if target == nil {
		return errors.New("regression notification target is missing")
	}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for index := 0; index < 24; index++ {
		select {
		case <-lab.ctx.Done():
			return lab.ctx.Err()
		case <-ticker.C:
		}
		// A text-only message edit correctly does not invalidate media. Change
		// the label of an unselected fixture Chat instead: normal dependency
		// triggers dirty its one media source and the real worker emits hints.
		result, err := lab.db.Exec(lab.ctx, `UPDATE chats SET name=$3 WHERE account_id=$1 AND id=$2`, m.Accounts["a"].ID, target.ChatID, fmt.Sprintf("Unselected synthetic conversation %d", index+1))
		if err != nil {
			return err
		}
		if result.RowsAffected() != 1 {
			return errors.New("regression noise target was not the owned synthetic conversation")
		}
	}
	fmt.Println("Changed an unselected synthetic conversation label 24 times; message text and media references remain unchanged.")
	return nil
}

func (lab laboratory) regressionMissing(m *manifest) error {
	if m.Profile != "regression" || m.State == "cleaned" {
		return errors.New("missing simulation requires a live regression fixture")
	}
	for _, file := range m.Files {
		if file.Label != "missing" {
			continue
		}
		if _, err := lab.store.GetFileInfo(lab.ctx, file.ObjectKey); err != nil {
			return errors.New("cannot prove the synthetic missing target exists")
		}
		if err := lab.store.DeleteFile(lab.ctx, file.ObjectKey); err != nil {
			return errors.New("cannot remove the one synthetic object")
		}
		m.MissingObjectRemoved = true
		fmt.Println("Removed one owned synthetic object; its business references remain unchanged.")
		return nil
	}
	return errors.New("regression manifest has no missing-object fixture")
}
