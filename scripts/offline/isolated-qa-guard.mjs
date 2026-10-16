import { realpathSync } from 'node:fs'
import path from 'node:path'

// This suite must never fall back to the production origin or Docker daemon.
export function isolatedOfflineQAOrigin(value) {
  if (!value) throw new Error('OFFLINE_QA_ORIGIN must explicitly name the local laboratory')
  const url = new URL(value)
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Offline QA requires an explicit loopback HTTP origin with a dedicated port')
  }
  return url.origin
}

export function isolatedOfflineQARoot(value, resolve = realpathSync) {
  const root = resolve(value)
  if (root.replaceAll('\\', '/').replace(/\/$/, '') === '/root/proyect/clarin') {
    throw new Error('Offline QA cannot run from the production checkout')
  }
  return path.resolve(root)
}

export function isolatedOfflineQADockerHost(env = process.env) {
  if (env.DOCKER_CONTEXT && env.DOCKER_CONTEXT !== 'default') throw new Error('Offline QA refuses a remote Docker context')
  if (env.DOCKER_HOST && !['unix:///var/run/docker.sock', 'npipe:////./pipe/docker_engine'].includes(env.DOCKER_HOST)) {
    throw new Error('Offline QA refuses a remote Docker daemon')
  }
}
