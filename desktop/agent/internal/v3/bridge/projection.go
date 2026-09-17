package bridge

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

func projectTaskList(selectionID string, payload json.RawMessage) (json.RawMessage, error) {
	var closure struct {
		List     json.RawMessage   `json:"list"`
		Statuses []json.RawMessage `json:"statuses"`
		Tasks    []json.RawMessage `json:"tasks"`
	}
	if strictJSON(payload, &closure) != nil || len(closure.List) == 0 {
		return nil, errors.New("local task-list projection rejected")
	}
	return mergeObject(closure.List, map[string]any{"selection_id": selectionID, "statuses": closure.Statuses})
}

func projectClosure(module string, payload json.RawMessage) (json.RawMessage, error) {
	switch module {
	case "contacts":
		var closure struct {
			Contact            json.RawMessage   `json:"contact"`
			Phones             []json.RawMessage `json:"phones"`
			Tags               []json.RawMessage `json:"tags"`
			DirectObservations []json.RawMessage `json:"direct_observations"`
			CustomFields       []json.RawMessage `json:"custom_fields"`
		}
		if strictJSON(payload, &closure) != nil {
			return nil, errors.New("local contact projection rejected")
		}
		return mergeObject(closure.Contact, map[string]any{"phones": closure.Phones, "tags": closure.Tags,
			"direct_observations": closure.DirectObservations, "custom_fields": closure.CustomFields})
	case "programs":
		closure, err := decodeProgramClosure(payload)
		if err != nil {
			return nil, err
		}
		return mergeObject(closure.Program, map[string]any{"participant_count": len(closure.ActiveRoster), "session_count": len(closure.Sessions)})
	case "whiteboards":
		var closure struct {
			Whiteboard       json.RawMessage   `json:"whiteboard"`
			ReferencedAssets []json.RawMessage `json:"referenced_assets"`
		}
		if strictJSON(payload, &closure) != nil {
			return nil, errors.New("local whiteboard projection rejected")
		}
		var board map[string]any
		if json.Unmarshal(closure.Whiteboard, &board) != nil {
			return nil, errors.New("local whiteboard projection rejected")
		}
		delete(board, "scene")
		board["asset_count"] = len(closure.ReferencedAssets)
		return json.Marshal(board)
	default:
		return nil, errors.New("local module projection rejected")
	}
}

type programClosure struct {
	Program                  json.RawMessage   `json:"program"`
	ActiveRoster             []json.RawMessage `json:"active_roster"`
	HistoricalParticipations []json.RawMessage `json:"historical_participations"`
	Sessions                 []json.RawMessage `json:"sessions"`
	EligibleAttendance       []json.RawMessage `json:"eligible_attendance"`
	OutOfWindowHistory       []json.RawMessage `json:"out_of_window_history"`
}

func decodeProgramClosure(payload json.RawMessage) (*programClosure, error) {
	var closure programClosure
	if strictJSON(payload, &closure) != nil {
		return nil, errors.New("local program projection rejected")
	}
	return &closure, nil
}

func (s *Server) contactDetail(w http.ResponseWriter, r *http.Request, requestID, id string) {
	if !canonicalUUID(id) || strings.Contains(id, "/") {
		s.writeError(w, http.StatusNotFound, "resource_not_available", "", requestID, 0)
		return
	}
	access, profile, ok := s.sessionProof(w, r, requestID)
	if !ok {
		return
	}
	defer access.Release()
	resource, err := s.engine.Resource(r.Context(), access, "contacts", "contact", id)
	if err != nil {
		s.respond(w, nil, err, 0, requestID, profile.Epoch)
		return
	}
	item, err := projectClosure("contacts", resource.Payload)
	s.respond(w, map[string]any{"item": item, "snapshot": map[string]any{"selection_revision": access.Lease.Selection, "head_version": resource.Revision}}, err, http.StatusOK, requestID, profile.Epoch)
}

func (s *Server) programDetail(w http.ResponseWriter, r *http.Request, requestID, suffix string) {
	parts := strings.Split(suffix, "/")
	if len(parts) < 1 || len(parts) > 2 || !canonicalUUID(parts[0]) {
		s.writeError(w, http.StatusNotFound, "resource_not_available", "", requestID, 0)
		return
	}
	access, profile, ok := s.sessionProof(w, r, requestID)
	if !ok {
		return
	}
	defer access.Release()
	resource, err := s.engine.Resource(r.Context(), access, "programs", "program", parts[0])
	if err != nil {
		s.respond(w, nil, err, 0, requestID, profile.Epoch)
		return
	}
	closure, err := decodeProgramClosure(resource.Payload)
	if err != nil {
		s.respond(w, nil, err, 0, requestID, profile.Epoch)
		return
	}
	snapshot := map[string]any{"selection_revision": access.Lease.Selection, "head_version": resource.Revision}
	if len(parts) == 1 {
		item, mergeErr := mergeObject(closure.Program, map[string]any{
			"active_roster": closure.ActiveRoster, "historical_participations": closure.HistoricalParticipations,
			"sessions": closure.Sessions, "eligible_attendance": closure.EligibleAttendance, "out_of_window_history": closure.OutOfWindowHistory,
			"participant_count": len(closure.ActiveRoster), "session_count": len(closure.Sessions),
		})
		s.respond(w, map[string]any{"item": item, "snapshot": snapshot}, mergeErr, http.StatusOK, requestID, profile.Epoch)
		return
	}
	var items []json.RawMessage
	switch parts[1] {
	case "participants":
		items = append(items, closure.ActiveRoster...)
		items = append(items, closure.HistoricalParticipations...)
	case "sessions":
		items = closure.Sessions
	case "attendance":
		items = append(items, closure.EligibleAttendance...)
		items = append(items, closure.OutOfWindowHistory...)
	default:
		s.writeError(w, http.StatusNotFound, "resource_not_available", "", requestID, profile.Epoch)
		return
	}
	s.writeJSONWithEpoch(w, http.StatusOK, map[string]any{"items": items, "next_cursor": "", "snapshot": snapshot}, profile.Epoch)
}

func (s *Server) whiteboardDetail(w http.ResponseWriter, r *http.Request, requestID, suffix string) {
	parts := strings.Split(suffix, "/")
	if len(parts) != 2 || !canonicalUUID(parts[0]) || parts[1] != "scene" {
		s.writeError(w, http.StatusNotFound, "resource_not_available", "", requestID, 0)
		return
	}
	access, profile, ok := s.sessionProof(w, r, requestID)
	if !ok {
		return
	}
	defer access.Release()
	resource, err := s.engine.Resource(r.Context(), access, "whiteboards", "whiteboard", parts[0])
	if err != nil {
		s.respond(w, nil, err, 0, requestID, profile.Epoch)
		return
	}
	var closure struct {
		Whiteboard       json.RawMessage   `json:"whiteboard"`
		ReferencedAssets []json.RawMessage `json:"referenced_assets"`
	}
	if strictJSON(resource.Payload, &closure) != nil {
		s.respond(w, nil, errors.New("local whiteboard projection rejected"), 0, requestID, profile.Epoch)
		return
	}
	item, err := mergeObject(closure.Whiteboard, map[string]any{"assets": closure.ReferencedAssets})
	s.respond(w, map[string]any{"item": item, "snapshot": map[string]any{"selection_revision": access.Lease.Selection, "head_version": resource.Revision}}, err, http.StatusOK, requestID, profile.Epoch)
}

func mergeObject(base json.RawMessage, extras map[string]any) (json.RawMessage, error) {
	var value map[string]any
	if json.Unmarshal(base, &value) != nil || value == nil {
		return nil, errors.New("local projection object rejected")
	}
	for key, item := range extras {
		value[key] = item
	}
	return json.Marshal(value)
}

func strictJSON(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}
