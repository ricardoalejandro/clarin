package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/programtransfer"
)

type transferLink struct {
	Kind, PortableID, LocalID string
	Baseline                  programtransfer.Baseline
}

type transferSnapshot struct {
	Target         string
	Rows, Contacts []programtransfer.Record
	Links          []transferLink
	ContactLinks   []transferLink
	SharedCourses  []string
}

type transferIndex struct {
	rows                     map[string]programtransfer.Record
	byKind                   map[string][]programtransfer.Record
	links                    map[string]transferLink
	scopeLinks               map[string]transferLink
	aliases                  map[string][]string
	phoneOwners, emailOwners map[string][]string
	natural                  map[string]programtransfer.Record
	shared                   map[string]bool
}

type transferChange struct {
	Portable programtransfer.Record
	Local    programtransfer.Record
	Existing bool
	Write    bool
}

type transferPlan struct {
	Preview   programtransfer.Preview
	ProgramID uuid.UUID
	Changes   []transferChange
	Links     map[string]transferLink
}

// ProgramTransferContactQuota is the subscription entitlement resolved before
// opening the import transaction. The destination usage must be counted on
// the import's own connection, not via another borrow from the same pool.
type ProgramTransferContactQuota struct {
	Maximum   int
	LookupErr error
}

func transferKey(kind, id string) string { return kind + ":" + id }

func ExportProgramTransfer(ctx context.Context, db *pgxpool.Pool, accountID, programID uuid.UUID) (file programtransfer.File, err error) {
	tx, err := db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return file, err
	}
	defer tx.Rollback(ctx)
	defer func() { err = transferDatabaseError(err) }()
	if err = lockProgramTransfer(ctx, tx, accountID); err != nil {
		return file, err
	}
	rows, err := ReadProgramTransfer(ctx, tx, accountID, programID)
	if err != nil {
		return file, err
	}
	links, err := readProgramTransferLinks(ctx, tx, accountID, programID)
	if err != nil {
		return file, err
	}
	index := buildTransferIndex(transferSnapshot{Rows: rows, Links: links})
	programtransfer.Sort(rows)
	for i := range rows {
		row := &rows[i]
		key := transferKey(row.Kind, row.ID)
		row.Aliases = index.aliases[key]
		base := programtransfer.Current(*row, index.links[key].Baseline)
		row.Revisions = make(map[string]programtransfer.Revision, len(base))
		for field, entry := range base {
			row.Revisions[field] = entry.Revision
		}
	}
	file = programtransfer.File{Version: programtransfer.Version, Records: rows}
	if err = programtransfer.ValidateFile(file); err != nil {
		return programtransfer.File{}, err
	}
	batch := &pgx.Batch{}
	for _, row := range rows {
		queueTransferLink(batch, index.links, accountID, programID, row.Kind, row.ID, row.ID, programtransfer.BaselineOf(row))
	}
	if err = flushTransferLinks(ctx, tx, batch); err != nil {
		return programtransfer.File{}, err
	}
	return file, tx.Commit(ctx)
}

func PreviewProgramTransfer(ctx context.Context, db *pgxpool.Pool, accountID uuid.UUID, req programtransfer.Request) (programtransfer.Preview, error) {
	if err := checkTransferRequest(req); err != nil {
		return programtransfer.Preview{}, err
	}
	tx, err := db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return programtransfer.Preview{}, err
	}
	defer tx.Rollback(ctx)
	snap, err := readTransferSnapshot(ctx, tx, accountID, req)
	if err != nil {
		return programtransfer.Preview{}, transferDatabaseError(err)
	}
	plan, err := planProgramTransfer(snap, req, nil)
	if err != nil {
		return programtransfer.Preview{}, err
	}
	return plan.Preview, transferDatabaseError(tx.Commit(ctx))
}

func ConfirmProgramTransfer(ctx context.Context, db *pgxpool.Pool, accountID, actorID uuid.UUID, req programtransfer.ConfirmRequest, expectedDigest string, quota ProgramTransferContactQuota) (result programtransfer.Result, err error) {
	if err := checkTransferRequest(req.Request); err != nil {
		return result, err
	}
	if len(req.Decisions) > programtransfer.MaxConflicts {
		return result, programtransfer.ErrInvalid
	}
	for _, value := range req.Decisions {
		if value != "local" && value != "incoming" {
			return result, programtransfer.ErrInvalid
		}
	}
	conn, release, err := acquireProgramTransferConnection(ctx, db, accountID)
	if err != nil {
		return result, transferDatabaseError(err)
	}
	defer release()
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	defer func() { err = transferDatabaseError(err) }()
	snap, err := readTransferSnapshot(ctx, tx, accountID, req.Request)
	if err != nil {
		return result, err
	}
	if expectedDigest == "" || expectedDigest != transferDigest(snap, req.Request) {
		return result, programtransfer.ErrStale
	}
	plan, err := planProgramTransfer(snap, req.Request, req.Decisions)
	if err != nil {
		return result, err
	}
	if len(plan.Preview.Conflicts) > 0 {
		return result, programtransfer.ErrConflict
	}
	newContacts := 0
	for _, item := range plan.Changes {
		if item.Write && !item.Existing && item.Local.Kind == "contact" {
			newContacts++
		}
	}
	if err = enforceProgramTransferContactQuota(ctx, tx, accountID, quota, newContacts); err != nil {
		return result, err
	}
	batch := &pgx.Batch{}
	for _, item := range plan.Changes {
		if item.Write {
			if err = WriteProgramTransferRecord(ctx, tx, accountID, plan.ProgramID, actorID, item.Local, !item.Existing); err != nil {
				return result, fmt.Errorf("write program transfer %s: %w", item.Local.Kind, err)
			}
		}
		k, id := item.Local.Kind, item.Local.ID
		queueTransferLink(batch, plan.Links, accountID, plan.ProgramID, k, id, id, programtransfer.BaselineOf(item.Local))
		for _, alias := range transferIdentities(item.Portable) {
			if alias != id {
				queueTransferLink(batch, plan.Links, accountID, plan.ProgramID, k, alias, id, nil)
			}
		}
	}
	if err = flushTransferLinks(ctx, tx, batch); err != nil {
		return result, err
	}
	result = programtransfer.Result{ProgramID: plan.ProgramID.String(), Summary: plan.Preview.Summary}
	if _, err = tx.Exec(ctx, `INSERT INTO program_transfer_imports(account_id,program_id,actor_id,summary) VALUES($1,$2,$3,$4::jsonb)`, accountID, plan.ProgramID, actorID, result.Summary); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}

func lockProgramTransfer(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, accountID.String())
	return err
}

// Acquire the same advisory key as the canonical Contact writers, on a
// pinned connection BEFORE opening SERIALIZABLE. Otherwise the SELECT that
// waits for the lock establishes its snapshot before the preceding Contact
// transaction commits, and the quota count can be stale after the wait.
func acquireProgramTransferConnection(ctx context.Context, db *pgxpool.Pool, accountID uuid.UUID) (*pgxpool.Conn, func(), error) {
	conn, err := db.Acquire(ctx)
	if err != nil {
		return nil, nil, err
	}
	key := accountID.String()
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtext($1::text))`, key); err != nil {
		// The server may have acquired the session lock before the client saw
		// the failure. Close the connection instead of returning it to the pool.
		closeProgramTransferConnection(conn)
		return nil, nil, err
	}
	return conn, func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		var unlocked bool
		if err := conn.QueryRow(cleanup, `SELECT pg_advisory_unlock(hashtext($1::text))`, key).Scan(&unlocked); err != nil || !unlocked {
			closeProgramTransferConnection(conn)
			return
		}
		conn.Release()
	}, nil
}

func closeProgramTransferConnection(conn *pgxpool.Conn) {
	cleanup, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = conn.Hijack().Close(cleanup)
}

type programTransferQuotaQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func enforceProgramTransferContactQuota(ctx context.Context, tx programTransferQuotaQueryer, accountID uuid.UUID, quota ProgramTransferContactQuota, incoming int) error {
	if incoming == 0 {
		return nil
	}
	if quota.LookupErr != nil || (quota.Maximum > 0 && incoming > quota.Maximum) {
		return programtransfer.ErrContactLimit
	}
	if quota.Maximum <= 0 {
		return nil
	}
	var existing int64
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM contacts WHERE account_id=$1`, accountID).Scan(&existing); err != nil {
		return fmt.Errorf("%w: %w", programtransfer.ErrContactLimit, err)
	}
	if existing > int64(quota.Maximum-incoming) {
		return programtransfer.ErrContactLimit
	}
	return nil
}

func transferDatabaseError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return programtransfer.ErrNotFound
	}
	if errors.Is(err, ErrProgramTransferRecordScope) || errors.Is(err, ErrContactIdentityConflict) {
		return programtransfer.ErrStale
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "40001", "40P01", "23505":
			return programtransfer.ErrStale
		case "22001", "22003", "22007", "22008", "22P02", "23502", "23503", "23514":
			return programtransfer.ErrInvalid
		}
	}
	return err
}

func checkTransferRequest(req programtransfer.Request) error {
	if req.TargetProgramID != "" && !programtransfer.IsID(req.TargetProgramID) {
		return programtransfer.ErrInvalid
	}
	if len(req.Mappings) > programtransfer.MaxConflicts {
		return programtransfer.ErrTooLarge
	}
	for key, value := range req.Mappings {
		if !programtransfer.IsID(key) || (value != "create" && !programtransfer.IsID(value)) {
			return programtransfer.ErrInvalid
		}
	}
	if err := programtransfer.ValidateFile(req.File); err != nil {
		return err
	}
	// Legacy accounts can contain two Contacts with the same visible number.
	// Do not promise two independent creations that canonical ownership would reject.
	seenPhones := map[string]string{}
	for _, row := range req.File.Records {
		if row.Kind != "contact" {
			continue
		}
		for _, phone := range transferVisiblePhones(row) {
			if other := seenPhones[phone]; other != "" && other != row.ID {
				return programtransfer.ErrSourceContactCollision
			}
			seenPhones[phone] = row.ID
		}
	}
	return nil
}

func transferIdentities(r programtransfer.Record) []string {
	return append([]string{r.ID}, r.Aliases...)
}

func readTransferSnapshot(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, req programtransfer.Request) (transferSnapshot, error) {
	var snap transferSnapshot
	var incoming programtransfer.Record
	for _, row := range req.File.Records {
		if row.Kind == "program" {
			incoming = row
			break
		}
	}
	// An established equivalent program is resolved using only this account's
	// links. An explicit selection may not fork an already linked program.
	var linked []string
	identities := transferIdentities(incoming)
	ids := make([]uuid.UUID, len(identities))
	for i, id := range identities {
		ids[i] = uuid.MustParse(id)
	}
	if err := tx.QueryRow(ctx, `SELECT COALESCE(array_agg(DISTINCT program_id::text),'{}') FROM program_transfer_links WHERE account_id=$1 AND kind='program' AND portable_id=ANY($2::uuid[])`, accountID, ids).Scan(&linked); err != nil {
		return snap, err
	}
	if len(linked) > 1 || (len(linked) == 1 && req.TargetProgramID != "" && req.TargetProgramID != linked[0]) {
		return snap, programtransfer.ErrConflict
	}
	snap.Target = req.TargetProgramID
	if len(linked) == 1 {
		snap.Target = linked[0]
	}
	if snap.Target != "" {
		id := uuid.MustParse(snap.Target)
		var err error
		snap.Rows, err = ReadProgramTransfer(ctx, tx, accountID, id)
		if err != nil {
			return snap, err
		}
		snap.Links, err = readProgramTransferLinks(ctx, tx, accountID, id)
		if err != nil {
			return snap, err
		}
		snap.SharedCourses, err = ReadProgramTransferSharedCourses(ctx, tx, accountID, id)
		if err != nil {
			return snap, err
		}
	}
	var phones, emails []string
	var contactIDs []uuid.UUID
	var contactIdentities []uuid.UUID
	for _, row := range req.File.Records {
		if row.Kind != "contact" {
			continue
		}
		for _, identity := range transferIdentities(row) {
			contactIdentities = append(contactIdentities, uuid.MustParse(identity))
		}
		phones = append(phones, transferVisiblePhones(row)...)
		if email := transferEmail(row); email != "" {
			emails = append(emails, email)
		}
	}
	for _, link := range snap.Links {
		if link.Kind == "contact" {
			contactIDs = append(contactIDs, uuid.MustParse(link.LocalID))
		}
	}
	var err error
	snap.ContactLinks, err = readProgramTransferContactLinks(ctx, tx, accountID, contactIdentities)
	if err != nil {
		return snap, err
	}
	for _, link := range snap.ContactLinks {
		contactIDs = append(contactIDs, uuid.MustParse(link.LocalID))
	}
	if len(phones)+len(emails)+len(contactIDs) > 0 {
		var err error
		snap.Contacts, err = ReadProgramTransferContacts(ctx, tx, accountID, phones, emails, contactIDs)
		if err != nil {
			return snap, err
		}
	}
	programtransfer.Sort(snap.Rows)
	programtransfer.Sort(snap.Contacts)
	return snap, nil
}

// Contact identity belongs to the receiving account, not one Program. A known
// portable Contact must be reused even when its second Program is imported and
// no phone/email is available. Historical revisions remain Program-scoped.
func readProgramTransferContactLinks(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, identities []uuid.UUID) ([]transferLink, error) {
	if len(identities) == 0 {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT l.portable_id::text,l.local_id::text
		FROM program_transfer_links l
		JOIN contacts c ON c.account_id=l.account_id AND c.id=l.local_id
		WHERE l.account_id=$1 AND l.kind='contact' AND l.portable_id=ANY($2::uuid[])
		  AND NOT COALESCE(c.is_group,FALSE)
		ORDER BY l.portable_id::text,l.local_id::text LIMIT $3::int`, accountID, identities, len(identities)+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	links := make([]transferLink, 0)
	owners := make(map[string]string)
	for rows.Next() {
		link := transferLink{Kind: "contact"}
		if err := rows.Scan(&link.PortableID, &link.LocalID); err != nil {
			return nil, err
		}
		if owner := owners[link.PortableID]; owner != "" && owner != link.LocalID {
			return nil, programtransfer.ErrConflict
		}
		owners[link.PortableID] = link.LocalID
		links = append(links, link)
	}
	return links, rows.Err()
}

func transferDigest(snap transferSnapshot, req programtransfer.Request) string {
	return programtransfer.Fingerprint(struct {
		Snapshot transferSnapshot
		Request  programtransfer.Request
	}{snap, req})
}

func readProgramTransferLinks(ctx context.Context, tx pgx.Tx, account, program uuid.UUID) ([]transferLink, error) {
	rows, err := tx.Query(ctx, `SELECT kind,portable_id::text,local_id::text,baseline FROM program_transfer_links WHERE account_id=$1 AND program_id=$2 ORDER BY kind,portable_id LIMIT $3`, account, program, 2*programtransfer.MaxRecords+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []transferLink
	for rows.Next() {
		var link transferLink
		var raw []byte
		if err = rows.Scan(&link.Kind, &link.PortableID, &link.LocalID, &raw); err != nil {
			return nil, err
		}
		if len(raw) > 0 {
			if err = json.Unmarshal(raw, &link.Baseline); err != nil {
				return nil, err
			}
		}
		result = append(result, link)
	}
	if len(result) > 2*programtransfer.MaxRecords {
		return nil, programtransfer.ErrTooLarge
	}
	return result, rows.Err()
}

func queueTransferLink(batch *pgx.Batch, existing map[string]transferLink, account, program uuid.UUID, kind, portable, local string, baseline programtransfer.Baseline) {
	old, found := existing[transferKey(kind, portable)]
	if found && old.LocalID == local && programtransfer.Fingerprint(old.Baseline) == programtransfer.Fingerprint(baseline) {
		return
	}
	var stored any
	if baseline != nil {
		stored = baseline
	}
	batch.Queue(`INSERT INTO program_transfer_links(account_id,program_id,kind,portable_id,local_id,baseline)
		VALUES($1,$2,$3,$4::uuid,$5::uuid,$6::jsonb) ON CONFLICT(account_id,program_id,kind,portable_id)
		DO UPDATE SET baseline=EXCLUDED.baseline WHERE program_transfer_links.local_id=EXCLUDED.local_id`, account, program, kind, uuid.MustParse(portable), uuid.MustParse(local), stored)
}

func flushTransferLinks(ctx context.Context, tx pgx.Tx, batch *pgx.Batch) error {
	if batch.Len() == 0 {
		return nil
	}
	results := tx.SendBatch(ctx, batch)
	defer results.Close()
	for i := 0; i < batch.Len(); i++ {
		tag, err := results.Exec()
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return programtransfer.ErrConflict
		}
	}
	return results.Close()
}

func buildTransferIndex(snap transferSnapshot) transferIndex {
	idx := transferIndex{rows: map[string]programtransfer.Record{}, byKind: map[string][]programtransfer.Record{}, links: map[string]transferLink{}, scopeLinks: map[string]transferLink{}, aliases: map[string][]string{}, phoneOwners: map[string][]string{}, emailOwners: map[string][]string{}, natural: map[string]programtransfer.Record{}, shared: map[string]bool{}}
	for _, id := range snap.SharedCourses {
		idx.shared[id] = true
	}
	for _, row := range append(append([]programtransfer.Record{}, snap.Rows...), snap.Contacts...) {
		key := transferKey(row.Kind, row.ID)
		if row.Kind == "contact" {
			for _, phone := range transferVisiblePhones(row) {
				idx.phoneOwners[phone] = appendTransferUnique(idx.phoneOwners[phone], row.ID)
			}
			if values, ok := row.Fields["match_phone_aliases"].([]any); ok {
				for _, value := range values {
					if phone, ok := value.(string); ok {
						idx.phoneOwners[phone] = appendTransferUnique(idx.phoneOwners[phone], row.ID)
					}
				}
			}
			if email := transferEmail(row); email != "" {
				idx.emailOwners[email] = appendTransferUnique(idx.emailOwners[email], row.ID)
			}
			row.Fields = copyTransferFields(row.Fields)
			delete(row.Fields, "match_phone_aliases")
		}
		if _, found := idx.rows[key]; !found {
			idx.byKind[row.Kind] = append(idx.byKind[row.Kind], row)
		}
		idx.rows[key] = row
		if natural := transferNaturalKey(row); natural != "" {
			idx.natural[natural] = row
		}
	}
	for _, link := range snap.ContactLinks {
		idx.links[transferKey(link.Kind, link.PortableID)] = link
	}
	for _, link := range snap.Links {
		idx.links[transferKey(link.Kind, link.PortableID)] = link
		idx.scopeLinks[transferKey(link.Kind, link.PortableID)] = link
		if link.PortableID != link.LocalID {
			key := transferKey(link.Kind, link.LocalID)
			idx.aliases[key] = append(idx.aliases[key], link.PortableID)
		}
	}
	for _, values := range idx.aliases {
		sort.Strings(values)
	}
	return idx
}

func copyTransferFields(fields map[string]any) map[string]any {
	result := make(map[string]any, len(fields))
	for key, value := range fields {
		result[key] = value
	}
	return result
}

func appendTransferUnique(values []string, id string) []string {
	for _, old := range values {
		if old == id {
			return values
		}
	}
	return append(values, id)
}

func transferEmail(row programtransfer.Record) string {
	return strings.ToLower(strings.TrimSpace(programtransfer.String(row.Fields, "email")))
}

func transferVisiblePhones(row programtransfer.Record) []string {
	var phones []string
	if raw := programtransfer.String(row.Fields, "phone"); raw != "" {
		if p, err := normalizeContactProfilePhone(raw); err == nil {
			phones = append(phones, p)
		}
	}
	if values, ok := row.Fields["additional_phones"].([]any); ok {
		for _, value := range values {
			if entry, ok := value.(map[string]any); ok {
				if p, err := normalizeContactProfilePhone(programtransfer.String(entry, "phone")); err == nil {
					phones = appendTransferUnique(phones, p)
				}
			}
		}
	}
	return phones
}

func transferNaturalKey(row programtransfer.Record) string {
	s := func(key string) string { return programtransfer.String(row.Fields, key) }
	switch row.Kind {
	case "goal":
		return "goal"
	case "program_course":
		return "program_course:" + s("course_id")
	case "instructor", "participant":
		return row.Kind + ":" + s("contact_id")
	case "session_topic":
		return "session_topic:" + s("session_id") + ":" + s("kind") + ":" + s("course_id")
	case "attendance":
		return "attendance:" + s("session_id") + ":" + s("participant_id")
	}
	return ""
}

func planProgramTransfer(snap transferSnapshot, req programtransfer.Request, decisions map[string]string) (transferPlan, error) {
	plan := transferPlan{Preview: programtransfer.Preview{Digest: transferDigest(snap, req), TargetProgramID: snap.Target, Conflicts: []programtransfer.Conflict{}}}
	plan.ProgramID = uuid.New()
	if snap.Target != "" {
		plan.ProgramID = uuid.MustParse(snap.Target)
	}
	index := buildTransferIndex(snap)
	plan.Links = index.scopeLinks
	rows := append([]programtransfer.Record{}, req.File.Records...)
	programtransfer.Sort(rows)
	incoming := map[string]programtransfer.Record{}
	for _, r := range rows {
		incoming[r.ID] = r
	}
	mapped, claimed := map[string]string{}, map[string]bool{}
	ignored := map[string]bool{}
	keepSessionTopics := map[string]bool{}
	usedMappings, usedDecisions := map[string]bool{}, map[string]bool{}
	closedTarget := false
	for _, row := range rows {
		if row.Kind == "session_topic" && keepSessionTopics[programtransfer.String(row.Fields, "session_id")] {
			plan.Preview.Summary.Unchanged++
			continue
		}
		local := row
		local.Fields = copyTransferFields(row.Fields)
		local.Revisions = make(map[string]programtransfer.Revision, len(row.Revisions))
		for field, rev := range row.Revisions {
			local.Revisions[field] = rev
		}
		dependsOnIgnored := false
		for field, value := range row.Fields {
			if programtransfer.ReferenceKind(field) != "" && value != nil {
				ref := programtransfer.String(row.Fields, field)
				if ignored[ref] {
					dependsOnIgnored = true
					break
				}
				if id := mapped[ref]; id != "" {
					local.Fields[field] = id
				} else {
					return plan, programtransfer.ErrInvalid
				}
			}
		}
		if dependsOnIgnored {
			ignored[row.ID] = true
			plan.Preview.Summary.Unchanged++
			continue
		}
		label := transferLabel(row, incoming)
		var target programtransfer.Record
		if row.Kind == "program" {
			local.ID = plan.ProgramID.String()
			plan.Preview.ProgramName = programtransfer.String(row.Fields, "name")
			if snap.Target != "" {
				target = index.rows[transferKey("program", snap.Target)]
				if target.ID == "" {
					return plan, programtransfer.ErrNotFound
				}
				closedTarget = programtransfer.String(target.Fields, "status") != "active"
				plan.Preview.ProgramName = programtransfer.String(target.Fields, "name")
			}
		} else {
			id, known, err := resolveTransferIdentity(index, row)
			if err != nil {
				return plan, err
			}
			if known {
				target = index.rows[transferKey(row.Kind, id)]
				if target.ID == "" {
					// Do not resurrect a row previously removed in the receiving account.
					ignored[row.ID] = true
					plan.Preview.Summary.Unchanged++
					continue
				}
			} else if key := transferNaturalKey(local); key != "" {
				target = index.natural[key]
			} else {
				var options []programtransfer.Record
				var auto, canCreate bool
				options, auto, canCreate = transferCandidates(index, local)
				selection, explicit := req.Mappings[row.ID]
				if explicit {
					usedMappings[row.ID] = true
				}
				if explicit && selection == "create" {
					if !canCreate || len(options) == 0 {
						return plan, programtransfer.ErrInvalid
					}
				} else if explicit {
					for _, option := range options {
						if option.ID == selection {
							target = option
							break
						}
					}
					if target.ID == "" {
						return plan, programtransfer.ErrInvalid
					}
				} else if auto && len(options) == 1 {
					target = options[0]
				} else if len(options) > 0 {
					plan.Preview.Conflicts = append(plan.Preview.Conflicts, transferMappingConflict(row, label, options, canCreate))
					// Stage matching before the affected fields and child records.
					ignored[row.ID] = true
					continue
				}
			}
			if target.ID != "" {
				local.ID = target.ID
			} else {
				local.ID = uuid.NewString()
				switch row.Kind {
				case "program_course":
					local.ID = ProgramTransferAssociationID(plan.ProgramID, row.Kind, uuid.MustParse(programtransfer.String(local.Fields, "course_id")))
				case "instructor":
					local.ID = ProgramTransferAssociationID(plan.ProgramID, row.Kind, uuid.MustParse(programtransfer.String(local.Fields, "contact_id")))
				}
			}
		}
		key := transferKey(row.Kind, local.ID)
		if claimed[key] {
			return plan, programtransfer.ErrInvalid
		}
		claimed[key] = true
		mapped[row.ID] = local.ID
		if len(appendTransferAliases(index.aliases[key], row, local.ID)) > programtransfer.MaxAliases {
			return plan, programtransfer.ErrTooLarge
		}
		if target.ID == "" {
			if row.Kind == "course_topic" && index.shared[programtransfer.String(local.Fields, "course_id")] {
				return plan, programtransfer.ErrConflict
			}
			plan.Changes = append(plan.Changes, transferChange{Portable: row, Local: local, Write: true})
			plan.Preview.Summary.Create++
			addProgramTransferPreviewItem(&plan.Preview, "create", row.Kind, label)
			continue
		}
		beforeConflicts := len(plan.Preview.Conflicts)
		base := programtransfer.Current(target, index.links[key].Baseline)
		incomingPrimaryExtra := ""
		if row.Kind == "contact" {
			incomingPrimaryExtra = transferCompatiblePrimaryExtra(target, row, base, index)
		}
		if row.Kind == "session" {
			removed, localTopics, incomingTopics := transferSessionTopicRemoval(index, rows, row.ID, target.ID, mapped)
			if removed {
				conflictKey := row.ID + ":topics"
				if decision, exists := decisions[conflictKey]; exists {
					if decision != "local" {
						return plan, programtransfer.ErrInvalid
					}
					usedDecisions[conflictKey] = true
				} else {
					plan.Preview.Conflicts = append(plan.Preview.Conflicts, programtransfer.Conflict{
						Key: conflictKey, Kind: "session", Label: label, Field: "topics",
						Local: localTopics, Incoming: incomingTopics,
						Choices: []programtransfer.Choice{{Value: "local", Label: "Conservar los temas locales de esta clase"}},
					})
				}
				// The file cannot express removal of an immutable historical topic
				// snapshot. Keep the complete local collection and its compatibility
				// fields together after review; never mix free and course topics.
				keepSessionTopics[row.ID] = true
				for _, field := range []string{"topic", "course_topic_id"} {
					if value, exists := target.Fields[field]; exists {
						local.Fields[field] = value
						local.Revisions[field] = programtransfer.Extend(base[field].Revision, row.Revisions[field])
					}
				}
			}
		}
		fields := make([]string, 0, len(local.Fields))
		for f := range local.Fields {
			fields = append(fields, f)
		}
		sort.Strings(fields)
		changed := false
		for _, field := range fields {
			left, right := target.Fields[field], local.Fields[field]
			l, r := base[field].Revision, local.Revisions[field]
			if programtransfer.ReferenceKind(field) != "" && field != "course_topic_id" && !(field == "session_id" && (row.Kind == "participant_note" || row.Kind == "interaction")) && programtransfer.Fingerprint(left) != programtransfer.Fingerprint(right) {
				return plan, programtransfer.ErrInvalid
			}
			value, rev, conflict := programtransfer.MergeField(left, right, l, r)
			localOnly := transferLocalOnly(row, field, target, index)
			if row.Kind == "contact" {
				stale := l.ID != r.ID && programtransfer.Descends(l, r)
				if field == "additional_phones" && (!stale || incomingPrimaryExtra != "") {
					incomingPhones := right
					if stale {
						incomingPhones = nil
					}
					if incomingPrimaryExtra != "" {
						entries, _ := incomingPhones.([]any)
						incomingPhones = append(append([]any{}, entries...), map[string]any{"phone": incomingPrimaryExtra, "label": "mobile"})
					}
					value = transferMergePhones(left, incomingPhones, programtransfer.String(target.Fields, "phone"), target.ID, index.phoneOwners)
					if phones, _ := value.([]any); len(phones) > 64 {
						return plan, programtransfer.ErrTooLarge
					}
					if programtransfer.Fingerprint(value) != programtransfer.Fingerprint(left) || (!programtransfer.Descends(l, r) && programtransfer.Fingerprint(left) != programtransfer.Fingerprint(right)) {
						rev = programtransfer.Extend(l, r)
					}
					conflict = false
				} else if field == "phone" && incomingPrimaryExtra != "" {
					// A new compatible number is represented as an extra phone; keep
					// the receiving account's deliberate primary without losing data.
					value, rev, conflict = left, programtransfer.Extend(l, r), false
				} else if !stale && isTransferBlank(left) && !isTransferBlank(right) {
					if field == "phone" && transferForeignPhoneOwner(index, programtransfer.String(local.Fields, "phone"), target.ID) {
						value, rev, conflict = left, programtransfer.Extend(l, r), false
					} else {
						value, rev, conflict = right, programtransfer.Extend(l, r), false
					}
				} else if !stale && isTransferBlank(right) {
					value = left
					conflict = false
					if !programtransfer.Descends(l, r) {
						rev = programtransfer.Extend(l, r)
					}
				}
			}
			if localOnly && programtransfer.Fingerprint(value) != programtransfer.Fingerprint(left) {
				conflict = true
			}
			if conflict {
				conflictKey := row.ID + ":" + field
				decision, exists := decisions[conflictKey]
				if exists {
					usedDecisions[conflictKey] = true
					if decision == "local" {
						value = left
					} else if decision == "incoming" && !localOnly {
						value = right
					} else {
						return plan, programtransfer.ErrInvalid
					}
					rev = programtransfer.Extend(l, r)
				} else {
					entry := programtransfer.Conflict{Key: conflictKey, Kind: row.Kind, Label: label, Field: field, Local: transferDisplayValue(left), Incoming: transferDisplayValue(right)}
					if localOnly {
						entry.Choices = []programtransfer.Choice{{Value: "local", Label: "Conservar el dato local"}}
					}
					plan.Preview.Conflicts = append(plan.Preview.Conflicts, entry)
				}
			}
			local.Fields[field], local.Revisions[field] = value, rev
			if programtransfer.Fingerprint(value) != programtransfer.Fingerprint(left) {
				changed = true
			}
		}
		plan.Changes = append(plan.Changes, transferChange{Portable: row, Local: local, Existing: true, Write: changed})
		if len(plan.Preview.Conflicts) == beforeConflicts {
			if changed {
				plan.Preview.Summary.Update++
				addProgramTransferPreviewItem(&plan.Preview, "update", row.Kind, label)
			} else {
				plan.Preview.Summary.Unchanged++
			}
		}
	}
	if len(plan.Preview.Conflicts) > programtransfer.MaxConflicts {
		return plan, programtransfer.ErrTooLarge
	}
	if len(plan.Preview.Conflicts) == 0 && (len(usedMappings) != len(req.Mappings) || len(usedDecisions) != len(decisions)) {
		return plan, programtransfer.ErrInvalid
	}
	plan.Preview.Summary.Conflicts = len(plan.Preview.Conflicts)
	if closedTarget && (plan.Preview.Summary.Create+plan.Preview.Summary.Update+plan.Preview.Summary.Conflicts > 0) {
		return plan, programtransfer.ErrClosed
	}
	return plan, nil
}

// A slot is the one free topic or a course's topic within a class. Same-slot
// edits can merge and new courses can be added. Losing an existing slot needs
// review because omission from an exchange file is never deletion.
func transferSessionTopicRemoval(index transferIndex, rows []programtransfer.Record, incomingSessionID, localSessionID string, mapped map[string]string) (bool, []string, []string) {
	localSlots, incomingSlots := map[string]bool{}, map[string]bool{}
	localLabels, incomingLabels := []string{}, []string{}
	slot := func(row programtransfer.Record, courseID string) string {
		return programtransfer.String(row.Fields, "kind") + ":" + courseID
	}
	for _, row := range index.byKind["session_topic"] {
		if programtransfer.String(row.Fields, "session_id") != localSessionID {
			continue
		}
		localSlots[slot(row, programtransfer.String(row.Fields, "course_id"))] = true
		localLabels = append(localLabels, transferTopicLabel(row))
	}
	if len(localSlots) == 0 {
		return false, nil, nil
	}
	for _, row := range rows {
		if row.Kind != "session_topic" || programtransfer.String(row.Fields, "session_id") != incomingSessionID {
			continue
		}
		courseID := programtransfer.String(row.Fields, "course_id")
		if courseID != "" {
			courseID = mapped[courseID]
			if courseID == "" {
				// A course identity must be resolved before reviewing its class.
				return false, nil, nil
			}
		}
		incomingSlots[slot(row, courseID)] = true
		incomingLabels = append(incomingLabels, transferTopicLabel(row))
	}
	sort.Strings(localLabels)
	sort.Strings(incomingLabels)
	for key := range localSlots {
		if !incomingSlots[key] {
			return true, localLabels, incomingLabels
		}
	}
	return false, localLabels, incomingLabels
}

func transferTopicLabel(row programtransfer.Record) string {
	title := programtransfer.String(row.Fields, "topic_title_snapshot")
	if programtransfer.String(row.Fields, "kind") == "free" {
		return shortTransferString("Tema libre: " + title)
	}
	return shortTransferString(programtransfer.String(row.Fields, "course_name_snapshot") + ": " + title)
}

func addProgramTransferPreviewItem(preview *programtransfer.Preview, action, kind, label string) {
	if len(preview.Items) < 100 {
		preview.Items = append(preview.Items, programtransfer.PreviewItem{Action: action, Kind: kind, Label: label})
	}
}

func resolveTransferIdentity(index transferIndex, row programtransfer.Record) (string, bool, error) {
	id := ""
	for _, alias := range transferIdentities(row) {
		key := transferKey(row.Kind, alias)
		local := index.links[key].LocalID
		if local == "" && index.rows[key].ID != "" {
			local = alias
		}
		if local != "" {
			if id != "" && local != id {
				return "", false, programtransfer.ErrConflict
			}
			id = local
		}
	}
	return id, id != "", nil
}

func appendTransferAliases(old []string, row programtransfer.Record, localID string) []string {
	result := append([]string{}, old...)
	for _, id := range transferIdentities(row) {
		if id != localID {
			result = appendTransferUnique(result, id)
		}
	}
	return result
}

func transferCandidates(index transferIndex, row programtransfer.Record) (options []programtransfer.Record, automatic, canCreate bool) {
	canCreate = true
	s := func(key string) string { return programtransfer.String(row.Fields, key) }
	if row.Kind == "contact" {
		var ids, phonesWithOwner []string
		for _, phone := range transferVisiblePhones(row) {
			owners := index.phoneOwners[phone]
			if len(owners) > 0 {
				phonesWithOwner = append(phonesWithOwner, phone)
				canCreate = false
			}
			for _, id := range owners {
				ids = appendTransferUnique(ids, id)
			}
		}
		for _, id := range index.emailOwners[transferEmail(row)] {
			ids = appendTransferUnique(ids, id)
		}
		for _, id := range ids {
			if candidate := index.rows[transferKey("contact", id)]; candidate.ID != "" {
				options = append(options, candidate)
			}
		}
		if len(options) == 1 {
			candidate := options[0]
			matchesEmail := transferEmail(row) != "" && transferEmail(row) == transferEmail(candidate)
			matchesPhone := false
			for _, p := range transferVisiblePhones(candidate) {
				for _, q := range phonesWithOwner {
					if p == q {
						matchesPhone = true
					}
				}
			}
			incomingPrimary, localPrimary := normalizeAliasValue("phone", s("phone")), normalizeAliasValue("phone", programtransfer.String(candidate.Fields, "phone"))
			differentPrimaries := incomingPrimary != "" && localPrimary != "" && incomingPrimary != localPrimary
			differentEmails := transferEmail(row) != "" && transferEmail(candidate) != "" && !matchesEmail
			automatic = (matchesPhone || matchesEmail) && !(differentPrimaries && !matchesPhone) && !differentEmails
		}
		if len(options) == 0 && s("name") != "" && len(transferVisiblePhones(row)) == 0 && transferEmail(row) == "" {
			for _, candidate := range index.byKind["contact"] {
				if strings.EqualFold(s("name"), programtransfer.String(candidate.Fields, "name")) {
					options = append(options, candidate)
				}
			}
		}
	} else {
		for _, candidate := range index.byKind[row.Kind] {
			v := func(key string) string { return programtransfer.String(candidate.Fields, key) }
			switch row.Kind {
			case "course":
				if !index.shared[candidate.ID] && strings.EqualFold(s("name"), v("name")) {
					options = append(options, candidate)
				}
			case "course_topic":
				if s("course_id") == v("course_id") && strings.EqualFold(s("title"), v("title")) {
					options = append(options, candidate)
				}
			case "session":
				if s("date") == v("date") || (s("title") != "" && strings.EqualFold(s("title"), v("title"))) {
					options = append(options, candidate)
				}
			}
		}
	}
	sort.Slice(options, func(i, j int) bool { return options[i].ID < options[j].ID })
	return
}

func transferMappingConflict(row programtransfer.Record, label string, options []programtransfer.Record, canCreate bool) programtransfer.Conflict {
	values := make([]programtransfer.Choice, 0, len(options)+1)
	for _, option := range options {
		name := transferLabel(option, nil)
		if row.Kind == "contact" {
			for _, key := range []string{"phone", "email"} {
				if value := programtransfer.String(option.Fields, key); value != "" {
					name += " · " + value
				}
			}
		}
		values = append(values, programtransfer.Choice{Value: option.ID, Label: shortTransferString(name)})
	}
	if canCreate {
		values = append(values, programtransfer.Choice{Value: "create", Label: "Crear un registro nuevo"})
	}
	return programtransfer.Conflict{Key: row.ID + ":match", Kind: row.Kind, Label: label, MappingKey: row.ID, Choices: values}
}

func transferLabel(row programtransfer.Record, incoming map[string]programtransfer.Record) string {
	s := func(key string) string { return programtransfer.String(row.Fields, key) }
	if row.Kind == "session" {
		return shortTransferString(strings.TrimSpace(s("date") + " " + s("start_time") + " " + s("title")))
	}
	if row.Kind == "attendance" {
		participant, session := incoming[s("participant_id")], incoming[s("session_id")]
		contact := incoming[programtransfer.String(participant.Fields, "contact_id")]
		return shortTransferString(transferLabel(contact, nil) + " · " + transferLabel(session, nil))
	}
	if row.Kind == "participant" || row.Kind == "instructor" {
		if contact := incoming[s("contact_id")]; contact.ID != "" {
			return transferLabel(contact, nil)
		}
	}
	for _, key := range []string{"name", "title", "topic_title_snapshot", "notes", "note", "phone", "email"} {
		if value := s(key); value != "" {
			return shortTransferString(value)
		}
	}
	labels := map[string]string{"contact": "Contacto sin nombre", "course": "Curso", "course_topic": "Tema", "goal": "Metas del programa", "program_course": "Curso asignado", "session_observation": "Observación de clase", "participant_note": "Nota de seguimiento", "interaction": "Observación de participante"}
	if label := labels[row.Kind]; label != "" {
		return label
	}
	return "Registro del programa"
}

func shortTransferString(raw string) string {
	const max = 360
	if r := []rune(raw); len(r) > max {
		return string(r[:max]) + "…"
	}
	return raw
}

func transferDisplayValue(value any) any {
	if s, ok := value.(string); ok {
		return shortTransferString(s)
	}
	return value
}

func transferLocalOnly(row programtransfer.Record, field string, target programtransfer.Record, index transferIndex) bool {
	// Existing notes keep their original contextual relationship and interaction
	// type. The restore writer deliberately does not reparent these historical
	// records; expose that restriction during review instead of promising an
	// update that would always fail its scoped UPDATE predicate.
	if field == "session_id" && (row.Kind == "participant_note" || row.Kind == "interaction") {
		return true
	}
	if row.Kind == "interaction" && field == "type" {
		return true
	}
	if row.Kind == "program" && (field == "status" || field == "archived_from_status") {
		return true
	}
	if row.Kind == "contact" && field != "additional_phones" && !isTransferBlank(target.Fields[field]) {
		return true
	}
	if row.Kind == "course" && index.shared[target.ID] {
		return true
	}
	if row.Kind == "course_topic" && index.shared[programtransfer.String(target.Fields, "course_id")] {
		return true
	}
	return field == "author_name" || field == "created_at"
}

func isTransferBlank(value any) bool {
	if value == nil {
		return true
	}
	s, ok := value.(string)
	return ok && strings.TrimSpace(s) == ""
}

func transferForeignPhoneOwner(index transferIndex, raw, id string) bool {
	p, err := normalizeContactProfilePhone(raw)
	if err != nil {
		return true
	}
	for _, owner := range index.phoneOwners[p] {
		if owner != id {
			return true
		}
	}
	return false
}

func transferCompatiblePrimaryExtra(target, incoming programtransfer.Record, base programtransfer.Baseline, index transferIndex) string {
	primary, err := normalizeContactProfilePhone(programtransfer.String(target.Fields, "phone"))
	if err != nil {
		return ""
	}
	other, err := normalizeContactProfilePhone(programtransfer.String(incoming.Fields, "phone"))
	if err != nil || primary == other || transferForeignPhoneOwner(index, other, target.ID) {
		return ""
	}
	localRevision, incomingRevision := base["phone"].Revision, incoming.Revisions["phone"]
	if localRevision.ID != incomingRevision.ID && programtransfer.Descends(localRevision, incomingRevision) {
		return ""
	}
	return other
}

func transferMergePhones(left, right any, primary, id string, owners map[string][]string) any {
	result := []any{}
	seen := map[string]bool{normalizeAliasValue("phone", primary): true}
	for i, collection := range []any{left, right} {
		entries, _ := collection.([]any)
		for _, item := range entries {
			phone, ok := item.(map[string]any)
			if !ok {
				continue
			}
			key, err := normalizeContactProfilePhone(programtransfer.String(phone, "phone"))
			if err != nil || seen[key] {
				continue
			}
			allowed := true
			if i > 0 {
				for _, owner := range owners[key] {
					if owner != id {
						allowed = false
					}
				}
			}
			if allowed {
				seen[key] = true
				result = append(result, phone)
			}
		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		return programtransfer.String(result[i].(map[string]any), "phone") < programtransfer.String(result[j].(map[string]any), "phone")
	})
	return result
}
