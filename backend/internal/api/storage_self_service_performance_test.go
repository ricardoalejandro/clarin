package api

// Opt-in synthetic capacity measurement against the same disposable native
// PostgreSQL and MinIO services as storage integration. This is not production
// usage telemetry, a browser benchmark, or an S3 transfer-throughput benchmark.
//
// CLARIN_RUN_STORAGE_SELF_SERVICE_PERFORMANCE=1
// CLARIN_STORAGE_PERF_OBJECTS=1000,10000,50000 (use one size for a fresh process)
// CLARIN_STORAGE_PERF_SAMPLES=10
// CLARIN_STORAGE_PERF_TEXT_RATIO=10
// CLARIN_STORAGE_PERF_CHATS=100 (clamped to the current object count)
//
// DATABASE_URL must still point to the runner's initial disposable database;
// the shared fixture creates and removes an independent database for this test.
import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"os"
	"runtime"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/storage"
)

const storagePerformanceObjectBytes = 1024

func storagePerformanceInt(t *testing.T, name string, fallback, min, max int) int {
	t.Helper()
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < min || n > max {
		t.Fatalf("%s must be an integer from %d to %d", name, min, max)
	}
	return n
}

func TestStorageSelfServicePerformance(t *testing.T) {
	if os.Getenv("CLARIN_RUN_STORAGE_SELF_SERVICE_PERFORMANCE") != "1" {
		t.Skip("requires explicit disposable native storage performance opt-in")
	}
	if os.Getenv("CLARIN_STORAGE_QA_PGLITE") == "1" {
		t.Fatal("performance measurements require native PostgreSQL 16, not PGlite")
	}
	if os.Getenv("MINIO_ENDPOINT") != storageQAMinioEndpoint(t) || !strings.HasPrefix(os.Getenv("MINIO_BUCKET"), "clarin-qa") {
		t.Fatal("disposable loopback MinIO and clarin-qa bucket required")
	}
	sizes := os.Getenv("CLARIN_STORAGE_PERF_OBJECTS")
	if sizes == "" {
		sizes = "1000,10000,50000"
	}
	samples := storagePerformanceInt(t, "CLARIN_STORAGE_PERF_SAMPLES", 10, 3, 100)
	textRatio := storagePerformanceInt(t, "CLARIN_STORAGE_PERF_TEXT_RATIO", 10, 0, 100)
	configuredChats := storagePerformanceInt(t, "CLARIN_STORAGE_PERF_CHATS", 100, 1, 1000)
	db := newFunctionalIntegrityIntegrationDB(t, "CLARIN_RUN_STORAGE_SELF_SERVICE_PERFORMANCE", "clarin_storage_perf_qa_")
	var version int
	if err := db.QueryRow(context.Background(), `SELECT current_setting('server_version_num')::int`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version < 160000 || version >= 170000 {
		t.Fatalf("expected PostgreSQL 16; server_version_num=%d", version)
	}
	store, err := storage.New(storage.Config{Endpoint: os.Getenv("MINIO_ENDPOINT"), AccessKey: os.Getenv("MINIO_ACCESS_KEY"), SecretKey: os.Getenv("MINIO_SECRET_KEY"), Bucket: os.Getenv("MINIO_BUCKET"), PublicURL: os.Getenv("MINIO_PUBLIC_URL")})
	if err != nil {
		t.Fatal("disposable QA storage unavailable")
	}
	t.Logf("STORAGE_PERF_ENV go=%s postgres_version_num=%d os=%s arch=%s cpu=%d gomaxprocs=%d samples=%d warmups=2 object_bytes=%d text_messages_per_object=%d configured_chats=%d", runtime.Version(), version, runtime.GOOS, runtime.GOARCH, runtime.NumCPU(), runtime.GOMAXPROCS(0), samples, storagePerformanceObjectBytes, textRatio, configuredChats)
	for _, raw := range strings.Split(sizes, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(raw))
		if err != nil || n < 40 || n > 50000 {
			t.Fatal("CLARIN_STORAGE_PERF_OBJECTS must contain comma-separated sizes from 40 to 50000")
		}
		t.Run(fmt.Sprintf("objects_%d", n), func(t *testing.T) {
			f := newStorageQAFixture(t, db, store)
			started := time.Now()
			chatCount := min(configuredChats, n)
			storagePerformanceSeed(t, f, n, textRatio, chatCount)
			foreign, _, _ := f.media(f.other, "chats", "foreign-performance-sentinel.pdf", true)
			objects, err := store.ListPrefix(context.Background(), f.account.String()+"/")
			if err != nil {
				t.Fatal(err)
			}
			var bytes int64
			for _, object := range objects {
				bytes += object.Size
			}
			if len(objects) != n || bytes != int64(n*storagePerformanceObjectBytes) {
				t.Fatalf("seed mismatch: objects=%d bytes=%d", len(objects), bytes)
			}
			objects = nil
			seedDuration := time.Since(started)

			indexStart := time.Now()
			indexCtx, indexCancel := context.WithTimeout(context.Background(), 10*time.Minute)
			indexErr := f.server.ReconcileStorageInventory(indexCtx, f.account)
			indexCancel()
			if indexErr != nil {
				t.Fatal(indexErr)
			}
			t.Logf("STORAGE_PERF_INDEX objects=%d duration_ms=%.3f", n, float64(time.Since(indexStart).Microseconds())/1000)
			storagePerformanceAnalyzeInventory(t, f)
			storagePerformanceExplainInventory(t, f, n)
			t.Logf("STORAGE_PERF_SEED objects=%d bytes=%d chat_media_references=%d text_messages=%d chats=%d other_account_objects=1 duration_ms=%.3f", n, bytes, n, n*textRatio, chatCount, float64(seedDuration.Microseconds())/1000)
			storagePerformanceTrackS3(t, f)
			lastOffset := (n - 1) / 40 * 40
			first := storagePerformanceRequest{path: "/storage/files?limit=40", total: n, files: 40}
			usage := storagePerformanceRequest{path: "/storage/usage", total: n, usage: true}
			scenarios := []struct {
				name     string
				requests []storagePerformanceRequest
				role     string
			}{
				{"files_first", []storagePerformanceRequest{first}, "member"},
				{"files_last", []storagePerformanceRequest{{path: fmt.Sprintf("/storage/files?limit=40&offset=%d", lastOffset), total: n, files: n - lastOffset}}, "member"},
				{"files_search", []storagePerformanceRequest{{path: "/storage/files?limit=40&q=storage-bench-000000.pdf", total: 1, files: 1}}, "member"},
				{"usage", []storagePerformanceRequest{usage}, "member"},
				{"page_open_parallel", []storagePerformanceRequest{usage, first}, "member"},
				{"files_first_admin", []storagePerformanceRequest{first}, "admin"},
				{"page_open_admin_parallel", []storagePerformanceRequest{usage, first}, "admin"},
			}
			for _, scenario := range scenarios {
				t.Run(scenario.name, func(t *testing.T) {
					// Membership changes occur outside timings. Handlers reload the
					// canonical role; synthetic claims intentionally remain stale.
					f.exec(`UPDATE user_accounts SET role=$3 WHERE account_id=$1 AND user_id=$2`, f.account, f.user, scenario.role)
					storagePerformanceMeasure(t, f, scenario.name, scenario.requests, n, samples, textRatio, chatCount, foreign)
				})
			}
		})
	}
	storagePerformanceSharedReferences(t, db, store, samples)
}

func storagePerformanceTrackS3(t *testing.T, f *storageQAFixture) {
	counter := &atomic.Int64{}
	_, store := storageQAProxy(t, func(proxy *httputil.ReverseProxy) {
		original := proxy.Director
		proxy.Director = func(r *http.Request) { counter.Add(1); original(r) }
	})
	f.server.storage = store
	counter.Store(0)
	f.inventoryS3Requests = counter
}

func storagePerformanceAnalyzeInventory(t *testing.T, f *storageQAFixture) {
	t.Helper()
	// The fixture inserts a full account in one burst. Explicit statistics keep
	// query planning independent of autovacuum's timing, outside measurements.
	for _, table := range []string{"storage_inventory_objects", "storage_inventory_sources", "storage_inventory_references", "storage_inventory_totals", "storage_inventory_backfill", "storage_inventory_scans"} {
		f.exec("ANALYZE " + table)
	}
}

func storagePerformanceFilename(i int) string { return fmt.Sprintf("storage-bench-%06d.pdf", i) }

func storagePerformancePayload(i int) []byte {
	payload := make([]byte, storagePerformanceObjectBytes)
	copy(payload, fmt.Sprintf("%%PDF-1.7\n%% Synthetic inventory benchmark object %d; not a preview fixture.\n", i))
	return payload
}

func storagePerformanceSeed(t *testing.T, f *storageQAFixture, n, textRatio, chatCount int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := f.db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	// Upload real bytes with bounded parallelism; all keys belong to this test's
	// newly-created account. The fixture removes only these synthetic prefixes.
	const workers = 16
	failures := make(chan error, workers)
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := worker; i < n; i += workers {
				key := f.account.String() + "/chats/" + storagePerformanceFilename(i)
				if _, err := f.store.UploadObject(ctx, key, storagePerformancePayload(i), "application/pdf"); err != nil {
					failures <- err
					cancel()
					return
				}
			}
		}(worker)
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Fatalf("synthetic object upload failed: %v", err)
	}
	// Deterministic round-robin distribution keeps real Chat -> Contact parent
	// relationships and avoids concentrating hundreds of thousands of messages
	// in one conversation merely to prepare a storage read benchmark.
	chats := make([]uuid.UUID, chatCount)
	contactRows, chatRows := make([][]any, chatCount), make([][]any, chatCount)
	for i := range chats {
		contact := uuid.NewSHA1(f.account, []byte(fmt.Sprintf("storage-perf-contact-%d", i)))
		chats[i] = uuid.NewSHA1(f.account, []byte(fmt.Sprintf("storage-perf-chat-%d", i)))
		jid := contact.String() + "@test.invalid"
		contactRows[i] = []any{contact, f.account, jid, fmt.Sprintf("Synthetic performance contact %d", i)}
		chatRows[i] = []any{chats[i], f.account, jid, contact}
	}
	for _, batch := range []struct {
		table   string
		columns []string
		rows    [][]any
	}{
		{"contacts", []string{"id", "account_id", "jid", "name"}, contactRows},
		{"chats", []string{"id", "account_id", "jid", "contact_id"}, chatRows},
	} {
		count, err := f.db.CopyFrom(ctx, pgx.Identifier{batch.table}, batch.columns, pgx.CopyFromRows(batch.rows))
		if err != nil || count != int64(chatCount) {
			t.Fatalf("%s seed count=%d expected=%d error=%v", batch.table, count, chatCount, err)
		}
	}
	i := 0
	count, err := f.db.CopyFrom(ctx, pgx.Identifier{"media_assets"}, []string{"account_id", "content_hash", "object_key", "media_type", "content_type", "filename", "size_bytes"}, pgx.CopyFromFunc(func() ([]any, error) {
		if i == n {
			return nil, nil
		}
		filename := storagePerformanceFilename(i)
		hash := fmt.Sprintf("%x", sha256.Sum256(storagePerformancePayload(i)))
		i++
		return []any{f.account, hash, f.account.String() + "/chats/" + filename, "document", "application/pdf", filename, int64(storagePerformanceObjectBytes)}, nil
	}))
	if err != nil || count != int64(n) {
		t.Fatalf("asset seed count=%d expected=%d error=%v", count, n, err)
	}
	// COPY and these INSERTs retain every production FK and reference trigger.
	exec(`INSERT INTO storage_objects(account_id,object_key,media_type,content_type,filename,size_bytes,source) SELECT account_id,object_key,media_type,content_type,filename,size_bytes,'whatsapp' FROM media_assets WHERE account_id=$1`, f.account)
	// Each message fires the production attention trigger. Bounded transactions
	// limit the chain of Chat row versions during one INSERT. Every trigger,
	// message and reference remains active; no replication-role bypass is used.
	const messageBatch = 1000
	for start := 0; start < n; start += messageBatch {
		end := min(start+messageBatch, n)
		lower := f.account.String() + "/chats/" + storagePerformanceFilename(start)
		upper := f.account.String() + "/chats/" + storagePerformanceFilename(end)
		exec(`INSERT INTO messages(account_id,chat_id,message_id,body,message_type,media_url,media_mimetype,media_filename,media_size,media_asset_id,timestamp) SELECT account_id,($2::uuid[])[1+mod(split_part(split_part(filename,'-',3),'.',1)::int,$5::int)],'perf-media-'||id::text,'Synthetic performance message','document','/api/media/file/'||object_key,content_type,filename,size_bytes,id,NOW() FROM media_assets WHERE account_id=$1 AND object_key >= $3::text AND object_key < $4::text`, f.account, chats, lower, upper, chatCount)
	}
	for start := 1; start <= n*textRatio; start += messageBatch {
		end := min(start+messageBatch-1, n*textRatio)
		exec(`INSERT INTO messages(account_id,chat_id,message_id,body,message_type,timestamp) SELECT $1::uuid,($2::uuid[])[1+mod(g-1,$5::int)],'perf-text-'||g::text,'Synthetic message without media','text',NOW() FROM generate_series($3::int,$4::int) g`, f.account, chats, start, end, chatCount)
	}
	var totalMessages, mediaMessages int
	if err := f.db.QueryRow(ctx, `SELECT COUNT(*),COUNT(media_asset_id) FROM messages WHERE account_id=$1`, f.account).Scan(&totalMessages, &mediaMessages); err != nil {
		t.Fatal(err)
	}
	if totalMessages != n*(1+textRatio) || mediaMessages != n {
		t.Fatalf("message seed mismatch: total=%d media=%d expected=%d/%d", totalMessages, mediaMessages, n*(1+textRatio), n)
	}
	rows, err := f.db.Query(ctx, `SELECT chat_id,COUNT(*),COUNT(media_asset_id) FROM messages WHERE account_id=$1 GROUP BY chat_id`, f.account)
	if err != nil {
		t.Fatal(err)
	}
	expected := make(map[uuid.UUID][2]int, chatCount)
	for i, chat := range chats {
		media, texts := n/chatCount, n*textRatio/chatCount
		if i < n%chatCount {
			media++
		}
		if i < n*textRatio%chatCount {
			texts++
		}
		expected[chat] = [2]int{media + texts, media}
	}
	for rows.Next() {
		var chat uuid.UUID
		var total, media int
		if err := rows.Scan(&chat, &total, &media); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		if want, ok := expected[chat]; !ok || want != [2]int{total, media} {
			rows.Close()
			t.Fatal("message seed did not preserve deterministic per-chat distribution")
		}
		delete(expected, chat)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(expected) != 0 {
		t.Fatalf("incomplete chat distribution: missing=%d error=%v", len(expected), err)
	}
	for _, table := range []string{"messages", "media_assets", "storage_objects", "chats", "contacts"} {
		exec("ANALYZE " + table)
	}
}

type storagePerformanceRequest struct {
	path         string
	total, files int
	references   int
	usage        bool
	uses         bool
}

type storagePerformanceResponse struct {
	status int
	body   []byte
	err    error
}

// Uses real handlers, PostgreSQL queries and S3 calls. Synthetic identity is the
// sole auth shortcut; no login or external HTTP network is included in timings.
func storagePerformanceCall(f *storageQAFixture, requests []storagePerformanceRequest) []storagePerformanceResponse {
	responses := make([]storagePerformanceResponse, len(requests))
	var wg sync.WaitGroup
	for i, req := range requests {
		wg.Add(1)
		go func(i int, req storagePerformanceRequest) {
			defer wg.Done()
			res, err := f.app.Test(httptest.NewRequest("GET", req.path, nil), 60000)
			if err != nil {
				responses[i].err = err
				return
			}
			defer res.Body.Close()
			responses[i].status = res.StatusCode
			responses[i].body, responses[i].err = io.ReadAll(res.Body)
		}(i, req)
	}
	wg.Wait()
	return responses
}

func storagePerformanceValidate(t *testing.T, f *storageQAFixture, requests []storagePerformanceRequest, responses []storagePerformanceResponse, foreign string) int {
	t.Helper()
	bytes := 0
	for i, res := range responses {
		if res.err != nil || res.status != 200 {
			t.Fatalf("performance request %s failed: status=%d error=%v", requests[i].path, res.status, res.err)
		}
		bytes += len(res.body)
		if strings.Contains(string(res.body), foreign) || strings.Contains(string(res.body), f.other.String()) {
			t.Fatal("foreign account data in performance response")
		}
		var data struct {
			Success      bool                     `json:"success"`
			Total        int                      `json:"total"`
			Files        []storageSelfServiceFile `json:"files"`
			ObjectCount  int                      `json:"object_count"`
			VisibleBytes int64                    `json:"visible_bytes"`
			Uses         []storageSelfServiceUse  `json:"uses"`
			HasMore      bool                     `json:"has_more"`
			NextCursor   string                   `json:"next_cursor"`
		}
		if err := json.Unmarshal(res.body, &data); err != nil || !data.Success {
			t.Fatalf("invalid performance response: %v", err)
		}
		want := requests[i]
		if want.uses {
			if data.Total != want.total || len(data.Uses) != want.files || !data.HasMore || data.NextCursor == "" {
				t.Fatalf("uses mismatch: total=%d uses=%d has_more=%v expected=%d/%d", data.Total, len(data.Uses), data.HasMore, want.total, want.files)
			}
			seen := map[string]bool{}
			for _, use := range data.Uses {
				if use.Type != "chats" || use.UseID == "" || !use.CanRemove || seen[use.UseID] {
					t.Fatal("incorrect or repeated business use in benchmark page")
				}
				seen[use.UseID] = true
			}
		} else if want.usage {
			if data.ObjectCount != want.total || data.VisibleBytes != int64(want.total*storagePerformanceObjectBytes) {
				t.Fatalf("usage mismatch: count=%d bytes=%d", data.ObjectCount, data.VisibleBytes)
			}
		} else {
			if data.Total != want.total || len(data.Files) != want.files {
				t.Fatalf("files mismatch: total=%d files=%d expected=%d/%d", data.Total, len(data.Files), want.total, want.files)
			}
			for _, file := range data.Files {
				expectedRefs := want.references
				if expectedRefs == 0 {
					expectedRefs = 1
				}
				if len(file.Origins) > 6 || (expectedRefs > 6 && !file.HasMoreUses) {
					t.Fatal("unbounded or incomplete shared-use summary")
				}
				if !strings.HasPrefix(file.ObjectKey, f.account.String()+"/") || file.SizeBytes != storagePerformanceObjectBytes || !file.CanRemove || file.ReferencesCount != expectedRefs {
					t.Fatal("incorrect account, bytes, eligibility or reference count in benchmark inventory")
				}
			}
		}
	}
	return bytes
}

func storagePerformanceQuantiles(values []float64) map[string]float64 {
	values = append([]float64(nil), values...)
	sort.Float64s(values)
	return map[string]float64{"p50": values[int(math.Ceil(float64(len(values))*.50))-1], "p95": values[int(math.Ceil(float64(len(values))*.95))-1], "max": values[len(values)-1]}
}

func storagePerformanceRSS() uint64 {
	data, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(data))
	if len(fields) < 2 {
		return 0
	}
	pages, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0
	}
	return pages * uint64(os.Getpagesize())
}

func storagePerformanceMeasure(t *testing.T, f *storageQAFixture, scenario string, requests []storagePerformanceRequest, n, samples, textRatio, chatCount int, foreign string) {
	t.Helper()
	var actorRole string
	if err := f.db.QueryRow(context.Background(), `SELECT role FROM user_accounts WHERE account_id=$1 AND user_id=$2`, f.account, f.user).Scan(&actorRole); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		storagePerformanceValidate(t, f, requests, storagePerformanceCall(f, requests), foreign)
	}
	debug.FreeOSMemory()
	latency, allocations, allocCounts := make([]float64, 0, samples), make([]float64, 0, samples), make([]float64, 0, samples)
	var pauses uint64
	var collections uint32
	responseBytes := 0
	s3Before := int64(0)
	if f.inventoryS3Requests != nil {
		s3Before = f.inventoryS3Requests.Load()
	}
	for i := 0; i < samples; i++ {
		var before, after runtime.MemStats
		runtime.ReadMemStats(&before)
		started := time.Now()
		responses := storagePerformanceCall(f, requests)
		elapsed := time.Since(started)
		runtime.ReadMemStats(&after)
		latency = append(latency, float64(elapsed.Microseconds())/1000)
		allocations = append(allocations, float64(after.TotalAlloc-before.TotalAlloc))
		allocCounts = append(allocCounts, float64(after.Mallocs-before.Mallocs))
		pauses += after.PauseTotalNs - before.PauseTotalNs
		collections += after.NumGC - before.NumGC
		// Validation is deliberately outside timing and allocation measurements.
		responseBytes = storagePerformanceValidate(t, f, requests, responses, foreign)
	}
	// Separate extra request for sampled memory; the observer does not perturb
	// the latency/allocation samples. RSS is this Go process only, excluding
	// PostgreSQL and MinIO. Peaks are sampled at 10 ms and may miss brief spikes.
	debug.FreeOSMemory()
	var baseline runtime.MemStats
	runtime.ReadMemStats(&baseline)
	baselineRSS := storagePerformanceRSS()
	peakHeap, peakRSS := baseline.HeapAlloc, baselineRSS
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				var m runtime.MemStats
				runtime.ReadMemStats(&m)
				if m.HeapAlloc > peakHeap {
					peakHeap = m.HeapAlloc
				}
				if rss := storagePerformanceRSS(); rss > peakRSS {
					peakRSS = rss
				}
			case <-stop:
				return
			}
		}
	}()
	responses := storagePerformanceCall(f, requests)
	close(stop)
	<-done
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	if after.HeapAlloc > peakHeap {
		peakHeap = after.HeapAlloc
	}
	if rss := storagePerformanceRSS(); rss > peakRSS {
		peakRSS = rss
	}
	storagePerformanceValidate(t, f, requests, responses, foreign)
	if f.inventoryS3Requests != nil && f.inventoryS3Requests.Load() != s3Before {
		t.Fatal("inventory request contacted S3 during performance measurements")
	}
	referencesPerObject := 1
	for _, request := range requests {
		if request.references > referencesPerObject {
			referencesPerObject = request.references
		}
	}
	result := map[string]any{
		"s3_requests_during_measurements": 0, "scenario": scenario, "objects": n, "samples": samples, "requests_per_sample": len(requests),
		"actor_role": actorRole,
		"chats":      chatCount, "references_per_object": referencesPerObject, "text_messages_per_object": textRatio, "object_bytes": storagePerformanceObjectBytes,
		"latency_ms": storagePerformanceQuantiles(latency), "allocated_bytes_per_sample": storagePerformanceQuantiles(allocations), "allocations_per_sample": storagePerformanceQuantiles(allocCounts),
		"gc_collections": collections, "gc_pause_ms": float64(pauses) / 1e6, "response_bytes_last_sample": responseBytes,
		"memory_extra_samples": 1, "memory_sampling_ms": 10, "baseline_heap_bytes": baseline.HeapAlloc, "sampled_peak_heap_bytes": peakHeap,
		"baseline_rss_bytes": baselineRSS, "sampled_peak_rss_bytes": peakRSS, "rss_available": baselineRSS > 0,
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("STORAGE_PERF %s", encoded)
}
