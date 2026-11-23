package repository

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestWhatsAppGroupContinuityPostgresKeepsHistoricalPollProjection(t *testing.T) {
	for _, kind := range []string{"options", "votes"} {
		t.Run(kind, func(t *testing.T) {
			db := programSurveyIntegrityPool(t)
			ctx := context.Background()
			f := integrityProgram(t, db)
			repos := NewRepositories(db)
			old, current := uuid.New(), uuid.New()
			integrityExec(t, db, `INSERT INTO devices(id,account_id,name,status) VALUES($1,$3,'old poll','disconnected'),($2,$3,'current poll','connected')`, old, current, f.account)
			jid, pn, lid := "12009904@g.us", "51900000001@s.whatsapp.net", "70001@lid"
			oldChat, err := repos.Chat.GetOrCreateGroup(ctx, f.account, old, jid, "Poll history")
			if err != nil {
				t.Fatal(err)
			}
			currentChat, err := repos.Chat.GetOrCreateGroup(ctx, f.account, current, jid, "Poll current")
			if err != nil {
				t.Fatal(err)
			}
			metadata := &domain.ChatGroup{Subject: "Poll", MembershipStatus: "member", Kind: "group"}
			if err = repos.Chat.SaveGroup(ctx, f.account, oldChat.ID, metadata, []domain.GroupParticipant{{JID: lid, IsSelf: true}}); err != nil {
				t.Fatal(err)
			}
			oldMessage, currentMessage := uuid.New(), uuid.New()
			at := time.Now().UTC().Truncate(time.Second)
			integrityExec(t, db, `INSERT INTO messages(id,account_id,chat_id,device_id,message_id,from_jid,is_from_me,message_type,poll_question,timestamp) VALUES($1,$3,$4,$6,'poll-stanza',$8,TRUE,'poll','Question',$10),($2,$3,$5,$7,'poll-stanza',$9,TRUE,'poll','Question',$10)`, oldMessage, currentMessage, f.account, oldChat.ID, currentChat.ID, old, current, lid, pn, at)
			if kind == "options" {
				integrityExec(t, db, `INSERT INTO poll_options(message_id,name,vote_count) VALUES($1,'Option',1)`, oldMessage)
			} else {
				integrityExec(t, db, `INSERT INTO poll_votes(message_id,voter_jid,selected_names,timestamp) VALUES($1,'90001@lid',ARRAY['Option'],$2)`, oldMessage, at)
			}
			integrityExec(t, db, `UPDATE chats SET device_id=NULL WHERE id=$1`, oldChat.ID)
			integrityExec(t, db, `DELETE FROM devices WHERE id=$1`, old)
			if _, err = repos.Chat.BindWhatsAppOwner(ctx, f.account, current, pn, lid, "poll-current"); err != nil {
				t.Fatal(err)
			}
			if _, err = repos.Chat.ReconcileWhatsAppGroups(ctx, f.account, current, pn, lid); err != nil {
				t.Fatal(err)
			}
			var keeper uuid.UUID
			if err = db.QueryRow(ctx, `SELECT canonical_message_id FROM whatsapp_message_aliases WHERE account_id=$1 AND alias_message_id=$2`, f.account, currentMessage).Scan(&keeper); err != nil || keeper != oldMessage {
				t.Fatal("empty current poll concealed historical projection", err)
			}
			visible, err := repos.Message.GetWindowByChatID(ctx, f.account, currentChat.ID, 10, 0)
			if err != nil || len(visible) != 1 || visible[0].ID != oldMessage {
				t.Fatal("history did not retain poll representative", err)
			}
			if err = repos.Message.ReconcileConversationMessage(ctx, f.account, currentChat.ID, "poll-stanza"); err != nil {
				t.Fatal(err)
			}
			if err = db.QueryRow(ctx, `SELECT canonical_message_id FROM whatsapp_message_aliases WHERE account_id=$1 AND alias_message_id=$2`, f.account, currentMessage).Scan(&keeper); err != nil || keeper != oldMessage {
				t.Fatal("poll keeper changed on replay", err)
			}
		})
	}
}
