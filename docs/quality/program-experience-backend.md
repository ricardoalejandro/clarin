# Program experience: backend verification

The Program photo and lifecycle integration tests require disposable PostgreSQL
and MinIO services. They create synthetic accounts and run the real startup
`database.Migrate` path. Do not point these tests at production services or load
the production `.env`.

## Isolated environment

Start fresh PostgreSQL 16 and MinIO containers with unique task names, bounded
memory/CPU, no production volumes and ports bound to `127.0.0.1`. Use Docker's
automatic networking rather than a manually chosen subnet. Create the database
with the exact name `program_survey_integrity_test`.

Provide these environment variables privately to the test process:

| Variable | Required value |
| --- | --- |
| `INTEGRITY_TEST_DATABASE_URL` | PostgreSQL URL to the disposable `127.0.0.1` service and `program_survey_integrity_test` database |
| `CLARIN_RUN_CONTACT_MEDIA_INTEGRATION` | `1` |
| `CLARIN_STORAGE_QA_MINIO_PORT` | The disposable MinIO loopback port, an integer between 1024 and 65535 |
| `MINIO_ENDPOINT` | `127.0.0.1:` followed by that same port |
| `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | Credentials generated only for this disposable MinIO instance |
| `MINIO_BUCKET` | A test-only bucket name |
| `GOCACHE` | `/tmp/go-build` |
| `GOMAXPROCS` | `2` for a bounded run on a shared VPS |

Run these commands sequentially from `backend` (the packages share migration
fixtures):

```sh
go test ./internal/repository -run 'TestProgram(Experience|Lifecycle|Closure|Creation|Avatar)' -count=1 -v
go test ./internal/api -run TestProgramAvatarHTTPRoundtrip -count=1 -v
go test ./internal/repository -run TestContactAvatar -count=1 -v
```

`TestProgramExperienceMigrationIsRepeatable` runs startup migrations again after
the fixture's first migration. The tests cover account isolation, mandatory
versions, completion/archive/restore, preservation of participant dates and
attendance, blocked creation after a concurrent conclusion, photo revision
conflicts, quota preservation, shared-reference garbage collection, failed
attachment tracking, concurrent writers, HTTP image normalization and protected
storage inventory access.

For the general suite, remove `INTEGRITY_TEST_DATABASE_URL` and
`CLARIN_RUN_CONTACT_MEDIA_INTEGRATION` from that process's environment:

```sh
GOCACHE=/tmp/go-build go test -json ./... > backend-tests.jsonl
go build -buildvcs=false ./...
git diff --check
```

`-buildvcs=false` is appropriate for an exported test checkout whose `.git`
worktree metadata is unavailable to the build; a normal checkout can use
`go build ./...`. The general suite intentionally skips tests requiring other
explicitly provisioned integration services; the targeted commands above prove
these Program changes against real PostgreSQL and MinIO.

## Verified on 2026-10-18

- General Go suite: 1,997 passing test/subtest events, 145 explicit integration
  skips, 17 passing packages, no failures.
- Program integration: 7 repository tests and 1 HTTP integration test passed.
- Shared Contact avatar regression: 8 tests passed, including physical cleanup,
  reuse, restoration and failed-attachment tracking.
- `go build -buildvcs=false ./...` and `git diff --check` passed.

After verification, remove only the test containers and their disposable
volumes. Keep logs in the task-private QA directory; do not commit credentials
or raw fixture data. This verification does not constitute a production deploy.
