# update-context.ps1 - Codex integration: update AGENTS.md

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptDir "../../..")

& "$repoRoot/.specify/scripts/powershell/update-agent-context.ps1" -AgentType codex
