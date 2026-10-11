package api

// Resource ACL acceptance uses the real cleanup handlers, PostgreSQL and MinIO.
// It deliberately checks canonical domain rows and bytes rather than treating
// a recovery snapshot or successful HTTP status as proof of preservation.
import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

type storagePrivateQATask struct {
	environment, task, attachment, comment, annotation uuid.UUID
	key                                                string
}

func storagePrivateQASeedTask(f *storageMultiOriginQAFixture) storagePrivateQATask {
	f.t.Helper()
	item := storagePrivateQATask{environment: uuid.New(), task: uuid.New(), attachment: uuid.New(), comment: uuid.New(), annotation: uuid.New()}
	workflow, status, list := uuid.New(), uuid.New(), uuid.New()
	f.exec(`INSERT INTO task_environments(id,account_id,name,visibility,default_access_level,created_by)
		VALUES($1,$2,'Private media QA environment','account','view',$3)`, item.environment, f.account, f.secondUser)
	f.exec(`INSERT INTO task_workflows(id,account_id,environment_id,name,created_by)
		VALUES($1,$2,$3,'Private media QA workflow',$4)`, workflow, f.account, item.environment, f.secondUser)
	f.exec(`INSERT INTO task_statuses(id,account_id,workflow_id,name,category,is_default)
		VALUES($1,$2,$3,'Pending','not_started',TRUE)`, status, f.account, workflow)
	f.exec(`INSERT INTO task_lists(id,account_id,environment_id,workflow_id,name,created_by)
		VALUES($1,$2,$3,$4,'Private media QA list',$5)`, list, f.account, item.environment, workflow, f.secondUser)
	f.exec(`INSERT INTO tasks(id,account_id,created_by,assigned_to,title,type,priority,status,status_id,list_id,access_mode,version)
		VALUES($1,$2,$3,$3,'Preserve task title','reminder','medium','pending',$4,$5,'private',7)`, item.task, f.account, f.secondUser, status, list)
	f.exec(`INSERT INTO task_access_grants(account_id,task_id,user_id,access_level,created_by)
		VALUES($1,$2,$3,'edit',$4)`, f.account, item.task, f.user, f.secondUser)
	var asset uuid.UUID
	item.key, asset, _ = f.media(f.account, "_private/tasks/"+item.task.String(), "annotated.pdf", false)
	f.exec(`INSERT INTO task_attachments(id,account_id,task_id,media_asset_id,uploaded_by,attachment_scope)
		VALUES($1,$2,$3,$4,$5,'comment')`, item.attachment, f.account, item.task, asset, f.secondUser)
	f.exec(`INSERT INTO task_comments(id,account_id,task_id,author_id,body)
		VALUES($1,$2,$3,$4,'Preserve original task comment')`, item.comment, f.account, item.task, f.secondUser)
	f.exec(`INSERT INTO task_comment_attachments(account_id,task_id,comment_id,attachment_id)
		VALUES($1,$2,$3,$4)`, f.account, item.task, item.comment, item.attachment)
	f.exec(`INSERT INTO task_attachment_comments(id,account_id,task_id,attachment_id,author_id,body,anchor,version)
		VALUES($1,$2,$3,$4,$5,'Preserve anchored comment','{"page":1,"x":0.25,"y":0.5}'::jsonb,3)`, item.annotation, f.account, item.task, item.attachment, f.secondUser)
	return item
}

func storagePrivateQAExpectTask(f *storageMultiOriginQAFixture, item storagePrivateQATask, removed bool, version int64, title string) {
	f.t.Helper()
	var gotRemoved, anchorPreserved bool
	var gotVersion, annotationVersion int64
	var gotTitle, comment, annotation string
	var links int
	err := f.db.QueryRow(context.Background(), `SELECT attachment.storage_removed_at IS NOT NULL,task.version,task.title,
		comment.body,annotation.body,annotation.version,annotation.anchor='{"page":1,"x":0.25,"y":0.5}'::jsonb,
		(SELECT COUNT(*) FROM task_comment_attachments WHERE account_id=$1 AND task_id=$2 AND comment_id=$4 AND attachment_id=$3)
		FROM task_attachments attachment
		JOIN tasks task ON task.account_id=attachment.account_id AND task.id=attachment.task_id
		JOIN task_comments comment ON comment.account_id=task.account_id AND comment.task_id=task.id AND comment.id=$4
		JOIN task_attachment_comments annotation ON annotation.account_id=task.account_id AND annotation.task_id=task.id AND annotation.attachment_id=attachment.id AND annotation.id=$5
		WHERE attachment.account_id=$1 AND attachment.task_id=$2 AND attachment.id=$3`, f.account, item.task, item.attachment, item.comment, item.annotation).
		Scan(&gotRemoved, &gotVersion, &gotTitle, &comment, &annotation, &annotationVersion, &anchorPreserved, &links)
	if err != nil {
		f.t.Fatal(err)
	}
	if gotRemoved != removed || gotVersion != version || gotTitle != title || comment != "Preserve original task comment" || annotation != "Preserve anchored comment" || annotationVersion != 3 || !anchorPreserved || links != 1 {
		f.t.Fatalf("task recovery changed unrelated state: removed=%v version=%d title=%q comment=%q annotation=%q annotation_version=%d links=%d", gotRemoved, gotVersion, gotTitle, comment, annotation, annotationVersion, links)
	}
}

func storagePrivateQAExpectDenied(t *testing.T, status int, data map[string]any) {
	t.Helper()
	if status < 400 || status >= 500 {
		t.Fatalf("expected an authorization/conflict rejection, status=%d response=%v", status, data)
	}
}

func storagePrivateQARecoveryPreview(f *storageMultiOriginQAFixture, id string) map[string]any {
	f.t.Helper()
	status, data := f.request("POST", "/storage/cleanup/preview", map[string]any{"action": "restore", "recovery_ids": []string{id}}, nil)
	if status != 200 || data["preview_id"] == nil {
		f.t.Fatalf("restore preview status=%d response=%v", status, data)
	}
	return data
}

type storagePrivateQABoard struct {
	board, asset, link, revision uuid.UUID
	key, snapshotKey             string
	scene                        json.RawMessage
}

func storagePrivateQASeedBoard(f *storageMultiOriginQAFixture) storagePrivateQABoard {
	f.t.Helper()
	item := storagePrivateQABoard{board: uuid.New(), asset: uuid.New(), link: uuid.New(), revision: uuid.New()}
	item.scene = json.RawMessage(`{"type":"excalidraw","version":2,"source":"clarin","elements":[
		{"id":"image-a","type":"image","fileId":"qa-image","index":"a0","version":1,"versionNonce":11,"isDeleted":false,"x":0,"y":0,"width":32,"height":32,"customData":{"keep":"first"}},
		{"id":"image-b","type":"image","fileId":"qa-image","index":"a1","version":1,"versionNonce":12,"isDeleted":false,"x":64,"y":0,"width":32,"height":32,"customData":{"keep":"second"}},
		{"id":"unrelated","type":"rectangle","index":"a2","version":4,"versionNonce":13,"isDeleted":false,"x":100,"y":100,"width":80,"height":40,"customData":{"keep":"opaque"}}
	],"appState":{"viewBackgroundColor":"#ffffff"},"files":{},"customEnvelope":{"keep":"root"}}`)
	f.exec(`INSERT INTO subscriptions(account_id,plan_code,status,current_period_start,current_period_end)
		VALUES($1,'enterprise','active',NOW(),NOW()+INTERVAL '1 year') ON CONFLICT(account_id) DO UPDATE SET status='active',current_period_end=EXCLUDED.current_period_end`, f.account)
	f.exec(`INSERT INTO whiteboards(id,account_id,name,scene_json,scene_sequence,scene_schema_version,editor_version,access_mode,created_by,updated_by)
		VALUES($1,$2,'Private image QA board',$3::jsonb,0,'excalidraw','0.18.1-clarin.7','private',$4,$4)`, item.board, f.account, item.scene, f.secondUser)
	f.exec(`INSERT INTO whiteboard_grants(account_id,board_id,user_id,access_level,created_by)
		VALUES($1,$2,$3,'edit',$4)`, f.account, item.board, f.user, f.secondUser)
	imageBytes, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=")
	if err != nil {
		f.t.Fatal(err)
	}
	item.key = f.account.String() + "/_private/whiteboards/" + item.board.String() + "/images/qa.png"
	if _, err := f.store.UploadObject(context.Background(), item.key, imageBytes, "image/png"); err != nil {
		f.t.Fatal(err)
	}
	f.exec(`INSERT INTO media_assets(id,account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status)
		VALUES($1,$2,$3,$4,'image','image/png','qa.png',$5,'active')`, item.asset, f.account, "sha256:whiteboard:"+item.asset.String(), item.key, len(imageBytes))
	f.exec(`INSERT INTO storage_objects(account_id,object_key,media_type,content_type,filename,size_bytes,source,status)
		VALUES($1,$2,'image','image/png','qa.png',$3,'whiteboard_asset','active')`, f.account, item.key, len(imageBytes))
	f.exec(`INSERT INTO whiteboard_assets(id,account_id,board_id,media_asset_id,file_id,kind,uploaded_by,committed_at)
		VALUES($1,$2,$3,$4,'qa-image','asset',$5,NOW())`, item.link, f.account, item.board, item.asset, f.secondUser)
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(item.scene); err != nil {
		f.t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		f.t.Fatal(err)
	}
	item.snapshotKey = f.account.String() + "/_private/whiteboards/" + item.board.String() + "/revisions/" + item.revision.String() + ".json.gz"
	if _, err := f.store.UploadObject(context.Background(), item.snapshotKey, compressed.Bytes(), "application/gzip"); err != nil {
		f.t.Fatal(err)
	}
	f.exec(`INSERT INTO storage_objects(account_id,object_key,media_type,content_type,filename,size_bytes,source,status)
		VALUES($1,$2,'document','application/gzip','revision.json.gz',$3,'whiteboard_revision','active')`, f.account, item.snapshotKey, compressed.Len())
	f.exec(`INSERT INTO whiteboard_revisions(id,account_id,board_id,revision_number,sequence,operation_id,write_kind,revision_kind,
		snapshot_object_key,snapshot_content_hash,snapshot_size_bytes,scene_schema_version,editor_version,actor_id)
		VALUES($1,$2,$3,1,0,$4,'snapshot','manual',$5,$6,$7,'excalidraw','0.18.1-clarin.7',$8)`, item.revision, f.account, item.board, uuid.New(), item.snapshotKey, fmt.Sprintf("%x", sha256.Sum256(compressed.Bytes())), compressed.Len(), f.secondUser)
	f.exec(`INSERT INTO whiteboard_revision_assets(account_id,board_id,revision_id,media_asset_id,file_id)
		VALUES($1,$2,$3,$4,'qa-image')`, f.account, item.board, item.revision, item.asset)
	return item
}

func storagePrivateQAScene(f *storageMultiOriginQAFixture, board uuid.UUID) (json.RawMessage, int64, map[string]map[string]any) {
	f.t.Helper()
	var scene json.RawMessage
	var sequence int64
	if err := f.db.QueryRow(context.Background(), `SELECT scene_json,scene_sequence FROM whiteboards WHERE account_id=$1 AND id=$2`, f.account, board).Scan(&scene, &sequence); err != nil {
		f.t.Fatal(err)
	}
	var envelope struct {
		Elements []map[string]any `json:"elements"`
	}
	if err := json.Unmarshal(scene, &envelope); err != nil {
		f.t.Fatal(err)
	}
	elements := map[string]map[string]any{}
	for _, element := range envelope.Elements {
		elements[element["id"].(string)] = element
	}
	return scene, sequence, elements
}

func storagePrivateQAPatchElement(f *storageMultiOriginQAFixture, board uuid.UUID, id string, x float64) {
	f.t.Helper()
	scene, sequence, elements := storagePrivateQAScene(f, board)
	element := elements[id]
	element["x"] = x
	element["version"] = element["version"].(float64) + 1
	element["versionNonce"] = float64(17)
	raw, err := json.Marshal(element)
	if err != nil {
		f.t.Fatal(err)
	}
	patch := []json.RawMessage{raw}
	next, _, err := whiteboardcore.MaterializeScenePatch(scene, patch, nil)
	if err != nil {
		f.t.Fatal(err)
	}
	payload, _ := json.Marshal(map[string]any{"elements": patch})
	_, err = f.server.repos.Whiteboard.ApplyScenePatch(context.Background(), f.account, f.secondUser, board, repository.WhiteboardSceneWriteInput{
		ExpectedSequence: sequence, OperationID: uuid.New(), Scene: next, Patch: payload,
		SceneSchemaVersion: "excalidraw", EditorVersion: "0.18.1-clarin.7",
		RequestPayloadHash: fmt.Sprintf("%x", sha256.Sum256(payload)), ResultSceneHash: fmt.Sprintf("%x", sha256.Sum256(next)),
	})
	if err != nil {
		f.t.Fatal(err)
	}
}

func storagePrivateQABoardUse(f *storageMultiOriginQAFixture, key string) string {
	f.t.Helper()
	var removable string
	protected := 0
	for _, use := range f.uses(key, nil) {
		if use["type"] != "whiteboards" {
			f.t.Fatalf("unexpected private image use: %v", use)
		}
		if use["can_remove"] == true {
			if removable != "" {
				f.t.Fatal("one board file mapping was duplicated per image element")
			}
			removable = use["use_id"].(string)
		} else {
			protected++
		}
	}
	if removable == "" || protected != 1 {
		f.t.Fatalf("expected one removable board use and one protected manual revision: removable=%q protected=%d", removable, protected)
	}
	return removable
}

func TestStorageSelfServiceResourceACLIntegration(t *testing.T) {
	db, store := storageMultiOriginQAServices(t)
	runStoragePrivateGCIntegrationChecks(t, db, store)
	ctx := context.Background()
	t.Run("Work revalidates resource access and preserves comments and later task edits", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		item := storagePrivateQASeedTask(f)
		original := f.objectBytes(item.key)
		use := storageQAUseOfType(t, f.uses(item.key, nil), "tasks")["use_id"].(string)
		for _, headers := range []map[string]string{{"X-QA-User": "second"}, {"X-QA-Account": "other"}} {
			status, data := f.request("GET", "/storage/uses?object_key="+url.QueryEscape(item.key), nil, headers)
			if status != 404 {
				t.Fatalf("private task attachment leaked: status=%d response=%v", status, data)
			}
			status, data = f.request("GET", "/storage/content?object_key="+url.QueryEscape(item.key), nil, headers)
			if status != 404 {
				t.Fatalf("private task bytes leaked: status=%d response=%v", status, data)
			}
		}
		// An otherwise valid child Edit grant cannot bypass a denied Entorno.
		f.exec(`INSERT INTO task_environment_grants(account_id,environment_id,user_id,access_level,created_by) VALUES($1,$2,$3,'none',$4)`, f.account, item.environment, f.user, f.secondUser)
		status, data := f.request("GET", "/storage/uses?object_key="+url.QueryEscape(item.key), nil, nil)
		if status != 404 {
			t.Fatalf("task grant bypassed denied environment: status=%d response=%v", status, data)
		}
		f.exec(`DELETE FROM task_environment_grants WHERE account_id=$1 AND environment_id=$2 AND user_id=$3`, f.account, item.environment, f.user)
		plan := f.previewUses(item.key, use)
		f.exec(`UPDATE task_access_grants SET access_level='view' WHERE account_id=$1 AND task_id=$2 AND user_id=$3`, f.account, item.task, f.user)
		if row := storageQAUseOfType(t, f.uses(item.key, nil), "tasks"); row["can_remove"] != false {
			t.Fatalf("viewer could remove attachment: %v", row)
		}
		status, data = f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
		storagePrivateQAExpectDenied(t, status, data)
		storagePrivateQAExpectTask(f, item, false, 7, "Preserve task title")
		f.exec(`UPDATE task_access_grants SET access_level='edit' WHERE account_id=$1 AND task_id=$2 AND user_id=$3`, f.account, item.task, f.user)
		plan = f.previewUses(item.key, use)
		f.confirmUse(plan)
		storagePrivateQAExpectTask(f, item, true, 7, "Preserve task title")
		f.confirmUse(plan) // replay must not write another removal or activity.
		var removals, activities int
		if err := db.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM storage_removed_references WHERE account_id=$1 AND use_id=$2),
			(SELECT COUNT(*) FROM task_activity WHERE account_id=$1 AND task_id=$3 AND action='attachment_deleted')`, f.account, use, item.task).Scan(&removals, &activities); err != nil {
			t.Fatal(err)
		}
		if removals != 1 || activities != 1 {
			t.Fatalf("replay duplicated Work mutation: recoveries=%d activity=%d", removals, activities)
		}
		id := f.recoveryID(item.key, use)
		restorePlan := storagePrivateQARecoveryPreview(f, id)
		f.exec(`UPDATE task_access_grants SET access_level='none' WHERE account_id=$1 AND task_id=$2 AND user_id=$3`, f.account, item.task, f.user)
		status, data = f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": restorePlan["preview_id"]}, nil)
		storagePrivateQAExpectDenied(t, status, data)
		storagePrivateQAExpectTask(f, item, true, 7, "Preserve task title")
		f.exec(`UPDATE task_access_grants SET access_level='edit' WHERE account_id=$1 AND task_id=$2 AND user_id=$3`, f.account, item.task, f.user)
		f.exec(`UPDATE tasks SET title='Later independent task edit',version=version+1 WHERE account_id=$1 AND id=$2`, f.account, item.task)
		f.recover("restore", id)
		storagePrivateQAExpectTask(f, item, false, 8, "Later independent task edit")
		if !bytes.Equal(original, f.objectBytes(item.key)) {
			t.Fatal("Work detach/restore changed the original physical bytes")
		}
	})
	t.Run("Pizarras preserve manual history and unrelated canonical edits through removal and restore", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		item := storagePrivateQASeedBoard(f)
		original, historical := f.objectBytes(item.key), f.objectBytes(item.snapshotKey)
		var revisionBefore string
		if err := db.QueryRow(ctx, `SELECT to_jsonb(revision)::text FROM whiteboard_revisions revision WHERE account_id=$1 AND id=$2`, f.account, item.revision).Scan(&revisionBefore); err != nil {
			t.Fatal(err)
		}
		use := storagePrivateQABoardUse(f, item.key)
		plan := f.previewUses(item.key, use)
		foreignStatus, foreignData := f.request("GET", "/storage/uses?object_key="+url.QueryEscape(item.key), nil, map[string]string{"X-QA-Account": "other"})
		if foreignStatus != 404 {
			t.Fatalf("foreign account discovered board image/history: status=%d response=%v", foreignStatus, foreignData)
		}
		f.exec(`UPDATE whiteboard_grants SET access_level='view' WHERE account_id=$1 AND board_id=$2 AND user_id=$3`, f.account, item.board, f.user)
		status, data := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
		storagePrivateQAExpectDenied(t, status, data)
		_, sequence, elements := storagePrivateQAScene(f, item.board)
		if sequence != 0 || elements["image-a"]["isDeleted"] != false {
			t.Fatal("revoked board edit changed its scene")
		}
		f.exec(`DELETE FROM whiteboard_grants WHERE account_id=$1 AND board_id=$2 AND user_id=$3`, f.account, item.board, f.user)
		status, data = f.request("GET", "/storage/uses?object_key="+url.QueryEscape(item.key), nil, nil)
		if status != 404 {
			t.Fatalf("revoked board revealed current/historical image uses: status=%d response=%v", status, data)
		}
		f.exec(`INSERT INTO whiteboard_grants(account_id,board_id,user_id,access_level,created_by) VALUES($1,$2,$3,'edit',$4)`, f.account, item.board, f.user, f.secondUser)
		f.confirmUse(f.previewUses(item.key, use))
		_, sequence, elements = storagePrivateQAScene(f, item.board)
		if sequence != 1 || len(elements) != 3 || elements["image-a"]["isDeleted"] != true || elements["image-b"]["isDeleted"] != true || elements["unrelated"]["version"] != float64(4) || elements["unrelated"]["x"] != float64(100) {
			t.Fatalf("board removal affected wrong elements or failed canonical sequence: sequence=%d elements=%v", sequence, elements)
		}
		id := f.recoveryID(item.key, use)
		storagePrivateQAPatchElement(f, item.board, "unrelated", 250)
		restorePlan := storagePrivateQARecoveryPreview(f, id)
		f.exec(`UPDATE whiteboard_grants SET access_level='view' WHERE account_id=$1 AND board_id=$2 AND user_id=$3`, f.account, item.board, f.user)
		status, data = f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": restorePlan["preview_id"]}, nil)
		storagePrivateQAExpectDenied(t, status, data)
		f.exec(`UPDATE whiteboard_grants SET access_level='edit' WHERE account_id=$1 AND board_id=$2 AND user_id=$3`, f.account, item.board, f.user)
		f.recover("restore", id)
		afterScene, sequence, elements := storagePrivateQAScene(f, item.board)
		if sequence != 3 || len(elements) != 3 || elements["image-a"]["isDeleted"] != false || elements["image-b"]["isDeleted"] != false || elements["image-a"]["version"] != float64(3) || elements["unrelated"]["version"] != float64(5) || elements["unrelated"]["x"] != float64(250) {
			t.Fatalf("board restoration lost a later independent edit: sequence=%d elements=%v", sequence, elements)
		}
		var envelope map[string]json.RawMessage
		if err := json.Unmarshal(afterScene, &envelope); err != nil || !bytes.Contains(envelope["customEnvelope"], []byte("root")) {
			t.Fatal("opaque scene extension disappeared")
		}
		var revisionAfter string
		var revisionAssets, currentLinks, patches int
		var uploaderPreserved bool
		if err := db.QueryRow(ctx, `SELECT to_jsonb(revision)::text,
			(SELECT COUNT(*) FROM whiteboard_revision_assets WHERE account_id=$1 AND revision_id=$2),
			(SELECT COUNT(*) FROM whiteboard_assets WHERE account_id=$1 AND board_id=$3 AND id=$4),
			(SELECT COUNT(*) FROM whiteboard_operations WHERE account_id=$1 AND board_id=$3 AND operation_kind='patch'),
			(SELECT uploaded_by=$5 FROM whiteboard_assets WHERE account_id=$1 AND id=$4)
			FROM whiteboard_revisions revision WHERE account_id=$1 AND id=$2`, f.account, item.revision, item.board, item.link, f.secondUser).Scan(&revisionAfter, &revisionAssets, &currentLinks, &patches, &uploaderPreserved); err != nil {
			t.Fatal(err)
		}
		if revisionAfter != revisionBefore || revisionAssets != 1 || currentLinks != 1 || patches != 3 || !uploaderPreserved || !bytes.Equal(original, f.objectBytes(item.key)) || !bytes.Equal(historical, f.objectBytes(item.snapshotKey)) {
			t.Fatalf("board cycle altered history, asset identity, operation count or bytes: historical_assets=%d current_links=%d patches=%d", revisionAssets, currentLinks, patches)
		}
	})
	t.Run("Pizarras restoration conflicts with a changed removed element without partial writes", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		item := storagePrivateQASeedBoard(f)
		use := storagePrivateQABoardUse(f, item.key)
		f.confirmUse(f.previewUses(item.key, use))
		id := f.recoveryID(item.key, use)
		storagePrivateQAPatchElement(f, item.board, "image-a", 400)
		before, sequence, _ := storagePrivateQAScene(f, item.board)
		status, data := f.request("POST", "/storage/cleanup/preview", map[string]any{"action": "restore", "recovery_ids": []string{id}}, nil)
		if status == 200 && data["preview_id"] != nil {
			status, data = f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": data["preview_id"]}, nil)
		}
		storagePrivateQAExpectDenied(t, status, data)
		after, afterSequence, _ := storagePrivateQAScene(f, item.board)
		var links int
		var state string
		if err := db.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM whiteboard_assets WHERE account_id=$1 AND board_id=$2),state
			FROM storage_removed_references WHERE account_id=$1 AND id=$3`, f.account, item.board, id).Scan(&links, &state); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(before, after) || sequence != afterSequence || links != 0 || state != "removed" {
			t.Fatalf("conflicting restoration partially mutated board/recovery: links=%d state=%s sequence=%d/%d", links, state, sequence, afterSequence)
		}
		f.expectObject(item.key, true)
		f.expectObject(item.snapshotKey, true)
	})
}
