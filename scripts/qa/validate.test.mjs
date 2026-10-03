import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = readFileSync(new URL('./validate.sh', import.meta.url), 'utf8');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t, { goVersion = '1.25.11', failBackend = false } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'clarin-qa-command-'));
  const root = join(workspace, 'clarin');
  const bin = join(workspace, 'bin');
  const calls = join(workspace, 'calls.log');
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  function write(path, content, executable = false) {
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, content, { mode: executable ? 0o755 : 0o644 });
  }
  write(join(root, 'scripts/qa/validate.sh'), script);
  write(join(root, 'backend/go.mod'), 'module qa-backend\ngo 1.25.0\ntoolchain go1.25.11\n');
  write(join(root, 'offline-signer/go.mod'), 'module qa-signer\ngo 1.25.0\n');
  write(join(root, 'tests/chat-attention.spec.ts'), '// fixture');
  write(join(root, 'tests/offline-v4-shell.spec.ts'), '// dedicated offline fixture');
  write(join(root, 'tests/whiteboards-live-smoke.spec.ts'), '// live fixture');
  write(join(root, 'tests/example.spec.ts'), '// example fixture');
  for (const name of ['next', 'tsc', 'vitest']) write(join(root, `frontend/node_modules/.bin/${name}`), '#!/bin/bash\nexit 0\n', true);
  write(join(root, 'node_modules/@playwright/test/package.json'), '{"type":"module","exports":"./index.js"}');
  write(join(root, 'node_modules/@playwright/test/index.js'), "const browser = { executablePath: () => '/missing-qa-browser' }; export const chromium = browser, firefox = browser, webkit = browser;\n");
  write(join(bin, 'node'), `#!/bin/bash
if [[ "$1" == --test ]]; then
  printf 'node|%s\\n' "$*" >> ${quote(calls)}
  exit 0
fi
exec ${quote(process.execPath)} "$@"
`, true);
  write(join(bin, 'npm'), `#!/bin/bash
printf 'npm|%s\\n' "$*" >> ${quote(calls)}
if [[ "$*" == '--prefix frontend run test:unit' && -n "\${NEXT_PUBLIC_API_URL:-}" ]]; then exit 9; fi
`, true);
  write(join(bin, 'git'), `#!/bin/bash\nprintf 'git|%s\\n' "$*" >> ${quote(calls)}\n`, true);
  // A broken PATH executable must never win over the managed workspace toolchain.
  write(join(bin, 'go'), '#!/bin/bash\nexit 99\n', true);
  write(join(workspace, '.tools/go/bin/go'), `#!/bin/bash
if [[ "$1" == version ]]; then printf 'go version go${goVersion} linux/amd64\\n'; exit 0; fi
for name in CLARIN_RUN_ARBITRARY_TEST CLARIN_RUN_DATABASE_TEST CLARIN_LIVE_REPORT_TEST CLARIN_TEST_OFFICIAL_EXCALIDRAW_LIBRARY OFFLINE_V3_TEST_DATABASE_URL OFFLINE_V4_TEST_DATABASE_URL OFFLINE_V5_TEST_DATABASE_URL; do
  [[ ! -v "$name" ]] || exit 98
done
printf 'go|%s|%s|%s|%s|%s|%s\\n' "$PWD" "$*" "$GOCACHE" "$GOMODCACHE" "$GOPATH" "$GOTOOLCHAIN" >> ${quote(calls)}
${failBackend ? '[[ "$PWD" != */backend ]] || exit 7' : 'exit 0'}
`, true);
  write(join(root, 'node_modules/.bin/playwright'), `#!/bin/bash
${quote(process.execPath)} --input-type=module - "$@" <<'NODE'
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: process.argv.slice(2), env: Object.fromEntries(['CI', 'PLAYWRIGHT_LOCAL_SERVER', 'PLAYWRIGHT_BASE_URL', 'CLARIN_E2E_BASE_URL', 'CLARIN_E2E_MOCK_AUTH', 'NEXT_PUBLIC_API_URL', 'CLARIN_E2E_LIVE', 'CLARIN_E2E_LIVE_OFFLINE', 'CLARIN_E2E_LIVE_WHITEBOARDS', 'CLARIN_E2E_USERNAME', 'CLARIN_E2E_PASSWORD'].map(name => [name, process.env[name]])) }) + '\\n');
NODE
`, true);
  const run = (args, env = {}) => spawnSync('bash', [join(root, 'scripts/qa/validate.sh'), ...args], {
    cwd: workspace,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    encoding: 'utf8',
  });
  return { run, workspace, root, calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] };
}

test('check reads prerequisites without executing tests or creating caches', t => {
  const f = fixture(t);
  const result = f.run(['check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Go: 1\.25\.11/);
  assert.match(result.stdout, /not installed \(optional for baseline\)/);
  assert.deepEqual(f.calls(), []);
  assert.equal(existsSync(join(f.workspace, 'work')), false);
});

test('baseline preserves the former CI checks, uses workspace caches and clears inherited live opt-ins', t => {
  const f = fixture(t);
  const result = f.run(['baseline'], {
    CLARIN_RUN_ARBITRARY_TEST: '1', CLARIN_RUN_DATABASE_TEST: '1',
    CLARIN_LIVE_REPORT_TEST: '1', CLARIN_TEST_OFFICIAL_EXCALIDRAW_LIBRARY: '1',
    NEXT_PUBLIC_API_URL: 'https://clarin.naperu.cloud',
    OFFLINE_V3_TEST_DATABASE_URL: 'inherited', OFFLINE_V4_TEST_DATABASE_URL: 'inherited', OFFLINE_V5_TEST_DATABASE_URL: 'inherited',
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  const cache = join(f.workspace, 'work/clarin-qa');
  assert.equal(calls[0], `go|${f.root}/backend|test ./...|${cache}/go-build|${cache}/go-mod|${cache}/gopath|local`);
  assert.equal(calls[1], `go|${f.root}/offline-signer|test ./...|${cache}/go-build|${cache}/go-mod|${cache}/gopath|local`);
  assert.deepEqual(calls.slice(2), [
    'npm|--prefix codex-bridge test',
    'node|--test scripts/deploy/*.test.mjs scripts/qa/validate.test.mjs',
    'npm|--prefix frontend run prepare:excalidraw',
    'npm|--prefix frontend run test:unit',
    'npm|--prefix frontend run typecheck',
    'npm|--prefix frontend run build',
    'git|diff --check',
  ]);
});

test('baseline stops on a failed check without running later stages', t => {
  const f = fixture(t, { failBackend: true });
  const result = f.run(['baseline']);
  assert.equal(result.status, 7);
  assert.equal(f.calls().length, 1);
  assert.doesNotMatch(result.stdout, /QA baseline passed/);
});

test('baseline refuses an older toolchain without downloading a replacement', t => {
  const f = fixture(t, { goVersion: '1.25.0' });
  const result = f.run(['baseline']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Go 1\.25\.11 or newer is required/);
  assert.deepEqual(f.calls(), []);
  assert.equal(existsSync(join(f.workspace, 'work')), false);
});

test('browser requires concrete files and projects and rejects broad or live selections', t => {
  const f = fixture(t);
  for (const args of [
    ['browser'],
    ['browser', 'tests/chat-attention.spec.ts'],
    ['browser', '--project=chromium'],
    ['browser', 'tests/missing.spec.ts', '--project=chromium'],
    ['browser', 'tests/chat-attention.spec.ts', '--project=*'],
    ['browser', 'tests/chat-attention.spec.ts', '--project=chromium', '--config=elsewhere.ts'],
    ['browser', 'tests/../example.spec.ts', '--project=chromium'],
    ...['offline-v4-shell', 'whiteboards-live-smoke', 'example'].map(name => ['browser', `tests/${name}.spec.ts`, '--project=chromium']),
  ]) {
    const result = f.run(args);
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
  }
  assert.deepEqual(f.calls(), []);
});

test('browser anchors the selected file and overrides inherited live settings', t => {
  const f = fixture(t);
  const result = f.run(['browser', 'tests/chat-attention.spec.ts', '--project=chromium', '--grep=attention', '--list'], {
    CI: '',
    PLAYWRIGHT_BASE_URL: 'https://clarin.naperu.cloud',
    CLARIN_E2E_BASE_URL: 'https://clarin.naperu.cloud',
    NEXT_PUBLIC_API_URL: 'https://clarin.naperu.cloud',
    CLARIN_E2E_LIVE: '1',
    CLARIN_E2E_LIVE_OFFLINE: '1',
    CLARIN_E2E_LIVE_WHITEBOARDS: '1',
    CLARIN_E2E_USERNAME: 'inherited-user',
    CLARIN_E2E_PASSWORD: 'inherited-password',
  });
  assert.equal(result.status, 0, result.stderr);
  const invocation = JSON.parse(f.calls()[0]);
  assert.deepEqual(invocation.args, ['test', 'tests/chat-attention\\.spec\\.ts$', '--project=chromium', '--grep=attention', '--list', '--retries=0', '--workers=2', '--max-failures=1', '--reporter=list']);
  assert.deepEqual(invocation.env, {
    CI: '1', PLAYWRIGHT_LOCAL_SERVER: '1', PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:3011',
    CLARIN_E2E_BASE_URL: 'http://127.0.0.1:3011', CLARIN_E2E_MOCK_AUTH: '1',
    NEXT_PUBLIC_API_URL: '',
    CLARIN_E2E_LIVE: '0', CLARIN_E2E_LIVE_OFFLINE: '0', CLARIN_E2E_LIVE_WHITEBOARDS: '0',
  });
});
