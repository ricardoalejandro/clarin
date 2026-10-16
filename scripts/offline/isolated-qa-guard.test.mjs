import test from 'node:test'
import assert from 'node:assert/strict'
import { isolatedOfflineQAOrigin, isolatedOfflineQARoot, isolatedOfflineQADockerHost } from './isolated-qa-guard.mjs'

test('offline QA requires an explicit loopback origin; production and implicit defaults are rejected', () => {
  assert.equal(isolatedOfflineQAOrigin('http://127.0.0.1:19445'), 'http://127.0.0.1:19445')
  assert.equal(isolatedOfflineQAOrigin('http://localhost:19445'), 'http://localhost:19445')
  for (const origin of [undefined, 'https://clarin.naperu.cloud', 'http://example.com:19445', 'http://127.0.0.1', 'http://user:secret@localhost:19445', 'http://localhost:19445/api', 'http://localhost:19445/?target=production']) {
    assert.throws(() => isolatedOfflineQAOrigin(origin))
  }
})

test('production checkout and aliases resolving to it are rejected', () => {
  assert.throws(() => isolatedOfflineQARoot('/root/proyect/clarin', value => value))
  assert.throws(() => isolatedOfflineQARoot('/tmp/alias', () => '/root/proyect/clarin'))
  assert.ok(isolatedOfflineQARoot('/tmp/clarin-offline-qa', value => value))
})

test('offline QA refuses remote Docker hosts or contexts', () => {
  for (const env of [{ DOCKER_HOST: 'ssh://vps' }, { DOCKER_HOST: 'tcp://localhost:2375' }, { DOCKER_CONTEXT: 'vps' }]) assert.throws(() => isolatedOfflineQADockerHost(env))
  isolatedOfflineQADockerHost({})
  isolatedOfflineQADockerHost({ DOCKER_CONTEXT: 'default', DOCKER_HOST: 'unix:///var/run/docker.sock' })
})
