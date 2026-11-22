// Package programtransfer defines the bounded, versioned Programs exchange format.
// Portable IDs are never authorization credentials or destination row IDs.
package programtransfer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"github.com/google/uuid"
)

const (
	Version      = 1
	MaxFileBytes = 2 << 20
	MaxRecords   = 8000
	MaxAncestors = 48
	MaxAliases   = 24
	MaxConflicts = 500
)

var (
	ErrInvalid                = errors.New("invalid program transfer file or selection")
	ErrNotFound               = errors.New("program transfer target not found")
	ErrStale                  = errors.New("program transfer preview changed")
	ErrConflict               = errors.New("unresolved program transfer conflicts")
	ErrClosed                 = errors.New("program transfer destination is not active")
	ErrTooLarge               = errors.New("program transfer file exceeds limits")
	ErrContactLimit           = errors.New("program transfer would exceed contact limit")
	ErrSourceContactCollision = errors.New("source program has multiple contacts with the same phone")
)

type File struct {
	Version   int      `json:"version"`
	Records   []Record `json:"records"`
	Signature string   `json:"signature,omitempty"`
}

type Record struct {
	Kind      string              `json:"kind"`
	ID        string              `json:"id"`
	Fields    map[string]any      `json:"fields"`
	Aliases   []string            `json:"aliases,omitempty"`
	Revisions map[string]Revision `json:"revisions"`
}

type Revision struct {
	ID        string   `json:"id"`
	Ancestors []string `json:"ancestors,omitempty"`
}

// Baseline stores only the latest local fingerprint and opaque revision trail.
// Fingerprints are not included in an exchange file.
type Baseline map[string]FieldBaseline

type FieldBaseline struct {
	Fingerprint string   `json:"fingerprint"`
	Revision    Revision `json:"revision"`
}

type Request struct {
	File            File              `json:"file"`
	TargetProgramID string            `json:"target_program_id,omitempty"`
	Mappings        map[string]string `json:"mappings,omitempty"`
}

type ConfirmRequest struct {
	Request
	Token     string            `json:"token"`
	Decisions map[string]string `json:"decisions,omitempty"`
}

type Summary struct {
	Create    int `json:"create"`
	Update    int `json:"update"`
	Unchanged int `json:"unchanged"`
	Conflicts int `json:"conflicts"`
}

type Choice struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

type Conflict struct {
	Key        string   `json:"key"`
	Kind       string   `json:"kind"`
	Label      string   `json:"label"`
	Field      string   `json:"field,omitempty"`
	Local      any      `json:"local"`
	Incoming   any      `json:"incoming"`
	MappingKey string   `json:"mapping_key,omitempty"`
	Choices    []Choice `json:"choices,omitempty"`
}

type Preview struct {
	Token           string        `json:"token"`
	ProgramName     string        `json:"program_name"`
	TargetProgramID string        `json:"target_program_id,omitempty"`
	Summary         Summary       `json:"summary"`
	Conflicts       []Conflict    `json:"conflicts"`
	Items           []PreviewItem `json:"items,omitempty"`
	Digest          string        `json:"-"`
}

type PreviewItem struct {
	Action string `json:"action"`
	Kind   string `json:"kind"`
	Label  string `json:"label"`
}

type Result struct {
	ProgramID string  `json:"program_id"`
	Summary   Summary `json:"summary"`
}

// The order is also the restore dependency order (Contact first, then enrollment).
var Kinds = []string{"program", "contact", "course", "course_topic", "goal", "program_course", "instructor", "participant", "session", "session_topic", "attendance", "session_observation", "participant_note", "interaction"}

var fields = map[string]string{
	"program":             "name description status archived_from_status color schedule_start_date schedule_end_date schedule_days schedule_start_time schedule_end_time health_view_columns",
	"goal":                "attendance_goal_percent transfer_goal_percent",
	"contact":             "name phone email additional_phones",
	"course":              "name description status",
	"course_topic":        "course_id title description status position",
	"program_course":      "course_id position",
	"instructor":          "contact_id position",
	"participant":         "contact_id status enrolled_at dropped_at drop_reason drop_notes completed_at transferred_to_level transferred_at",
	"session":             "date title topic course_topic_id session_type start_time end_time location",
	"session_topic":       "session_id kind course_id course_topic_id course_name_snapshot topic_title_snapshot position",
	"attendance":          "session_id participant_id status notes",
	"session_observation": "session_id notes created_at author_name is_pinned pinned_at",
	"participant_note":    "participant_id session_id type note outcome follow_up_at created_at author_name",
	"interaction":         "participant_id session_id type direction outcome notes next_action next_action_date source_label created_at author_name is_pinned pinned_at",
}

var references = map[string]string{"course_id": "course", "course_topic_id": "course_topic", "contact_id": "contact", "session_id": "session", "participant_id": "participant"}

func ReferenceKind(field string) string { return references[field] }

func String(fields map[string]any, key string) string {
	value, _ := fields[key].(string)
	return value
}

func IsID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id != uuid.Nil && id.String() == value
}

func Fingerprint(value any) string {
	encoded, _ := json.Marshal(value)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func Extend(parents ...Revision) Revision {
	result := Revision{ID: uuid.NewString()}
	seen := map[string]bool{}
	add := func(id string) {
		if id != "" && !seen[id] && len(result.Ancestors) < MaxAncestors {
			seen[id] = true
			result.Ancestors = append(result.Ancestors, id)
		}
	}
	for _, parent := range parents {
		add(parent.ID)
	}
	// Round-robin prevents one history from pushing out the entire other branch.
	for i := 0; i < MaxAncestors && len(result.Ancestors) < MaxAncestors; i++ {
		for _, parent := range parents {
			if i < len(parent.Ancestors) {
				add(parent.Ancestors[i])
			}
		}
	}
	return result
}

func Current(r Record, saved Baseline) Baseline {
	current := make(Baseline, len(r.Fields))
	for field, value := range r.Fields {
		old := saved[field]
		hash := Fingerprint(value)
		if old.Revision.ID == "" || old.Fingerprint != hash {
			old = FieldBaseline{Fingerprint: hash, Revision: Extend(old.Revision)}
		}
		current[field] = old
	}
	return current
}

func BaselineOf(r Record) Baseline {
	base := make(Baseline, len(r.Fields))
	for field, value := range r.Fields {
		base[field] = FieldBaseline{Fingerprint: Fingerprint(value), Revision: r.Revisions[field]}
	}
	return base
}

func Descends(rev, ancestor Revision) bool {
	if ancestor.ID == "" {
		return false
	}
	if rev.ID == ancestor.ID {
		return true
	}
	for _, id := range rev.Ancestors {
		if id == ancestor.ID {
			return true
		}
	}
	return false
}

// MergeField decides from causal ancestry, never wall-clock timestamps. If the
// available history is insufficient, keep local and require an explicit choice.
func MergeField(local, incoming any, l, r Revision) (value any, revision Revision, conflict bool) {
	switch {
	case Fingerprint(local) == Fingerprint(incoming):
		if Descends(l, r) {
			return local, l, false
		}
		if Descends(r, l) {
			return local, r, false
		}
		return local, Extend(l, r), false
	case l.ID == r.ID: // IDs cannot stand in for conflicting payload values.
		return local, l, true
	case Descends(l, r):
		return local, l, false
	case Descends(r, l):
		return incoming, r, false
	default:
		return local, l, true
	}
}

func Sort(records []Record) {
	rank := map[string]int{}
	for i, kind := range Kinds {
		rank[kind] = i
	}
	sort.Slice(records, func(i, j int) bool {
		if records[i].Kind == records[j].Kind {
			return records[i].ID < records[j].ID
		}
		return rank[records[i].Kind] < rank[records[j].Kind]
	})
}

func ValidateFile(file File) error {
	if file.Version != Version || len(file.Records) == 0 {
		return ErrInvalid
	}
	if len(file.Records) > MaxRecords {
		return ErrTooLarge
	}
	encoded, err := json.Marshal(file)
	if err != nil {
		return ErrInvalid
	}
	if len(encoded) > MaxFileBytes {
		return ErrTooLarge
	}
	ids, identities := map[string]string{}, map[string]string{}
	programs := 0
	for _, r := range file.Records {
		allowed, ok := fields[r.Kind]
		if !ok || !IsID(r.ID) || ids[r.ID] != "" || len(r.Fields) != len(strings.Fields(allowed)) || len(r.Aliases) > MaxAliases || len(r.Fields) != len(r.Revisions) {
			return ErrInvalid
		}
		if r.Kind == "program" {
			programs++
		}
		ids[r.ID] = r.Kind
		for _, id := range append([]string{r.ID}, r.Aliases...) {
			key := r.Kind + ":" + id
			if !IsID(id) || identities[key] != "" {
				return ErrInvalid
			}
			identities[key] = r.ID
		}
		for field, value := range r.Fields {
			if !strings.Contains(" "+allowed+" ", " "+field+" ") || field == "" || !validValue(field, value) || !validRevision(r.Revisions[field]) {
				return ErrInvalid
			}
		}
		for _, field := range strings.Fields(allowed) {
			if _, ok := r.Fields[field]; !ok {
				return ErrInvalid
			}
		}
		if !validRecord(r) {
			return ErrInvalid
		}
	}
	if programs != 1 {
		return ErrInvalid
	}
	for _, r := range file.Records {
		for key, value := range r.Fields {
			if kind := ReferenceKind(key); kind != "" && value != nil && ids[String(r.Fields, key)] != kind {
				return ErrInvalid
			}
		}
	}
	return nil
}

func validRevision(r Revision) bool {
	if !IsID(r.ID) || len(r.Ancestors) > MaxAncestors {
		return false
	}
	seen := map[string]bool{r.ID: true}
	for _, id := range r.Ancestors {
		if !IsID(id) || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

func validValue(field string, value any) bool {
	if value == nil {
		return true
	}
	if ReferenceKind(field) != "" {
		id, ok := value.(string)
		return ok && IsID(id)
	}
	switch field {
	case "position", "attendance_goal_percent", "transfer_goal_percent":
		return validNumber(value, 1000000)
	case "is_pinned":
		_, ok := value.(bool)
		return ok
	case "schedule_days", "health_view_columns", "additional_phones":
		return validArray(field, value)
	default:
		s, ok := value.(string)
		return ok && len(s) <= 32768 && !strings.ContainsRune(s, 0)
	}
}

func validNumber(value any, max float64) bool {
	n, ok := value.(float64)
	if !ok {
		if x, yes := value.(json.Number); yes {
			var err error
			n, err = x.Float64()
			ok = err == nil
		}
	}
	return ok && n >= 0 && n <= max && n == float64(int(n))
}

func validArray(field string, value any) bool {
	items, ok := value.([]any)
	if !ok || len(items) > 64 {
		return false
	}
	for _, item := range items {
		switch field {
		case "schedule_days":
			if !validNumber(item, 6) {
				return false
			}
		case "health_view_columns":
			if s, ok := item.(string); !ok || len(s) > 80 {
				return false
			}
		case "additional_phones":
			entry, ok := item.(map[string]any)
			if !ok || String(entry, "phone") == "" || len(entry) > 2 {
				return false
			}
			for key, value := range entry {
				if key != "phone" && key != "label" {
					return false
				}
				if value != nil {
					if s, ok := value.(string); !ok || len(s) > 128 || strings.ContainsRune(s, 0) {
						return false
					}
				}
			}
		}
	}
	return true
}

func validRecord(r Record) bool {
	s := func(key string) string { return String(r.Fields, key) }
	oneOf := func(x string, values ...string) bool {
		for _, v := range values {
			if x == v {
				return true
			}
		}
		return false
	}
	switch r.Kind {
	case "program":
		return strings.TrimSpace(s("name")) != "" && oneOf(s("status"), "active", "completed", "archived")
	case "course":
		return strings.TrimSpace(s("name")) != "" && oneOf(s("status"), "active", "archived")
	case "course_topic":
		return s("course_id") != "" && strings.TrimSpace(s("title")) != ""
	case "program_course":
		return s("course_id") != ""
	case "instructor", "participant":
		return s("contact_id") != "" && (r.Kind != "participant" || (s("enrolled_at") != "" && oneOf(s("status"), "active", "completed", "dropped")))
	case "session":
		return s("date") != "" && oneOf(s("session_type"), "regular", "recovery")
	case "session_topic":
		return s("session_id") != "" && oneOf(s("kind"), "course", "free")
	case "attendance":
		return s("session_id") != "" && s("participant_id") != "" && oneOf(s("status"), "", "confirmed", "present", "absent", "late")
	case "session_observation":
		return s("session_id") != "" && strings.TrimSpace(s("notes")) != "" && s("created_at") != ""
	case "participant_note", "interaction":
		return s("participant_id") != "" && s("created_at") != ""
	}
	return true
}
