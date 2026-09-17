//go:build windows

package principalpipe

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const Name = `\\.\pipe\ClarinOfflineV3Principal`

var impersonateNamedPipeClient = windows.NewLazySystemDLL("advapi32.dll").NewProc("ImpersonateNamedPipeClient")

type CompleteFunc func(ctx context.Context, challengeID, windowsSID, displayName string) error

type infrastructureError struct{ err error }

func (e *infrastructureError) Error() string { return e.err.Error() }
func (e *infrastructureError) Unwrap() error { return e.err }

// Serve accepts only local authenticated users at the pipe ACL, resolves the
// actual client PID/token, and additionally pins the executable to the helper
// installed beside the service. JavaScript never supplies a SID.
func Serve(ctx context.Context, expectedHelperPath string, complete CompleteFunc) error {
	var err error
	expectedHelperPath, err = filepath.Abs(expectedHelperPath)
	if err != nil || strings.TrimSpace(expectedHelperPath) == "" || complete == nil {
		return errors.New("principal helper configuration rejected")
	}
	for ctx.Err() == nil {
		if err := serveOne(ctx, expectedHelperPath, complete); err != nil && ctx.Err() == nil {
			var infrastructure *infrastructureError
			if errors.As(err, &infrastructure) {
				return err
			}
			// Authentication, malformed input and stale/unknown challenges belong
			// to one untrusted client. They must never take down the service's
			// principal listener for every other Windows user.
			timer := time.NewTimer(25 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return nil
			case <-timer.C:
			}
		}
	}
	return nil
}

func serveOne(ctx context.Context, expectedHelperPath string, complete CompleteFunc) error {
	name, _ := windows.UTF16PtrFromString(Name)
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;LS)(A;;GRGW;;;AU)")
	if err != nil {
		return &infrastructureError{err}
	}
	sa := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	handle, err := windows.CreateNamedPipe(name, windows.PIPE_ACCESS_DUPLEX, windows.PIPE_TYPE_MESSAGE|windows.PIPE_READMODE_MESSAGE|windows.PIPE_WAIT|windows.PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 5000, sa)
	if err != nil {
		return &infrastructureError{err}
	}
	defer windows.CloseHandle(handle)
	err = pipeCall(ctx, handle, 0, func() error { return windows.ConnectNamedPipe(handle, nil) })
	if err != nil && !errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
		if ctx.Err() != nil || errors.Is(err, windows.ERROR_OPERATION_ABORTED) {
			return ctx.Err()
		}
		return &infrastructureError{err}
	}
	defer windows.DisconnectNamedPipe(handle)
	pid, sid, displayName, err := authenticatedClient(handle, expectedHelperPath)
	if err != nil || pid == 0 || sid == "" {
		return errors.New("principal helper authentication failed")
	}
	buffer := make([]byte, 128)
	var read uint32
	if err := pipeCall(ctx, handle, 5*time.Second, func() error { return windows.ReadFile(handle, buffer, &read, nil) }); err != nil || read == 0 || read > 64 {
		return errors.New("principal helper request rejected")
	}
	challengeID := strings.TrimSpace(string(buffer[:read]))
	if len(challengeID) != 36 || strings.ToLower(challengeID) != challengeID {
		return errors.New("principal helper challenge rejected")
	}
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := complete(callCtx, challengeID, sid, displayName); err != nil {
		return err
	}
	response := []byte("ok\n")
	var written uint32
	if err := pipeCall(ctx, handle, 5*time.Second, func() error { return windows.WriteFile(handle, response, &written, nil) }); err != nil || written != uint32(len(response)) {
		return errors.New("principal helper response failed")
	}
	_ = windows.FlushFileBuffers(handle)
	return nil
}

// pipeCall keeps synchronous named-pipe I/O cancellable. In particular, a
// client that connects and then sends no bytes cannot hold the only listener
// forever, and service shutdown cannot hang behind ReadFile.
func pipeCall(ctx context.Context, handle windows.Handle, timeout time.Duration, call func() error) error {
	done := make(chan struct{})
	watcherDone := make(chan struct{})
	var timer *time.Timer
	var timeoutC <-chan time.Time
	if timeout > 0 {
		timer = time.NewTimer(timeout)
		timeoutC = timer.C
	}
	go func() {
		defer close(watcherDone)
		select {
		case <-ctx.Done():
			_ = windows.CancelIoEx(handle, nil)
		case <-timeoutC:
			_ = windows.CancelIoEx(handle, nil)
		case <-done:
		}
	}()
	err := call()
	if timer != nil {
		timer.Stop()
	}
	close(done)
	<-watcherDone
	return err
}

func authenticatedClient(pipe windows.Handle, expectedHelperPath string) (uint32, string, string, error) {
	// A LocalService process is not guaranteed PROCESS_QUERY access to an
	// arbitrary interactive user's process. Impersonate only on this pinned OS
	// thread and only long enough to inspect the kernel-supplied client PID,
	// executable path and TokenUser. The caller performs every catalog/DPAPI
	// operation after this function has synchronously reverted.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	result, _, callErr := impersonateNamedPipeClient.Call(uintptr(pipe))
	if result == 0 {
		return 0, "", "", fmt.Errorf("named pipe impersonation failed: %w", callErr)
	}
	reverted := false
	defer func() {
		if !reverted {
			if err := windows.RevertToSelf(); err != nil {
				// Never return an impersonated OS thread to Go's scheduler or run
				// catalog/DPAPI work under the caller token. There is no safe
				// recovery inside this process if the final revert fails.
				os.Exit(120)
			}
		}
	}()
	revert := func() error {
		if err := windows.RevertToSelf(); err != nil {
			return err
		}
		reverted = true
		return nil
	}

	var pid uint32
	if err := windows.GetNamedPipeClientProcessId(pipe, &pid); err != nil || pid == 0 {
		return 0, "", "", errors.New("named pipe client PID unavailable")
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return 0, "", "", err
	}
	defer windows.CloseHandle(process)
	pathBuffer := make([]uint16, 32768)
	pathSize := uint32(len(pathBuffer))
	if err := windows.QueryFullProcessImageName(process, 0, &pathBuffer[0], &pathSize); err != nil {
		return 0, "", "", err
	}
	actualPath := filepath.Clean(windows.UTF16ToString(pathBuffer[:pathSize]))
	if !strings.EqualFold(actualPath, filepath.Clean(expectedHelperPath)) {
		return 0, "", "", fmt.Errorf("unexpected principal helper image")
	}
	thread, err := windows.GetCurrentThread()
	if err != nil {
		return 0, "", "", err
	}
	var token windows.Token
	if err := windows.OpenThreadToken(thread, windows.TOKEN_QUERY, true, &token); err != nil {
		return 0, "", "", err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil || user == nil || user.User.Sid == nil {
		return 0, "", "", errors.New("named pipe client SID unavailable")
	}
	sid := user.User.Sid.String()
	displayName := "Usuario de Windows"
	if account, domain, _, lookupErr := user.User.Sid.LookupAccount(""); lookupErr == nil {
		if domain != "" {
			displayName = domain + `\` + account
		} else if account != "" {
			displayName = account
		}
	}
	if err := revert(); err != nil {
		return 0, "", "", errors.New("named pipe impersonation revert failed")
	}
	return pid, sid, displayName, nil
}

func Complete(challengeID string) error {
	name, _ := windows.UTF16PtrFromString(Name)
	deadline := time.Now().Add(10 * time.Second)
	var handle windows.Handle
	var err error
	for time.Now().Before(deadline) {
		handle, err = windows.CreateFile(name, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, 0, 0)
		if err == nil {
			break
		}
		if !errors.Is(err, windows.ERROR_PIPE_BUSY) {
			return err
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	request := []byte(challengeID + "\n")
	var written uint32
	if err := windows.WriteFile(handle, request, &written, nil); err != nil || written != uint32(len(request)) {
		return errors.New("principal helper write failed")
	}
	buffer := make([]byte, 16)
	var read uint32
	if err := windows.ReadFile(handle, buffer, &read, nil); err != nil || strings.TrimSpace(string(buffer[:read])) != "ok" {
		return errors.New("principal helper was rejected")
	}
	return nil
}

func ExpectedHelperPath() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Join(filepath.Dir(executable), "clarin-offline-principal.exe"), nil
}
