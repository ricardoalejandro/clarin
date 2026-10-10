package api

import (
	"net/url"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/pkg/config"
)

func TestMediaPublicationCannotPromoteUnreadableChatToPublicDynamic(t *testing.T) {
	accountID, userID := uuid.New(), uuid.New()
	key := accountID.String() + "/chats/photo.jpg"
	claims := &service.JWTClaims{AccountID: accountID, UserID: userID, SessionID: uuid.NewString(), Role: "member", Permissions: []string{domain.PermDynamics}}
	chatRefs := []storageSelfServiceReference{{Origin: "chats", ID: uuid.NewString()}}
	if mediaReferenceAssignmentAllowed(claims, key, nil, chatRefs) {
		t.Fatal("dynamics-only actor could publicly publish an unreadable chat")
	}
	claims.Permissions = []string{domain.PermSurveys}
	if mediaReferenceAssignmentAllowed(claims, key, nil, chatRefs) {
		t.Fatal("surveys-only actor could publicly publish an unreadable chat")
	}
	claims.Permissions = []string{domain.PermBroadcasts}
	if mediaReferenceAssignmentAllowed(claims, key, nil, chatRefs) {
		t.Fatal("campaign-only actor could attach an unreadable chat")
	}
	claims.Permissions = []string{domain.PermDocuments}
	if mediaReferenceAssignmentAllowed(claims, key, nil, chatRefs) {
		t.Fatal("documents-only actor could attach an unreadable chat")
	}

	claims.Permissions = []string{domain.PermChats, domain.PermDynamics}
	if !mediaReferenceAssignmentAllowed(claims, key, nil, chatRefs) {
		t.Fatal("authorized explicit sharing rejected")
	}
	claims.Permissions = []string{domain.PermDynamics}
	if !mediaReferenceAssignmentAllowed(claims, key, nil, []storageSelfServiceReference{{Origin: "dynamics"}}) {
		t.Fatal("existing dynamic image could not be retained")
	}
	grant := &mediaAccessGrant{Purpose: "upload-preview", AccountID: accountID, UserID: userID, SessionID: claims.SessionID}
	if !mediaReferenceAssignmentAllowed(claims, key, grant, nil) {
		t.Fatal("own freshly uploaded bytes could not be published")
	}
	grant.UserID = uuid.New()
	if mediaReferenceAssignmentAllowed(claims, key, grant, nil) {
		t.Fatal("another user's upload could be published")
	}
	claims.Role = domain.RoleAdmin
	if mediaReferenceAssignmentAllowed(claims, uuid.NewString()+"/chats/photo.jpg", nil, chatRefs) {
		t.Fatal("admin could cross account boundary")
	}
	if mediaReferenceAssignmentAllowed(claims, accountID.String()+"/_private/tasks/photo.jpg", nil, chatRefs) {
		t.Fatal("protected module could be promoted by URL")
	}
}

func TestMediaProxyURLRecognizesOnlyRelativeOrConfiguredAppOrigins(t *testing.T) {
	server := &Server{cfg: &config.Config{PublicURL: "https://clarin.example", CORSOrigins: []string{"https://workspace.example"}}}
	for _, raw := range []string{"/api/media/file/a/file.png", "https://clarin.example/api/media/file/a/file.png", "https://workspace.example/api/media/file/a/file.png"} {
		parsed, _ := url.Parse(raw)
		if !server.isLocalMediaProxyURL(parsed) {
			t.Fatalf("local proxy rejected %q", raw)
		}
	}
	for _, raw := range []string{"https://evil.example/api/media/file/a/file.png", "//clarin.example/api/media/file/a/file.png", "https://user@clarin.example/api/media/file/a/file.png", "https://clarin.example.evil/api/media/file/a/file.png", "http://clarin.example/api/media/file/a/file.png"} {
		parsed, _ := url.Parse(raw)
		if server.isLocalMediaProxyURL(parsed) {
			t.Fatalf("foreign URL treated as local %q", raw)
		}
		if _, stored := server.ordinaryObjectKeyFromURL(raw); stored {
			t.Fatalf("foreign URL key trusted %q", raw)
		}
		grant := mediaAccessGrant{Purpose: "dynamic-public", AccountID: uuid.New(), ResourceID: uuid.New()}
		if got := server.publicResourceMediaURL(raw, grant); got != raw {
			t.Fatal("external content was signed or modified")
		}
	}
}
