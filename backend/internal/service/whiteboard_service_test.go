package service

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/storage"
)

func TestWhiteboardSnapshotRoundTripIsPrivateAndDeterministic(t *testing.T) {
	t.Parallel()
	accountID, boardID, operationID := uuid.New(), uuid.New(), uuid.New()
	scene := json.RawMessage(`{"type":"excalidraw","elements":[{"id":"one","type":"rectangle","version":1,"versionNonce":2}],"appState":{},"files":{}}`)
	validatedScene, err := ValidateWhiteboardScene(scene)
	if err != nil {
		t.Fatal(err)
	}
	first, err := PrepareWhiteboardSnapshot(accountID, boardID, operationID, scene)
	if err != nil {
		t.Fatal(err)
	}
	second, err := PrepareWhiteboardSnapshot(accountID, boardID, operationID, scene)
	if err != nil {
		t.Fatal(err)
	}
	if first.ContentHash != second.ContentHash || string(first.CompressedBytes) != string(second.CompressedBytes) {
		t.Fatal("gzip snapshot is not deterministic")
	}
	if !storage.IsPrivateObjectKey(first.ObjectKey) || !strings.HasPrefix(first.ObjectKey, accountID.String()+"/_private/whiteboards/"+boardID.String()+"/revisions/") {
		t.Fatalf("snapshot escaped private account namespace: %s", first.ObjectKey)
	}
	restored, err := DecodeWhiteboardSnapshot(first.CompressedBytes, first.ContentHash)
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != string(validatedScene) {
		t.Fatalf("snapshot round trip changed scene: %s", restored)
	}
	if _, err := DecodeWhiteboardSnapshot(first.CompressedBytes, strings.Repeat("0", 64)); err == nil {
		t.Fatal("snapshot hash mismatch was accepted")
	}
}

func TestWhiteboardPayloadAndCursorValidation(t *testing.T) {
	t.Parallel()
	if _, err := ValidateWhiteboardScene(json.RawMessage(`[]`)); err == nil {
		t.Fatal("array scene was accepted")
	}
	if _, err := ValidateWhiteboardLibrary(json.RawMessage(`{"items":[]}`)); err == nil {
		t.Fatal("library without libraryItems was accepted")
	}
	name, err := NormalizeWhiteboardName("  Mapa   anual  ", 20)
	if err != nil || name != "Mapa anual" {
		t.Fatalf("unexpected name normalization: %q %v", name, err)
	}
	id := uuid.New()
	updatedAt := time.Date(2026, 8, 9, 12, 30, 0, 0, time.UTC)
	cursor := EncodeWhiteboardBoardCursor(updatedAt, id)
	decodedTime, decodedID, err := DecodeWhiteboardBoardCursor(cursor)
	if err != nil || decodedTime == nil || decodedID == nil || !decodedTime.Equal(updatedAt) || *decodedID != id {
		t.Fatalf("cursor did not round trip: %v %v %v", decodedTime, decodedID, err)
	}
	if _, _, err := DecodeWhiteboardBoardCursor("not-a-cursor"); err == nil {
		t.Fatal("invalid cursor was accepted")
	}
}

func TestValidateWhiteboardLibrarySanitizesElementsAndRejectsEgress(t *testing.T) {
	t.Parallel()
	valid := json.RawMessage(`{
		"type":"excalidrawlib","version":2,"future":{"keep":true},
		"libraryItems":[{"id":"item","elements":[{"id":"rect","type":"rectangle","version":1,"versionNonce":2,"link":"https://clarin.local/help","future":7}]}]
	}`)
	clean, err := ValidateWhiteboardLibrary(valid)
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(clean, &envelope) != nil || string(envelope["source"]) != `"clarin"` {
		t.Fatalf("library source was not localized: %s", clean)
	}
	if _, ok := envelope["future"]; !ok {
		t.Fatal("unknown library property was discarded")
	}
	for name, payload := range map[string]json.RawMessage{
		"embeddable":         json.RawMessage(`{"type":"excalidrawlib","libraryItems":[{"elements":[{"id":"e","type":"embeddable","version":1,"versionNonce":1,"link":"https://example.com"}]}]}`),
		"script link":        json.RawMessage(`{"type":"excalidrawlib","libraryItems":[[{"id":"e","type":"text","version":1,"versionNonce":1,"link":"javascript:alert(1)"}]]}`),
		"embedded file":      json.RawMessage(`{"type":"excalidrawlib","libraryItems":[],"files":{"f":{"dataURL":"data:image/png;base64,AA=="}}}`),
		"remote file source": json.RawMessage(`{"type":"excalidrawlib","libraryItems":[],"files":{"f":{"url":"https://example.invalid/image.png"}}}`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ValidateWhiteboardLibrary(payload); err == nil {
				t.Fatal("unsafe library was accepted")
			}
		})
	}
}

func TestValidateWhiteboardLibraryNormalizesOfficialLegacyFormat(t *testing.T) {
	t.Parallel()
	legacy := json.RawMessage(`{
		"type":"excalidrawlib","version":1,
		"library":[[{"id":"legacy-architecture-item","type":"rectangle","version":1,"versionNonce":2}]]
	}`)
	clean, err := ValidateWhiteboardLibrary(legacy)
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(clean, &envelope) != nil {
		t.Fatalf("normalized legacy library is not JSON: %s", clean)
	}
	if _, remains := envelope["library"]; remains {
		t.Fatal("legacy top-level library field was retained")
	}
	if string(envelope["version"]) != "2" {
		t.Fatalf("legacy library version was not normalized: %s", envelope["version"])
	}
	var items []json.RawMessage
	if json.Unmarshal(envelope["libraryItems"], &items) != nil || len(items) != 1 {
		t.Fatalf("legacy library items were not normalized: %s", envelope["libraryItems"])
	}
	if _, err := ValidateWhiteboardLibrary(json.RawMessage(`{
		"type":"excalidrawlib","library":[],"libraryItems":[]
	}`)); err == nil {
		t.Fatal("ambiguous legacy and current library fields were accepted")
	}
}

func TestStableWhiteboardIDIsAccountScopedAndRetryable(t *testing.T) {
	t.Parallel()
	accountA, accountB, operationID := uuid.New(), uuid.New(), uuid.New()
	first, err := StableWhiteboardID(accountA, operationID)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := StableWhiteboardID(accountA, operationID)
	if err != nil {
		t.Fatal(err)
	}
	otherAccount, err := StableWhiteboardID(accountB, operationID)
	if err != nil {
		t.Fatal(err)
	}
	if first != retry {
		t.Fatal("same create operation produced a second board ID")
	}
	if first == otherAccount {
		t.Fatal("create operation escaped its account namespace")
	}
	if _, err := StableWhiteboardID(uuid.Nil, operationID); err == nil {
		t.Fatal("nil account was accepted")
	}
}

func TestValidateWhiteboardSceneRejectsEgressAndStripsEphemeralState(t *testing.T) {
	t.Parallel()
	for name, scene := range map[string]json.RawMessage{
		"embedded binary": json.RawMessage(`{"type":"excalidraw","elements":[],"files":{"f":{"dataURL":"data:image/png;base64,AA=="}}}`),
		"remote image":    json.RawMessage(`{"type":"excalidraw","elements":[],"files":{"f":{"url":"https://example.com/a.png"}}}`),
		"legacy iframe":   json.RawMessage(`{"type":"excalidraw","elements":[{"id":"e","type":"iframe","version":1,"versionNonce":1,"customData":{"generationData":{"html":"<script>alert(1)</script>"}}}],"files":{}}`),
		"script link":     json.RawMessage(`{"type":"excalidraw","elements":[{"id":"e","type":"text","version":1,"versionNonce":1,"link":"javascript:alert(1)"}],"files":{}}`),
		"nested URL":      json.RawMessage(`{"type":"excalidraw","elements":[],"files":{"f":{"future":{"preview":"https://example.com/a.png"}}}}`),
		"nested bytes":    json.RawMessage(`{"type":"excalidraw","elements":[],"files":{"f":{"future":{"encoded_bytes":[1,2,3]}}}}`),
		"invalid file ID": json.RawMessage(`{"type":"excalidraw","elements":[],"files":{"../../outside":{"id":"../../outside","mimeType":"image/png"}}}`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ValidateWhiteboardScene(scene); err == nil {
				t.Fatal("unsafe scene was accepted")
			}
		})
	}

	validated, err := ValidateWhiteboardScene(json.RawMessage(`{
		"type":"excalidraw","futureRoot":{"keep":true},
		"elements":[{"id":"e","type":"text","version":1,"versionNonce":1,"link":"mailto:help@example.com","future":7}],
		"appState":{"viewBackgroundColor":"#fff","scrollX":900,"collaborators":{"x":{}}},"files":{}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(validated, &document); err != nil {
		t.Fatal(err)
	}
	if _, ok := document["futureRoot"]; !ok {
		t.Fatal("unknown root property was discarded")
	}
	var appState map[string]json.RawMessage
	if err := json.Unmarshal(document["appState"], &appState); err != nil {
		t.Fatal(err)
	}
	if _, ok := appState["scrollX"]; ok {
		t.Fatal("ephemeral viewport state was persisted")
	}
	if _, ok := appState["collaborators"]; ok {
		t.Fatal("ephemeral collaborator state was persisted")
	}
	if _, ok := appState["viewBackgroundColor"]; !ok {
		t.Fatal("document background state was discarded")
	}

	inertEmbed, err := ValidateWhiteboardScene(json.RawMessage(`{
		"type":"excalidraw","elements":[{
			"id":"legacy-embed","type":"embeddable","version":1,"versionNonce":1,
			"link":"https://example.com/explicit-only","customData":{"future":{"keep":true}}
		}],"appState":{},"files":{}
	}`))
	if err != nil {
		t.Fatalf("inert legacy embed was not preserved: %v", err)
	}
	if !strings.Contains(string(inertEmbed), `"type":"embeddable"`) ||
		!strings.Contains(string(inertEmbed), `"keep":true`) {
		t.Fatalf("inert legacy embed lost forward-compatible data: %s", inertEmbed)
	}
	if _, err := ValidateWhiteboardScene(json.RawMessage(`{
		"type":"excalidraw","elements":[{
			"id":"bad-embed","type":"embeddable","version":1,"versionNonce":1,
			"link":"javascript:alert(1)"
		}],"appState":{},"files":{}
	}`)); err == nil {
		t.Fatal("inert embed accepted an unsafe link")
	}

	metadataScene, err := ValidateWhiteboardScene(json.RawMessage(`{
		"type":"excalidraw","elements":[],"appState":{},
		"files":{"f":{"id":"f","mimeType":"image/png","created":123,"future":{"colorProfile":"p3"}}}
	}`))
	if err != nil || !strings.Contains(string(metadataScene), `"colorProfile":"p3"`) {
		t.Fatalf("safe forward-compatible file metadata was not preserved: %s (%v)", metadataScene, err)
	}
}

func clarinRichTextElement(id, text string, runs []clarinTextFormatRun) map[string]any {
	return map[string]any{
		"id": id, "type": "text", "version": 1, "versionNonce": 1,
		"text": text, "originalText": text, "textAlign": "left",
		"customData": map[string]any{
			clarinTextFormatCustomDataProperty: clarinTextFormat{
				Version: clarinTextFormatVersion, TextLength: clarinUTF16Length(text),
				TextHash: clarinTextHash(text), Runs: runs,
			},
		},
	}
}

func addClarinParagraphFormat(element map[string]any, paragraphs []clarinParagraphFormatEntry) {
	text := element["originalText"].(string)
	customData, exists := element["customData"].(map[string]any)
	if !exists {
		customData = map[string]any{}
		element["customData"] = customData
	}
	customData[clarinParagraphFormatCustomDataProperty] = clarinParagraphFormat{
		Version: clarinParagraphFormatVersion, TextLength: clarinUTF16Length(text),
		TextHash: clarinTextHash(text), Paragraphs: paragraphs,
	}
}

func clarinParagraphTextElement(id, text, baseAlign string, paragraphs []clarinParagraphFormatEntry) map[string]any {
	element := map[string]any{
		"id": id, "type": "text", "version": 1, "versionNonce": 1,
		"text": text, "originalText": text, "textAlign": baseAlign,
	}
	addClarinParagraphFormat(element, paragraphs)
	return element
}

func validateClarinRichTextElements(elements []map[string]any) error {
	payload, err := json.Marshal(map[string]any{
		"type": "excalidraw", "version": 2, "elements": elements,
		"appState": map[string]any{}, "files": map[string]any{},
	})
	if err != nil {
		return err
	}
	_, err = ValidateWhiteboardScene(payload)
	return err
}

func TestValidateWhiteboardSceneAcceptsCanonicalClarinRichText(t *testing.T) {
	t.Parallel()
	text := "Título\nCuerpo 👩🏽‍💻\n"
	element := clarinRichTextElement("rich-text", text, []clarinTextFormatRun{
		{From: 0, To: 6, Marks: 1 | 4},
		{From: 7, To: 13, Marks: 2 | 8},
	})
	addClarinParagraphFormat(element, []clarinParagraphFormatEntry{
		{Start: 0, Align: "center"},
		{Start: 7, Align: "right"},
		{Start: clarinUTF16Length(text), Align: "center"},
	})
	if err := validateClarinRichTextElements([]map[string]any{element}); err != nil {
		t.Fatalf("canonical rich text was rejected: %v", err)
	}
}

func TestValidateWhiteboardSceneAcceptsCanonicalClarinParagraphAlignment(t *testing.T) {
	t.Parallel()
	for name, element := range map[string]map[string]any{
		"UTF-16 paragraph start": clarinParagraphTextElement(
			"emoji-paragraph", "😀\nCuerpo", "left",
			[]clarinParagraphFormatEntry{{Start: 3, Align: "center"}},
		),
		"empty trailing paragraph": clarinParagraphTextElement(
			"trailing-paragraph", "Título\n", "left",
			[]clarinParagraphFormatEntry{{Start: 7, Align: "right"}},
		),
		"empty text paragraph": clarinParagraphTextElement(
			"empty-paragraph", "", "right",
			[]clarinParagraphFormatEntry{{Start: 0, Align: "center"}},
		),
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateClarinRichTextElements([]map[string]any{element}); err != nil {
				t.Fatalf("canonical paragraph alignment was rejected: %v", err)
			}
		})
	}
}

func TestValidateWhiteboardSceneRejectsInvalidClarinRichText(t *testing.T) {
	t.Parallel()
	for name, mutate := range map[string]func(map[string]any){
		"stale hash": func(element map[string]any) {
			format := element["customData"].(map[string]any)[clarinTextFormatCustomDataProperty].(clarinTextFormat)
			format.TextHash++
			element["customData"].(map[string]any)[clarinTextFormatCustomDataProperty] = format
		},
		"stale UTF-16 length": func(element map[string]any) {
			format := element["customData"].(map[string]any)[clarinTextFormatCustomDataProperty].(clarinTextFormat)
			format.TextLength--
			element["customData"].(map[string]any)[clarinTextFormatCustomDataProperty] = format
		},
		"unknown mark": func(element map[string]any) {
			format := element["customData"].(map[string]any)[clarinTextFormatCustomDataProperty].(clarinTextFormat)
			format.Runs[0].Marks = 16
			element["customData"].(map[string]any)[clarinTextFormatCustomDataProperty] = format
		},
		"overlap": func(element map[string]any) {
			format := element["customData"].(map[string]any)[clarinTextFormatCustomDataProperty].(clarinTextFormat)
			format.Runs = []clarinTextFormatRun{{From: 0, To: 2, Marks: 1}, {From: 1, To: 3, Marks: 2}}
			element["customData"].(map[string]any)[clarinTextFormatCustomDataProperty] = format
		},
		"unmerged neighbours": func(element map[string]any) {
			format := element["customData"].(map[string]any)[clarinTextFormatCustomDataProperty].(clarinTextFormat)
			format.Runs = []clarinTextFormatRun{{From: 0, To: 1, Marks: 1}, {From: 1, To: 2, Marks: 1}}
			element["customData"].(map[string]any)[clarinTextFormatCustomDataProperty] = format
		},
	} {
		t.Run(name, func(t *testing.T) {
			element := clarinRichTextElement("invalid-rich-text", "Texto", []clarinTextFormatRun{{From: 0, To: 1, Marks: 1}})
			mutate(element)
			if err := validateClarinRichTextElements([]map[string]any{element}); err == nil {
				t.Fatal("invalid rich-text payload was accepted")
			}
		})
	}
}

func TestValidateWhiteboardSceneRejectsClarinRunsInsideGraphemes(t *testing.T) {
	t.Parallel()
	for name, element := range map[string]map[string]any{
		"surrogate pair":     clarinRichTextElement("emoji", "😀", []clarinTextFormatRun{{From: 0, To: 1, Marks: 1}}),
		"combining sequence": clarinRichTextElement("combining", "e\u0301", []clarinTextFormatRun{{From: 0, To: 1, Marks: 1}}),
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateClarinRichTextElements([]map[string]any{element}); err == nil {
				t.Fatal("a run split a grapheme boundary")
			}
		})
	}
}

func TestValidateWhiteboardSceneRejectsInvalidClarinParagraphAlignment(t *testing.T) {
	t.Parallel()
	baseElement := func() map[string]any {
		return clarinParagraphTextElement(
			"invalid-paragraph", "Uno\nDos", "left",
			[]clarinParagraphFormatEntry{{Start: 4, Align: "center"}},
		)
	}
	for name, mutate := range map[string]func(map[string]any){
		"stale hash": func(element map[string]any) {
			format := element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty].(clarinParagraphFormat)
			format.TextHash++
			element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty] = format
		},
		"stale UTF-16 length": func(element map[string]any) {
			format := element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty].(clarinParagraphFormat)
			format.TextLength--
			element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty] = format
		},
		"unknown version": func(element map[string]any) {
			format := element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty].(clarinParagraphFormat)
			format.Version++
			element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty] = format
		},
		"null paragraphs": func(element map[string]any) {
			format := element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty].(clarinParagraphFormat)
			format.Paragraphs = nil
			element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty] = format
		},
		"invalid alignment": func(element map[string]any) {
			format := element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty].(clarinParagraphFormat)
			format.Paragraphs[0].Align = "justify"
			element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty] = format
		},
		"redundant base alignment": func(element map[string]any) {
			format := element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty].(clarinParagraphFormat)
			format.Paragraphs[0].Align = "left"
			element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty] = format
		},
		"not a paragraph start": func(element map[string]any) {
			format := element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty].(clarinParagraphFormat)
			format.Paragraphs[0].Start = 3
			element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty] = format
		},
		"text end is not an empty paragraph": func(element map[string]any) {
			format := element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty].(clarinParagraphFormat)
			format.Paragraphs[0].Start = clarinUTF16Length(element["originalText"].(string))
			element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty] = format
		},
		"duplicate start": func(element map[string]any) {
			format := element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty].(clarinParagraphFormat)
			format.Paragraphs = []clarinParagraphFormatEntry{{Start: 0, Align: "right"}, {Start: 0, Align: "center"}}
			element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty] = format
		},
		"unsorted starts": func(element map[string]any) {
			format := element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty].(clarinParagraphFormat)
			format.Paragraphs = []clarinParagraphFormatEntry{{Start: 4, Align: "right"}, {Start: 0, Align: "center"}}
			element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty] = format
		},
		"missing base alignment": func(element map[string]any) {
			delete(element, "textAlign")
		},
		"unknown top-level field": func(element map[string]any) {
			text := element["originalText"].(string)
			element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty] = map[string]any{
				"version": 1, "textLength": clarinUTF16Length(text), "textHash": clarinTextHash(text),
				"paragraphs": []map[string]any{{"start": 4, "align": "center"}}, "future": true,
			}
		},
		"unknown paragraph field": func(element map[string]any) {
			text := element["originalText"].(string)
			element["customData"].(map[string]any)[clarinParagraphFormatCustomDataProperty] = map[string]any{
				"version": 1, "textLength": clarinUTF16Length(text), "textHash": clarinTextHash(text),
				"paragraphs": []map[string]any{{"start": 4, "align": "center", "future": true}},
			}
		},
	} {
		t.Run(name, func(t *testing.T) {
			element := baseElement()
			mutate(element)
			if err := validateClarinRichTextElements([]map[string]any{element}); err == nil {
				t.Fatal("invalid paragraph-alignment payload was accepted")
			}
		})
	}
}

func TestValidateWhiteboardSceneRejectsClarinTextMetadataOnNonTextElements(t *testing.T) {
	t.Parallel()
	for _, property := range []string{
		clarinTextFormatCustomDataProperty,
		clarinParagraphFormatCustomDataProperty,
	} {
		element := map[string]any{
			"id": "not-text-" + property, "type": "rectangle", "version": 1, "versionNonce": 1,
			"customData": map[string]any{property: map[string]any{}},
		}
		if err := validateClarinRichTextElements([]map[string]any{element}); err == nil {
			t.Fatalf("%s was accepted on a non-text element", property)
		}
	}
}

func TestValidateWhiteboardSceneEnforcesClarinRunLimits(t *testing.T) {
	t.Parallel()
	makeRuns := func(count int) (string, []clarinTextFormatRun) {
		text := strings.Repeat("a", count)
		runs := make([]clarinTextFormatRun, count)
		for index := range runs {
			runs[index] = clarinTextFormatRun{From: index, To: index + 1, Marks: 1 + index%2}
		}
		return text, runs
	}
	text, maxRuns := makeRuns(MaxClarinTextRunsPerElement)
	if err := validateClarinRichTextElements([]map[string]any{clarinRichTextElement("max-runs", text, maxRuns)}); err != nil {
		t.Fatalf("per-element run limit was rejected at its boundary: %v", err)
	}
	text, tooMany := makeRuns(MaxClarinTextRunsPerElement + 1)
	if err := validateClarinRichTextElements([]map[string]any{clarinRichTextElement("too-many", text, tooMany)}); err == nil {
		t.Fatal("per-element rich-text run limit was not enforced")
	}

	makeParagraphs := func(count int) (string, []clarinParagraphFormatEntry) {
		text := strings.Repeat("\n", count-1)
		paragraphs := make([]clarinParagraphFormatEntry, count)
		for index := range paragraphs {
			paragraphs[index] = clarinParagraphFormatEntry{Start: index, Align: []string{"center", "right"}[index%2]}
		}
		return text, paragraphs
	}
	paragraphText, maxParagraphs := makeParagraphs(MaxClarinParagraphsPerElement)
	if err := validateClarinRichTextElements([]map[string]any{
		clarinParagraphTextElement("max-paragraphs", paragraphText, "left", maxParagraphs),
	}); err != nil {
		t.Fatalf("per-element paragraph limit was rejected at its boundary: %v", err)
	}
	paragraphText, tooManyParagraphs := makeParagraphs(MaxClarinParagraphsPerElement + 1)
	if err := validateClarinRichTextElements([]map[string]any{
		clarinParagraphTextElement("too-many-paragraphs", paragraphText, "left", tooManyParagraphs),
	}); err == nil {
		t.Fatal("per-element paragraph-alignment limit was not enforced")
	}

	elements := make([]map[string]any, 0, 13)
	text, runs := makeRuns(4_000)
	for index := 0; index < 6; index++ {
		elements = append(elements, clarinRichTextElement(fmt.Sprintf("scene-runs-%d", index), text, runs))
	}
	paragraphText, paragraphs := makeParagraphs(4_000)
	for index := 0; index < 6; index++ {
		elements = append(elements, clarinParagraphTextElement(
			fmt.Sprintf("scene-paragraphs-%d", index), paragraphText, "left", paragraphs,
		))
	}
	paragraphText, paragraphs = makeParagraphs(2_000)
	elements = append(elements, clarinParagraphTextElement("scene-limit", paragraphText, "left", paragraphs))
	if err := validateClarinRichTextElements(elements); err != nil {
		t.Fatalf("combined scene limit was rejected at exactly %d segments: %v", MaxClarinTextSegmentsPerScene, err)
	}
	paragraphText, paragraphs = makeParagraphs(2_001)
	elements[len(elements)-1] = clarinParagraphTextElement("scene-over-limit", paragraphText, "left", paragraphs)
	if err := validateClarinRichTextElements(elements); err == nil {
		t.Fatal("combined scene rich-text and paragraph limit was not enforced")
	}
}
