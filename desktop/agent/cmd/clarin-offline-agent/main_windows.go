//go:build windows

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/naperu/clarin-offline-agent/internal/deviceidentity"
	"github.com/naperu/clarin-offline-agent/internal/deviceposture"
	"github.com/naperu/clarin-offline-agent/internal/localstate"
	"github.com/naperu/clarin-offline-agent/internal/protocol"
	"github.com/naperu/clarin-offline-agent/internal/securestore"
)

const version = "0.3.3"

var errSignedWipeCompleted = errors.New("signed terminal wipe completed")

type profile struct {
	Server              string            `json:"server"`
	TerminalID          string            `json:"terminal_id"`
	InstallInstance     string            `json:"install_instance"`
	InstallInstanceHash string            `json:"install_instance_hash"`
	Accounts            []string          `json:"accounts"`
	AccountLabels       map[string]string `json:"account_labels,omitempty"`
	Counter             int64             `json:"counter"`
	LeaseKeyVersion     int               `json:"lease_key_version"`
	LeasePublicKeyPEM   string            `json:"lease_public_key_pem"`
	PendingPublicKeyPEM string            `json:"pending_public_key_pem,omitempty"`
	DeviceKeyKind       string            `json:"device_key_kind,omitempty"`
	PrivateKeyPKCS8     string            `json:"private_key_pkcs8,omitempty"`
}

type inventoryItem struct {
	SelectionID  string `json:"selection_id"`
	Module       string `json:"module"`
	ResourceType string `json:"resource_type"`
	ResourceID   string `json:"resource_id"`
	HeadVersion  int64  `json:"head_version"`
	ContentHash  string `json:"content_hash,omitempty"`
}

type operation struct {
	OperationID      string          `json:"operation_id"`
	DependsOn        []string        `json:"depends_on,omitempty"`
	SelectionID      string          `json:"selection_id,omitempty"`
	Module           string          `json:"module"`
	ResourceType     string          `json:"resource_type"`
	ResourceID       string          `json:"resource_id"`
	OperationType    string          `json:"operation_type"`
	BaseVersion      int64           `json:"base_version"`
	Base             json.RawMessage `json:"base,omitempty"`
	Patch            json.RawMessage `json:"patch"`
	ClientOccurredAt time.Time       `json:"client_occurred_at"`
}

type operationResult struct {
	OperationID   string          `json:"operation_id"`
	Status        string          `json:"status"`
	ResourceID    string          `json:"resource_id,omitempty"`
	ServerVersion int64           `json:"server_version,omitempty"`
	ConflictID    string          `json:"conflict_id,omitempty"`
	ErrorCode     string          `json:"error_code,omitempty"`
	Result        json.RawMessage `json:"result,omitempty"`
}

type accountState struct {
	AccountID         string                     `json:"account_id"`
	Inventory         []inventoryItem            `json:"inventory"`
	Snapshots         map[string]json.RawMessage `json:"snapshots"`
	Outbox            []operation                `json:"outbox"`
	OperationResults  []operationResult          `json:"operation_results"`
	Lease             protocol.Envelope          `json:"lease"`
	LeaseClaims       *protocol.LeaseClaims      `json:"lease_claims,omitempty"`
	LastTrustedWall   time.Time                  `json:"last_trusted_wall"`
	SelectionRevision int64                      `json:"selection_revision"`
}

type challengeResponse struct {
	Success     bool   `json:"success"`
	ChallengeID string `json:"challenge_id"`
	Nonce       string `json:"nonce"`
	Error       string `json:"error"`
}

type syncResponse struct {
	Success           bool                        `json:"success"`
	Error             string                      `json:"error"`
	Lease             protocol.Envelope           `json:"lease"`
	ServerTime        time.Time                   `json:"server_time"`
	TerminalState     string                      `json:"terminal_state"`
	Controls          []protocol.ControlDirective `json:"controls"`
	Inventory         []inventoryItem             `json:"inventory"`
	FetchRequired     []string                    `json:"fetch_required"`
	OperationResults  []operationResult           `json:"operation_results"`
	SelectionRevision int64                       `json:"selection_revision"`
}

func main() {
	if len(os.Args) < 2 {
		fatal("usage: clarin-offline-agent bootstrap-status|prepare-enrollment|complete-enrollment|sync|run|status|local-accounts|local-state|enqueue|wipe")
	}
	switch os.Args[1] {
	case "bootstrap-status":
		bootstrapStatus(os.Args[2:])
	case "prepare-enrollment":
		prepareEnrollment(os.Args[2:])
	case "complete-enrollment":
		completeEnrollment(os.Args[2:])
	case "sync":
		syncOne(os.Args[2:])
	case "run":
		run(os.Args[2:])
	case "status":
		status(os.Args[2:])
	case "local-accounts":
		localAccounts(os.Args[2:])
	case "local-state":
		localState(os.Args[2:])
	case "enqueue":
		enqueue(os.Args[2:])
	case "wipe":
		wipe(os.Args[2:])
	default:
		fatal("unknown command")
	}
}

func prepareEnrollment(args []string) {
	fs := flag.NewFlagSet("prepare-enrollment", flag.ExitOnError)
	server := fs.String("server", "", "Clarin server URL")
	_ = fs.Parse(args)
	requireHTTPS(*server)
	validateWindowsCompatibility()
	posture := collectDevicePosture()
	canonicalServer := strings.TrimRight(*server, "/")
	paths, err := filepath.Glob(filepath.Join(dataDir(), "profile-*.dpapi"))
	check(err)
	if len(paths) > 1 {
		fatal("multiple terminal profiles require local cleanup before enrollment")
	}
	if len(paths) == 1 {
		p, _, err := loadProfile()
		check(err)
		if p.Server != canonicalServer {
			fatal("the existing terminal profile belongs to another server")
		}
		if p.PendingPublicKeyPEM == "" && p.LeaseKeyVersion > 0 && len(p.Accounts) > 0 {
			check(json.NewEncoder(os.Stdout).Encode(map[string]any{"success": true, "state": "active", "terminal_id": p.TerminalID, "client_version": version}))
			return
		}
		writeEnrollmentRequest(p, posture)
		return
	}

	terminalID, err := newUUIDV4()
	check(err)
	installRaw := make([]byte, 32)
	_, err = rand.Read(installRaw)
	check(err)
	p := profile{Server: canonicalServer, TerminalID: terminalID, InstallInstance: hex.EncodeToString(installRaw)}
	installHash := sha256.Sum256([]byte(p.InstallInstance))
	p.InstallInstanceHash = hex.EncodeToString(installHash[:])
	p.PendingPublicKeyPEM, p.DeviceKeyKind, p.PrivateKeyPKCS8, err = createEnrollmentIdentity(terminalID)
	check(err)
	store := mustStore(terminalID)
	check(store.Save(profileItem(terminalID), p))
	check(restrictDataDirectory(currentSID()))
	writeEnrollmentRequest(p, posture)
}

func writeEnrollmentRequest(p profile, posture deviceposture.Report) {
	sid := currentSID()
	if sid == "" {
		fatal("Windows user identity is unavailable")
	}
	sidHash := sha256.Sum256([]byte(sid))
	hostname, _ := os.Hostname()
	if strings.TrimSpace(hostname) == "" {
		hostname = "Equipo Windows"
	}
	check(json.NewEncoder(os.Stdout).Encode(map[string]any{
		"success": true, "state": "pending", "terminal_id": p.TerminalID,
		"display_name": strings.TrimSpace(hostname), "public_key_pem": p.PendingPublicKeyPEM,
		"windows_sid_hash": hex.EncodeToString(sidHash[:]), "install_instance_hash": p.InstallInstanceHash,
		"client_version": version, "device_posture": posture,
	}))
}

func createEnrollmentIdentity(terminalID string) (string, string, string, error) {
	if publicKeyPEM, err := createCNGEnrollmentKey(terminalID); err == nil {
		return publicKeyPEM, "cng", "", nil
	}
	identity, err := deviceidentity.GenerateSoftwareIdentity()
	if err != nil {
		return "", "", "", err
	}
	return identity.PublicKeyPEM, "dpapi", identity.PrivateKeyPKCS8, nil
}

func createCNGEnrollmentKey(terminalID string) (string, error) {
	script := `$ErrorActionPreference='Stop';$name='ClarinOffline-'+$args[0];$provider=[System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider;try{$key=[System.Security.Cryptography.CngKey]::Open($name,$provider)}catch{$p=[System.Security.Cryptography.CngKeyCreationParameters]::new();$p.Provider=$provider;$p.KeyUsage=[System.Security.Cryptography.CngKeyUsages]::Signing;$p.ExportPolicy=[System.Security.Cryptography.CngExportPolicies]::None;$key=[System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::ECDsaP256,$name,$p)};try{$blob=$key.Export([System.Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob);[Convert]::ToBase64String($blob)}finally{$key.Dispose()}`
	encoded, err := outputErr("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script, terminalID)
	if err != nil {
		return "", err
	}
	return deviceidentity.PublicPEMFromCNGBlob(encoded)
}

type completeEnrollmentInput struct {
	TerminalID        string `json:"terminal_id"`
	State             string `json:"state"`
	LeaseKeyVersion   int    `json:"lease_key_version"`
	LeasePublicKeyPEM string `json:"lease_public_key_pem"`
	Accounts          []struct {
		AccountID   string `json:"account_id"`
		AccountName string `json:"account_name"`
	} `json:"accounts"`
}

func completeEnrollment(args []string) {
	fs := flag.NewFlagSet("complete-enrollment", flag.ExitOnError)
	server := fs.String("server", "", "Clarin server URL")
	_ = fs.Parse(args)
	requireHTTPS(*server)
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 4<<20))
	check(err)
	var input completeEnrollmentInput
	check(json.Unmarshal(raw, &input))
	if input.State != "approved" || !localstate.ValidUUID(input.TerminalID) || input.LeaseKeyVersion < 1 || input.LeasePublicKeyPEM == "" {
		fatal("the server approval payload is incomplete")
	}
	p, store, err := loadProfile()
	check(err)
	if p.TerminalID != input.TerminalID || p.Server != strings.TrimRight(*server, "/") || p.PendingPublicKeyPEM == "" {
		fatal("the approval does not match this pending terminal")
	}
	if len(input.Accounts) == 0 {
		fatal("the approval contains no account grants")
	}
	canonical := "CLARIN-OFFLINE-ACTIVATE\n" + p.TerminalID + "\n" + strings.ToLower(p.InstallInstanceHash)
	signature, err := signWithDeviceKey(p, canonical)
	check(err)
	body, _ := json.Marshal(map[string]any{"terminal_id": p.TerminalID, "install_instance_hash": p.InstallInstanceHash, "signature": signature})
	request, err := http.NewRequest(http.MethodPost, p.Server+"/api/offline/v2/activate", bytes.NewReader(body))
	check(err)
	request.Header.Set("Content-Type", "application/json")
	response, err := httpClient().Do(request)
	check(err)
	activationRaw, err := readResponse(response)
	check(err)
	var activation struct {
		Success bool   `json:"success"`
		Error   string `json:"error"`
	}
	check(json.Unmarshal(activationRaw, &activation))
	if !responseOK(response.StatusCode, activation.Success) {
		fatal("terminal activation failed: " + activation.Error)
	}
	p.PendingPublicKeyPEM = ""
	p.LeaseKeyVersion, p.LeasePublicKeyPEM = input.LeaseKeyVersion, input.LeasePublicKeyPEM
	p.Accounts = make([]string, 0, len(input.Accounts))
	p.AccountLabels = make(map[string]string, len(input.Accounts))
	for _, account := range input.Accounts {
		if localstate.ValidUUID(account.AccountID) && !contains(p.Accounts, account.AccountID) {
			p.Accounts = append(p.Accounts, account.AccountID)
			p.AccountLabels[account.AccountID] = account.AccountName
		}
	}
	if len(p.Accounts) == 0 {
		fatal("the approval contains no valid account grants")
	}
	check(store.Save(profileItem(p.TerminalID), p))
	check(restrictDataDirectory(currentSID()))
	check(json.NewEncoder(os.Stdout).Encode(map[string]any{"success": true, "state": "active", "terminal_id": p.TerminalID, "accounts": len(p.Accounts)}))
}

func newUUIDV4() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), nil
}

func syncOne(args []string) {
	fs := flag.NewFlagSet("sync", flag.ExitOnError)
	account := fs.String("account", "", "approved account UUID; empty synchronizes every grant")
	_ = fs.Parse(args)
	p, store, err := loadProfile()
	check(err)
	accounts := p.Accounts
	if *account != "" {
		accounts = []string{*account}
	}
	if len(accounts) == 0 {
		fatal("no approved accounts are configured")
	}
	posture := collectDevicePosture()
	for _, accountID := range accounts {
		if err := performSync(&p, store, accountID, posture); err != nil {
			if errors.Is(err, errSignedWipeCompleted) {
				check(json.NewEncoder(os.Stdout).Encode(map[string]any{"success": true, "wiped": true}))
				return
			}
			_ = store.Save(profileItem(p.TerminalID), p)
			fatal(err.Error())
		}
	}
	check(store.Save(profileItem(p.TerminalID), p))
	check(json.NewEncoder(os.Stdout).Encode(map[string]any{"success": true, "accounts": len(accounts)}))
}

func run(args []string) {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	interval := fs.Duration("interval", time.Minute, "sync interval")
	_ = fs.Parse(args)
	p, store, err := loadProfile()
	check(err)
	if len(p.Accounts) == 0 {
		fatal("no approved accounts are configured")
	}
	ticker := time.NewTicker(*interval)
	defer ticker.Stop()
	for {
		posture := collectDevicePosture()
		for _, accountID := range p.Accounts {
			if err := performSync(&p, store, accountID, posture); err != nil {
				if errors.Is(err, errSignedWipeCompleted) {
					fmt.Println("signed terminal wipe completed")
					return
				}
				fmt.Fprintln(os.Stderr, "sync:", err)
			}
		}
		_ = store.Save(profileItem(p.TerminalID), p)
		<-ticker.C
	}
}

func performSync(p *profile, store *securestore.Store, accountID string, posture deviceposture.Report) error {
	requireHTTPS(p.Server)
	state := accountState{AccountID: accountID, Snapshots: map[string]json.RawMessage{}}
	if err := store.Load(accountItem(accountID), &state); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if state.Snapshots == nil {
		state.Snapshots = map[string]json.RawMessage{}
	}
	bootHash, err := currentBootHash(p.TerminalID)
	if err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]any{
		"terminal_id": p.TerminalID, "account_id": accountID, "install_instance_hash": p.InstallInstanceHash,
		"boot_id_hash": bootHash, "client_version": version, "used_storage_bytes": localStorageUsage(),
		"inventory": state.Inventory, "operations": localstate.BoundedPrefix(state.Outbox, 100), "device_posture": posture,
	})
	raw, statusCode, err := signedRequest(p, store, accountID, http.MethodPost, "/api/offline/v2/sync", body)
	if err != nil {
		return err
	}
	var synced syncResponse
	if err := json.Unmarshal(raw, &synced); err != nil {
		return err
	}
	if !responseOK(statusCode, synced.Success) {
		// Transport and authorization errors never authorize local destruction.
		return fmt.Errorf("sync rejected (%d): %s", statusCode, synced.Error)
	}
	if err := processControls(p, store, accountID, synced.Controls); err != nil {
		return err
	}
	if synced.TerminalState == "revoked" {
		return errors.New("terminal is revoked; awaiting or completing signed wipe")
	}
	claims, err := protocol.ValidateLease(synced.Lease, p.LeaseKeyVersion, p.LeasePublicKeyPEM, p.TerminalID, accountID, bootHash, time.Now().UTC())
	if err != nil {
		return fmt.Errorf("invalid offline lease: %w", err)
	}
	state.Lease, state.LeaseClaims = synced.Lease, claims
	state.Inventory, state.SelectionRevision = synced.Inventory, synced.SelectionRevision
	selectionIDs := make([]string, 0, len(state.Inventory))
	for _, item := range state.Inventory {
		selectionIDs = append(selectionIDs, item.SelectionID)
	}
	localstate.PruneSnapshots(state.Snapshots, selectionIDs)
	state.OperationResults = localstate.MergeBoundedByID(state.OperationResults, synced.OperationResults, 2000, func(result operationResult) string { return result.OperationID })
	receipts := make([]localstate.OperationReceipt, 0, len(synced.OperationResults))
	for _, result := range synced.OperationResults {
		receipts = append(receipts, localstate.OperationReceipt{OperationID: result.OperationID, Status: result.Status})
	}
	state.Outbox = localstate.ReconcileOutbox(state.Outbox, receipts, func(pending operation) string { return pending.OperationID })
	if len(synced.FetchRequired) > 0 {
		if err := fetchSnapshots(p, store, &state, synced.FetchRequired); err != nil {
			return err
		}
	}
	trustedNow := time.Now().UTC()
	if synced.ServerTime.After(state.LastTrustedWall) && !synced.ServerTime.After(trustedNow.Add(5*time.Minute)) {
		state.LastTrustedWall = synced.ServerTime
	} else if trustedNow.After(state.LastTrustedWall) {
		state.LastTrustedWall = trustedNow
	}
	return store.Save(accountItem(accountID), state)
}

func signedRequest(p *profile, store *securestore.Store, accountID, method, path string, body []byte) ([]byte, int, error) {
	challengeBody, _ := json.Marshal(map[string]string{"terminal_id": p.TerminalID})
	response, err := httpClient().Post(p.Server+"/api/offline/v2/challenge", "application/json", bytes.NewReader(challengeBody))
	if err != nil {
		return nil, 0, err
	}
	raw, err := readResponse(response)
	if err != nil {
		return nil, response.StatusCode, err
	}
	var challenge challengeResponse
	if err := json.Unmarshal(raw, &challenge); err != nil {
		return nil, response.StatusCode, err
	}
	if !responseOK(response.StatusCode, challenge.Success) || challenge.ChallengeID == "" || challenge.Nonce == "" {
		return nil, response.StatusCode, fmt.Errorf("terminal challenge unavailable (%d)", response.StatusCode)
	}
	p.Counter++
	// Persist before sending. A crash may skip a number, but can never reuse it.
	if err := store.Save(profileItem(p.TerminalID), *p); err != nil {
		return nil, 0, err
	}
	contentType := "application/json"
	canonical := protocol.CanonicalRequest(method, path, p.TerminalID, accountID, challenge.ChallengeID, challenge.Nonce, p.Counter, contentType, body)
	signature, err := signWithDeviceKey(*p, canonical)
	if err != nil {
		return nil, 0, err
	}
	request, err := http.NewRequest(method, p.Server+path, bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("X-Clarin-Challenge-ID", challenge.ChallengeID)
	request.Header.Set("X-Clarin-Nonce", challenge.Nonce)
	request.Header.Set("X-Clarin-Counter", strconv.FormatInt(p.Counter, 10))
	request.Header.Set("X-Clarin-Signature", signature)
	response, err = httpClient().Do(request)
	if err != nil {
		return nil, 0, err
	}
	raw, err = readResponse(response)
	return raw, response.StatusCode, err
}

func fetchSnapshots(p *profile, store *securestore.Store, state *accountState, selectionIDs []string) error {
	body, _ := json.Marshal(map[string]any{"terminal_id": p.TerminalID, "account_id": state.AccountID, "install_instance_hash": p.InstallInstanceHash, "selection_ids": selectionIDs})
	raw, statusCode, err := signedRequest(p, store, state.AccountID, http.MethodPost, "/api/offline/v2/resources/fetch", body)
	if err != nil {
		return err
	}
	var decoded struct {
		Success       bool                        `json:"success"`
		Error         string                      `json:"error"`
		TerminalState string                      `json:"terminal_state"`
		Controls      []protocol.ControlDirective `json:"controls"`
		Snapshots     []struct {
			SelectionID string          `json:"selection_id"`
			Version     int64           `json:"version"`
			ContentHash string          `json:"content_hash"`
			Payload     json.RawMessage `json:"payload"`
			Tombstone   bool            `json:"tombstone"`
		} `json:"snapshots"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return err
	}
	if !responseOK(statusCode, decoded.Success) {
		return fmt.Errorf("resource fetch rejected (%d): %s", statusCode, decoded.Error)
	}
	if err := processControls(p, store, state.AccountID, decoded.Controls); err != nil {
		return err
	}
	if decoded.TerminalState == "revoked" {
		return errors.New("terminal revoked during resource fetch")
	}
	for _, snapshot := range decoded.Snapshots {
		if !localstate.SnapshotHashMatches(snapshot.Payload, snapshot.ContentHash) {
			return errors.New("offline snapshot integrity verification failed")
		}
		if snapshot.Tombstone {
			delete(state.Snapshots, snapshot.SelectionID)
			continue
		}
		state.Snapshots[snapshot.SelectionID] = append(json.RawMessage(nil), snapshot.Payload...)
		for index := range state.Inventory {
			if state.Inventory[index].SelectionID == snapshot.SelectionID {
				state.Inventory[index].HeadVersion = snapshot.Version
				state.Inventory[index].ContentHash = snapshot.ContentHash
				break
			}
		}
	}
	currentSize, err := store.Size(accountItem(state.AccountID))
	if err != nil {
		return err
	}
	projected := localStorageUsage() - currentSize + localstate.EstimatedBytes(*state) + 16*1024
	if state.LeaseClaims != nil && projected > state.LeaseClaims.MaxStorageBytes {
		return errors.New("offline storage quota exceeded; reduce the selected resources online")
	}
	return nil
}

func processControls(p *profile, store *securestore.Store, accountID string, controls []protocol.ControlDirective) error {
	for _, directive := range controls {
		claims, err := protocol.ValidateControl(directive, p.LeaseKeyVersion, p.LeasePublicKeyPEM, p.TerminalID, time.Now().UTC())
		if err != nil {
			return fmt.Errorf("signed control rejected: %w", err)
		}
		switch claims.DirectiveType {
		case "wipe":
			if err := wipeAccountCaches(store, p.Accounts); err != nil {
				return err
			}
			if err := acknowledgeControl(p, store, accountID, directive.ID); err != nil {
				return fmt.Errorf("local data erased; wipe acknowledgement pending: %w", err)
			}
			if err := finalizeWipe(store, p.TerminalID); err != nil {
				return err
			}
			return errSignedWipeCompleted
		case "lock":
			if err := wipeAccountCaches(store, p.Accounts); err != nil {
				return err
			}
		}
	}
	return nil
}

func acknowledgeControl(p *profile, store *securestore.Store, accountID, directiveID string) error {
	body, _ := json.Marshal(map[string]any{"terminal_id": p.TerminalID, "account_id": accountID, "install_instance_hash": p.InstallInstanceHash, "directive_id": directiveID, "acknowledgement": map[string]any{"status": "wiped", "client_version": version, "at": time.Now().UTC()}})
	raw, statusCode, err := signedRequest(p, store, accountID, http.MethodPost, "/api/offline/v2/control/ack", body)
	if err != nil {
		return err
	}
	var decoded struct {
		Success bool   `json:"success"`
		Error   string `json:"error"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return err
	}
	if !responseOK(statusCode, decoded.Success) {
		return fmt.Errorf("acknowledgement rejected (%d): %s", statusCode, decoded.Error)
	}
	return nil
}

func status(args []string) {
	_ = args
	p, store, err := loadProfile()
	check(err)
	bootHash, err := currentBootHash(p.TerminalID)
	check(err)
	now := time.Now().UTC()
	for _, accountID := range p.Accounts {
		var state accountState
		if err := store.Load(accountItem(accountID), &state); err != nil {
			fmt.Printf("%s: sin datos locales\n", accountID)
			continue
		}
		_, err := validateLocalAccess(p, &state, bootHash, now)
		if err != nil {
			fmt.Printf("%s: bloqueado (%v)\n", accountID, err)
		} else {
			fmt.Printf("%s: disponible hasta %s; %d recursos; %d operaciones pendientes\n", accountID, state.LeaseClaims.ExpiresAt.Format(time.RFC3339), len(state.Snapshots), len(state.Outbox))
		}
	}
}

func bootstrapStatus(args []string) {
	_ = args
	paths, err := filepath.Glob(filepath.Join(dataDir(), "profile-*.dpapi"))
	if err != nil {
		check(json.NewEncoder(os.Stdout).Encode(map[string]any{"state": localstate.BootstrapBlocked}))
		return
	}
	p, _, loadErr := loadProfile()
	valid := loadErr == nil
	state := localstate.ResolveBootstrapState(len(paths), valid, valid && p.PendingPublicKeyPEM != "", p.LeaseKeyVersion, len(p.Accounts))
	result := map[string]any{"state": state}
	if valid {
		result["terminal_id"] = p.TerminalID
	}
	check(json.NewEncoder(os.Stdout).Encode(result))
}

func localAccounts(args []string) {
	_ = args
	p, store, err := loadProfile()
	check(err)
	if p.PendingPublicKeyPEM != "" || p.LeaseKeyVersion < 1 || len(p.Accounts) == 0 {
		fatal("terminal enrollment is pending")
	}
	bootHash, err := currentBootHash(p.TerminalID)
	check(err)
	now := time.Now().UTC()
	type accountSummary struct {
		AccountID string     `json:"account_id"`
		Name      string     `json:"name"`
		Available bool       `json:"available"`
		ExpiresAt *time.Time `json:"expires_at,omitempty"`
		Resources int        `json:"resources"`
		Pending   int        `json:"pending"`
		Error     string     `json:"error,omitempty"`
	}
	result := make([]accountSummary, 0, len(p.Accounts))
	for _, accountID := range p.Accounts {
		summary := accountSummary{AccountID: accountID, Name: p.AccountLabels[accountID]}
		if summary.Name == "" {
			summary.Name = accountID
		}
		var state accountState
		if err := store.Load(accountItem(accountID), &state); err != nil {
			summary.Error = "sin datos locales sincronizados"
			result = append(result, summary)
			continue
		}
		claims, err := validateLocalAccess(p, &state, bootHash, now)
		if err != nil {
			summary.Error = err.Error()
			result = append(result, summary)
			continue
		}
		summary.Available, summary.ExpiresAt, summary.Resources, summary.Pending = true, &claims.ExpiresAt, len(state.Snapshots), len(state.Outbox)
		result = append(result, summary)
	}
	check(json.NewEncoder(os.Stdout).Encode(map[string]any{"accounts": result, "terminal_id": p.TerminalID}))
}

func localState(args []string) {
	fs := flag.NewFlagSet("local-state", flag.ExitOnError)
	accountID := fs.String("account", "", "approved account UUID")
	_ = fs.Parse(args)
	p, store, state := loadAccessibleAccount(*accountID)
	view := struct {
		AccountID         string                     `json:"account_id"`
		Modules           []string                   `json:"modules"`
		Actions           json.RawMessage            `json:"actions"`
		ExpiresAt         time.Time                  `json:"expires_at"`
		SelectionRevision int64                      `json:"selection_revision"`
		Inventory         []inventoryItem            `json:"inventory"`
		Snapshots         map[string]json.RawMessage `json:"snapshots"`
		Outbox            []operation                `json:"outbox"`
		OperationResults  []operationResult          `json:"operation_results"`
	}{AccountID: state.AccountID, Modules: state.LeaseClaims.Modules, Actions: state.LeaseClaims.Actions, ExpiresAt: state.LeaseClaims.ExpiresAt, SelectionRevision: state.SelectionRevision, Inventory: state.Inventory, Snapshots: state.Snapshots, Outbox: state.Outbox, OperationResults: state.OperationResults}
	_ = p
	_ = store
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(true)
	check(encoder.Encode(view))
}

func enqueue(args []string) {
	fs := flag.NewFlagSet("enqueue", flag.ExitOnError)
	accountID := fs.String("account", "", "approved account UUID")
	_ = fs.Parse(args)
	_, store, state := loadAccessibleAccount(*accountID)
	raw, err := io.ReadAll(io.LimitReader(os.Stdin, 1<<20+1))
	check(err)
	if len(raw) > 1<<20 {
		fatal("offline operation exceeds 1 MiB")
	}
	var pending operation
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&pending); err != nil {
		fatal("invalid offline operation: " + err.Error())
	}
	if pending.ClientOccurredAt.IsZero() {
		pending.ClientOccurredAt = time.Now().UTC()
	}
	if err := validateQueuedOperation(state, pending); err != nil {
		fatal(err.Error())
	}
	for _, queued := range state.Outbox {
		if queued.OperationID == pending.OperationID {
			fatal("operation id already exists in outbox")
		}
	}
	for _, result := range state.OperationResults {
		if result.OperationID == pending.OperationID {
			fatal("operation id already has a server receipt")
		}
	}
	if len(state.Outbox) >= 1000 {
		fatal("offline outbox limit reached; synchronize before adding more changes")
	}
	state.Outbox = append(state.Outbox, pending)
	currentSize, err := store.Size(accountItem(state.AccountID))
	check(err)
	projected := localStorageUsage() - currentSize + localstate.EstimatedBytes(state) + 16*1024
	if projected > state.LeaseClaims.MaxStorageBytes {
		fatal("offline storage quota exceeded")
	}
	check(store.Save(accountItem(state.AccountID), state))
	check(json.NewEncoder(os.Stdout).Encode(map[string]any{"success": true, "operation_id": pending.OperationID, "pending": len(state.Outbox)}))
}

func loadAccessibleAccount(accountID string) (profile, *securestore.Store, accountState) {
	if !localstate.ValidUUID(accountID) {
		fatal("approved account UUID is required")
	}
	p, store, err := loadProfile()
	check(err)
	if !contains(p.Accounts, accountID) {
		fatal("account is not approved for this terminal")
	}
	var state accountState
	check(store.Load(accountItem(accountID), &state))
	bootHash, err := currentBootHash(p.TerminalID)
	check(err)
	claims, err := validateLocalAccess(p, &state, bootHash, time.Now().UTC())
	check(err)
	state.LeaseClaims = claims
	return p, store, state
}

func validateQueuedOperation(state accountState, pending operation) error {
	if !localstate.ValidUUID(pending.OperationID) || !localstate.ValidUUID(pending.SelectionID) || !localstate.ValidUUID(pending.ResourceID) || len(pending.Patch) == 0 || !json.Valid(pending.Patch) {
		return errors.New("offline operation identity or patch is invalid")
	}
	if pending.BaseVersion < 0 || pending.ClientOccurredAt.After(time.Now().UTC().Add(5*time.Minute)) {
		return errors.New("offline operation version or time is invalid")
	}
	for _, dependency := range pending.DependsOn {
		if !localstate.ValidUUID(dependency) || dependency == pending.OperationID {
			return errors.New("offline operation dependency is invalid")
		}
	}
	var selected *inventoryItem
	for index := range state.Inventory {
		if state.Inventory[index].SelectionID == pending.SelectionID {
			selected = &state.Inventory[index]
			break
		}
	}
	if selected == nil || selected.Module != pending.Module || !contains(state.LeaseClaims.Modules, pending.Module) {
		return errors.New("offline operation is outside the signed selection")
	}
	allowed := false
	switch pending.Module {
	case "whiteboards":
		allowed = selected.ResourceType == "whiteboard" && selected.ResourceID == pending.ResourceID && pending.ResourceType == "whiteboard" && pending.OperationType == "whiteboard.update_scene"
	case "tasks":
		allowed = selected.ResourceType == "task_list" && pending.ResourceType == "task" && (pending.OperationType == "task.create" || pending.OperationType == "task.update_simple" || pending.OperationType == "task.complete")
	case "contacts":
		allowed = selected.ResourceType == "contact" && selected.ResourceID == pending.ResourceID && pending.ResourceType == "contact" && (pending.OperationType == "contact.update_identity" || pending.OperationType == "contact.add_observation" || pending.OperationType == "contact.assign_existing_tags")
	case "programs":
		allowed = selected.ResourceType == "program" && selected.ResourceID == pending.ResourceID && pending.ResourceType == "program" && (pending.OperationType == "program.set_attendance" || pending.OperationType == "program.add_participant_observation")
	}
	if !allowed {
		return errors.New("offline operation is not permitted for the selected resource")
	}
	permission := map[string]string{
		"whiteboard.update_scene": "edit_scene",
		"task.create":             "create", "task.update_simple": "edit_simple", "task.complete": "complete",
		"contact.update_identity": "edit_identity", "contact.add_observation": "add_observation", "contact.assign_existing_tags": "assign_existing_tags",
		"program.set_attendance": "attendance", "program.add_participant_observation": "add_participant_observation",
	}[pending.OperationType]
	var signedActions map[string]map[string]bool
	if permission == "" || json.Unmarshal(state.LeaseClaims.Actions, &signedActions) != nil || !signedActions[pending.Module][permission] {
		return errors.New("offline operation is disabled by the signed runtime policy")
	}
	if pending.OperationType == "task.create" && pending.BaseVersion != 0 {
		return errors.New("offline task creation must start at version zero")
	}
	return nil
}

func validateLocalAccess(p profile, state *accountState, bootHash string, now time.Time) (*protocol.LeaseClaims, error) {
	if !state.LastTrustedWall.IsZero() && now.Before(state.LastTrustedWall.Add(-2*time.Minute)) {
		return nil, errors.New("retroceso del reloj detectado; requiere sincronización online")
	}
	claims, err := protocol.ValidateLease(state.Lease, p.LeaseKeyVersion, p.LeasePublicKeyPEM, p.TerminalID, state.AccountID, bootHash, now)
	if err != nil {
		return nil, err
	}
	return claims, nil
}

func wipe(args []string) {
	_ = args
	p, store, err := loadProfile()
	check(err)
	check(wipeAccountCaches(store, p.Accounts))
	check(finalizeWipe(store, p.TerminalID))
	fmt.Println("local offline data erased by explicit local command")
}

func wipeAccountCaches(store *securestore.Store, accounts []string) error {
	for _, accountID := range accounts {
		if err := store.Delete(accountItem(accountID)); err != nil {
			return err
		}
	}
	return nil
}

func finalizeWipe(store *securestore.Store, terminalID string) error {
	if err := store.Delete(profileItem(terminalID)); err != nil {
		return err
	}
	script := `$name='ClarinOffline-` + terminalID + `';$provider=[System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider;try{$key=[System.Security.Cryptography.CngKey]::Open($name,$provider);$key.Delete();$key.Dispose()}catch{}`
	return command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
}

func signWithDeviceKey(p profile, canonical string) (string, error) {
	digest := protocol.RequestDigest(canonical)
	if p.PrivateKeyPKCS8 != "" {
		signature, err := deviceidentity.SignSoftware(p.PrivateKeyPKCS8, digest)
		if err != nil {
			return "", err
		}
		return base64.RawURLEncoding.EncodeToString(signature), nil
	}
	script := `$ErrorActionPreference='Stop';$name='ClarinOffline-` + p.TerminalID + `';$provider=[System.Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider;$key=[System.Security.Cryptography.CngKey]::Open($name,$provider);$k=[System.Security.Cryptography.ECDsaCng]::new($key);try{$h=[Convert]::FromBase64String('` + base64.StdEncoding.EncodeToString(digest) + `');$s=$k.SignHash($h);[Convert]::ToBase64String($s)}finally{$k.Dispose();$key.Dispose()}`
	value, err := outputErr("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
	if err != nil {
		return "", err
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(value))
	if err != nil {
		return "", errors.New("decode CNG signature")
	}
	signature, err := deviceidentity.NormalizeECDSASignature(raw)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(signature), nil
}

func currentBootHash(terminalID string) (string, error) {
	boot, err := outputErr("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('O')")
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(terminalID + ":" + strings.TrimSpace(boot)))
	return hex.EncodeToString(digest[:]), nil
}

func currentSID() string {
	return strings.TrimSpace(output("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"))
}

func validateWindowsCompatibility() {
	if runtime.GOARCH != "amd64" {
		fatal("Clarin Offline requires Windows 11 x64")
	}
	build := strings.TrimSpace(output("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "[Environment]::OSVersion.Version.Build"))
	value, err := strconv.Atoi(build)
	if err != nil || value < 22000 {
		fatal("Clarin Offline requires Windows 11 build 22000 or later")
	}
}

func collectDevicePosture() deviceposture.Report {
	report := deviceposture.Unknown()
	bitLocker, err := outputErr("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop';$v=Get-BitLockerVolume -MountPoint $env:SystemDrive;[int]$v.ProtectionStatus`)
	if err == nil {
		report.BitLocker = deviceposture.ParseBitLockerProtectionStatus(bitLocker)
	}
	hello, err := outputErr("dsregcmd.exe", "/status")
	if err == nil {
		report.WindowsHello = deviceposture.ParseWindowsHelloStatus(hello)
	}
	return report
}

func restrictDataDirectory(sid string) error {
	return command("icacls.exe", dataDir(), "/inheritance:r", "/grant:r", sid+":(OI)(CI)F", "/grant:r", "SYSTEM:(OI)(CI)F")
}

func dataDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "Clarin", "OfflineV2")
}

func mustStore(terminalID string) *securestore.Store {
	store, err := securestore.New(dataDir(), terminalID)
	check(err)
	return store
}

func loadProfile() (profile, *securestore.Store, error) {
	var p profile
	paths, err := filepath.Glob(filepath.Join(dataDir(), "profile-*.dpapi"))
	if err != nil || len(paths) != 1 {
		return p, nil, errors.New("exactly one enrolled terminal profile is required")
	}
	base := strings.TrimSuffix(filepath.Base(paths[0]), ".dpapi")
	terminalID := strings.TrimPrefix(base, "profile-")
	store, err := securestore.New(dataDir(), terminalID)
	if err != nil {
		return p, nil, err
	}
	if err := store.Load(profileItem(terminalID), &p); err != nil {
		return p, nil, err
	}
	if p.TerminalID != terminalID || protocol.ValidateHexHash(p.InstallInstanceHash) != nil {
		return p, nil, errors.New("offline profile identity rejected")
	}
	return p, store, nil
}

func profileItem(terminalID string) string { return "profile-" + terminalID }
func accountItem(accountID string) string  { return "account-" + accountID }

func localStorageUsage() int64 {
	entries, _ := filepath.Glob(filepath.Join(dataDir(), "*.dpapi"))
	var total int64
	for _, entry := range entries {
		if info, err := os.Stat(entry); err == nil {
			total += info.Size()
		}
	}
	return total
}

func requireHTTPS(server string) {
	if !strings.HasPrefix(strings.ToLower(server), "https://") {
		fatal("server must use HTTPS")
	}
}

func httpClient() *http.Client { return &http.Client{Timeout: 45 * time.Second} }

func readResponse(response *http.Response) ([]byte, error) {
	defer response.Body.Close()
	return io.ReadAll(io.LimitReader(response.Body, 64<<20))
}

func responseOK(statusCode int, success bool) bool {
	return statusCode >= 200 && statusCode < 300 && success
}

func command(name string, args ...string) error {
	cmd := exec.CommandContext(context.Background(), name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func output(name string, args ...string) string {
	value, err := outputErr(name, args...)
	check(err)
	return value
}

func outputErr(name string, args ...string) (string, error) {
	raw, err := exec.CommandContext(context.Background(), name, args...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s: %w", strings.TrimSpace(string(raw)), err)
	}
	return string(raw), nil
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func check(err error) {
	if err != nil {
		fatal(err.Error())
	}
}

func fatal(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
