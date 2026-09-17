//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/naperu/clarin-offline-agent/internal/v3/bridge"
	"github.com/naperu/clarin-offline-agent/internal/v3/engine"
	"github.com/naperu/clarin-offline-agent/internal/v3/principalpipe"
	"github.com/naperu/clarin-offline-agent/internal/v3/serviceprotect"
	"github.com/naperu/clarin-offline-agent/internal/v3/transport"
	"golang.org/x/sys/windows/svc"
)

const (
	serviceName = "ClarinOfflineV3"
	listenAddr  = "127.0.0.1:17373"
)

var (
	serviceVersion   = "3.0.0"
	configuredOrigin = "https://clarin.naperu.cloud"
)

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "console":
			ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
			defer stop()
			if err := runConsole(ctx); err != nil {
				fatal(err)
			}
			return
		case "selftest":
			if err := selftest(); err != nil {
				fatal(err)
			}
			return
		default:
			fatal(errors.New("unsupported service command"))
		}
	}
	if err := svc.Run(serviceName, serviceHandler{}); err != nil {
		fatal(errors.New("Windows service dispatcher failed"))
	}
}

type serviceHandler struct{}

func (serviceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	runtime, err := startRuntime(ctx)
	if err != nil {
		cancel()
		return true, 1
	}
	defer func() {
		cancel()
		runtime.close()
	}()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case err := <-runtime.failures:
			if err != nil {
				status <- svc.Status{State: svc.StopPending}
				return true, 2
			}
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				status <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				return false, 0
			}
		}
	}
}

type serviceRuntime struct {
	cancel   context.CancelFunc
	listener net.Listener
	server   *http.Server
	engine   *engine.Engine
	failures chan error
	once     sync.Once
	workers  sync.WaitGroup
}

func startRuntime(parent context.Context) (*serviceRuntime, error) {
	if err := validateOrigin(configuredOrigin); err != nil {
		return nil, err
	}
	protector, err := serviceprotect.NewWindowsProtector()
	if err != nil {
		return nil, err
	}
	dataRoot, err := serviceDataRoot()
	if err != nil {
		return nil, err
	}
	offlineEngine, err := engine.Open(dataRoot, configuredOrigin, serviceVersion, protector)
	if err != nil {
		return nil, err
	}
	runner, err := transport.New(offlineEngine)
	if err != nil {
		offlineEngine.Close()
		return nil, err
	}
	bridgeServer, err := bridge.NewWithSync(offlineEngine, bridge.SyncHooks{
		Trigger: runner.Trigger,
		Status: func(grantID string) bridge.SyncRuntimeStatus {
			status := runner.Status(grantID)
			return bridge.SyncRuntimeStatus{State: status.State, Reachability: status.Reachability, LastAttemptAt: status.LastAttemptAt,
				LastSuccessAt: status.LastSuccessAt, NextAttemptAt: status.NextAttemptAt, LastErrorCode: status.LastErrorCode, Retryable: status.Retryable}
		},
	})
	if err != nil {
		offlineEngine.Close()
		return nil, err
	}
	listener, err := net.Listen("tcp4", listenAddr)
	if err != nil {
		offlineEngine.Close()
		return nil, err
	}
	ctx, cancel := context.WithCancel(parent)
	runtime := &serviceRuntime{cancel: cancel, listener: listener, engine: offlineEngine, failures: make(chan error, 3)}
	runtime.server = &http.Server{
		Handler: bridgeServer, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second,
		WriteTimeout: 70 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10,
	}
	runtime.workers.Add(1)
	go func() {
		defer runtime.workers.Done()
		if err := runtime.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			runtime.fail(err)
		}
	}()
	runtime.workers.Add(1)
	go func() {
		defer runtime.workers.Done()
		runner.Run(ctx)
	}()
	runtime.workers.Add(1)
	go func() {
		defer runtime.workers.Done()
		offlineEngine.RunSessionReaper(ctx)
	}()
	helperPath, err := principalpipe.ExpectedHelperPath()
	if err != nil {
		runtime.close()
		return nil, err
	}
	runtime.workers.Add(1)
	go func() {
		defer runtime.workers.Done()
		if err := principalpipe.Serve(ctx, helperPath, offlineEngine.CompletePrincipalChallenge); err != nil && ctx.Err() == nil {
			runtime.fail(err)
		}
	}()
	return runtime, nil
}

func (r *serviceRuntime) fail(err error) {
	select {
	case r.failures <- err:
	default:
	}
}

func (r *serviceRuntime) close() {
	r.once.Do(func() {
		r.cancel()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = r.server.Shutdown(shutdown)
		_ = r.server.Close()
		_ = r.listener.Close()
		r.workers.Wait()
		_ = r.engine.Close()
	})
}

func runConsole(ctx context.Context) error {
	runtime, err := startRuntime(ctx)
	if err != nil {
		return err
	}
	defer runtime.close()
	select {
	case <-ctx.Done():
		return nil
	case err := <-runtime.failures:
		return err
	}
}

func selftest() error {
	requestID := "00000000-0000-4000-8000-000000000003"
	request, err := http.NewRequest(http.MethodGet, "http://"+listenAddr+"/v3/health", nil)
	if err != nil {
		return err
	}
	request.Header.Set("Origin", configuredOrigin)
	request.Header.Set("X-Clarin-Protocol", "3")
	request.Header.Set("X-Clarin-Request-ID", requestID)
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return errors.New("local service health unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Access-Control-Allow-Origin") != configuredOrigin || response.Header.Get("X-Clarin-Protocol") != "3" {
		return errors.New("local service security headers rejected")
	}
	// Health intentionally evolves with additive fields, so decode through a
	// map after proving it is valid JSON and check only the frozen essentials.
	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return errors.New("local service health payload rejected")
	}
	if payload["protocol"] != float64(3) || payload["service"] != "clarin-offline" {
		return errors.New("local service health payload rejected")
	}
	_, _ = fmt.Fprintln(os.Stdout, `{"protocol":3,"service":"clarin-offline","result":"pass"}`)
	return nil
}

func serviceDataRoot() (string, error) {
	programData := strings.TrimSpace(os.Getenv("ProgramData"))
	if programData == "" || !filepath.IsAbs(programData) {
		return "", errors.New("ProgramData is unavailable")
	}
	root := filepath.Join(programData, "Clarin", "Offline", "v3")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return "", err
	}
	return root, nil
}

func validateOrigin(raw string) error {
	if !strings.HasPrefix(raw, "https://") || strings.ContainsAny(strings.TrimPrefix(raw, "https://"), "/?#@") {
		return errors.New("configured Clarin origin rejected")
	}
	return nil
}

func fatal(_ error) {
	// Service errors intentionally avoid files/stdout containing paths, SIDs,
	// URLs, keys or user data. SCM records the non-zero service exit code.
	os.Exit(1)
}
