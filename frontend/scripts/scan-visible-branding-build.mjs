#!/usr/bin/env node

import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const policyPath = resolve(scriptDirectory, 'visible-branding-policy.json')
const scannableExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.txt'])
const maximumFileSize = 30 * 1024 * 1024

function parseRoots(argv) {
  const roots = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--root' || !argv[index + 1]) {
      throw new Error('Uso: scan-visible-branding-build.mjs --root PATH [--root PATH]')
    }
    roots.push(resolve(argv[index + 1]))
    index += 1
  }
  if (roots.length === 0) throw new Error('Debe indicarse al menos un --root.')
  return roots
}

async function listFiles(root) {
  const files = []
  async function walk(path) {
    const info = await lstat(path)
    if (info.isSymbolicLink()) return
    if (!info.isDirectory()) {
      if (info.isFile()) files.push(path)
      return
    }
    for (const entry of (await readdir(path)).sort()) await walk(join(path, entry))
  }
  await walk(root)
  return files
}

async function loadPolicy() {
  const raw = JSON.parse(await readFile(policyPath, 'utf8'))
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.legalArtifactBasenames) || !Array.isArray(raw.forbiddenVisibleText)) {
    throw new Error('La política local de branding no cumple el contrato esperado.')
  }
  return {
    legal: new Set(raw.legalArtifactBasenames),
    rules: raw.forbiddenVisibleText.map(rule => ({
      ...rule,
      expression: new RegExp(rule.pattern, rule.flags || 'u'),
    })),
  }
}

async function main() {
  const roots = parseRoots(process.argv.slice(2))
  const policy = await loadPolicy()
  let scannedFiles = 0
  let legalFiles = 0
  const violations = []

  for (const root of roots) {
    for (const file of await listFiles(root)) {
      if (policy.legal.has(basename(file))) {
        legalFiles += 1
        continue
      }
      if (!scannableExtensions.has(extname(file).toLowerCase()) || (await stat(file)).size > maximumFileSize) continue
      const content = await readFile(file, 'utf8')
      scannedFiles += 1
      for (const rule of policy.rules) {
        rule.expression.lastIndex = 0
        const match = rule.expression.exec(content)
        if (match) violations.push(`${rule.id} en ${file}: ${match[0].replace(/\s+/gu, ' ').slice(0, 120)}`)
      }
    }
  }

  if (violations.length > 0) throw new Error(`Branding upstream visible detectado:\n${violations.join('\n')}`)
  console.log(`Branding decision: PASS (${scannedFiles} artefactos estáticos; ${legalFiles} avisos legales preservados).`)
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`)
  process.exitCode = 1
})
