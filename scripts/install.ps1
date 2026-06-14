# GroupChat bootstrap installer — run on any Windows PC:
#   irm https://github.com/Avorant/Group-Chat/releases/latest/download/install.ps1 | iex
#
# Builds the GroupChat home (Documents\GroupChat): a bundled Node runtime with
# the claude + codex CLIs, then installs the desktop app from GitHub Releases.
# In-memory execution (irm | iex) is not blocked by ExecutionPolicy — by design.
#
# Optional vendor seats (their own official installers):
#   $env:GROUPCHAT_WITH_CURSOR = '1'       before running → installs Cursor CLI
#   $env:GROUPCHAT_WITH_ANTIGRAVITY = '1'  before running → installs Antigravity CLI
#     (Antigravity seat is EXPERIMENTAL — see docs/DECISIONS.md D-202 for the ToS note)

$ErrorActionPreference = 'Stop'
$repo = 'Avorant/Group-Chat'
$home_ = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'GroupChat'
$runtime = Join-Path $home_ 'runtime'

Write-Host "GroupChat installer" -ForegroundColor Cyan
Write-Host "  home: $home_"

foreach ($d in @($home_, $runtime, (Join-Path $home_ 'bin'), (Join-Path $home_ 'agents'), (Join-Path $home_ 'hooks'), (Join-Path $home_ 'logs'))) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}

# --- 1. Node runtime (zip distribution, user-scoped, no admin)
if (-not (Test-Path (Join-Path $runtime 'node.exe'))) {
  Write-Host "[1/4] Downloading Node.js LTS..." -ForegroundColor Yellow
  $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
  $lts = ($index | Where-Object { $_.lts }) | Select-Object -First 1
  $ver = $lts.version
  $zip = Join-Path $env:TEMP "node-$ver-win-x64.zip"
  Invoke-WebRequest -Uri "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip -UseBasicParsing
  $extract = Join-Path $env:TEMP "groupchat-node-extract"
  if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $extract -Force
  Copy-Item -Path (Join-Path $extract "node-$ver-win-x64\*") -Destination $runtime -Recurse -Force
  Remove-Item $extract -Recurse -Force
  Write-Host "  Node $ver -> runtime"
} else {
  Write-Host "[1/4] Node runtime already present" -ForegroundColor DarkGray
}

# --- 2. Agent CLIs into the runtime (claude + codex; their logins are one-time, per machine)
Write-Host "[2/4] Installing agent CLIs (claude, codex)..." -ForegroundColor Yellow
& (Join-Path $runtime 'npm.cmd') install -g --silent '@anthropic-ai/claude-code' '@openai/codex'
Write-Host "  claude: $(& (Join-Path $runtime 'claude.cmd') --version)"
Write-Host "  codex:  $(& (Join-Path $runtime 'codex.cmd') --version)"

# --- 3. Optional seats via their official installers
if ($env:GROUPCHAT_WITH_CURSOR -eq '1') {
  Write-Host "[3/4] Installing Cursor CLI (official installer)..." -ForegroundColor Yellow
  irm 'https://cursor.com/install?win32=true' | iex
} else { Write-Host "[3/4] Cursor seat skipped (set GROUPCHAT_WITH_CURSOR=1 to include)" -ForegroundColor DarkGray }
if ($env:GROUPCHAT_WITH_ANTIGRAVITY -eq '1') {
  Write-Host "      Installing Antigravity CLI (official installer, EXPERIMENTAL seat)..." -ForegroundColor Yellow
  irm 'https://antigravity.google/cli/install.ps1' | iex
}

# --- 4. The desktop app from GitHub Releases
Write-Host "[4/4] Installing the GroupChat app..." -ForegroundColor Yellow
try {
  $setup = Join-Path $env:TEMP 'GroupChat-Setup.exe'
  Invoke-WebRequest -Uri "https://github.com/$repo/releases/latest/download/GroupChat-Setup.exe" -OutFile $setup -UseBasicParsing
  Start-Process -FilePath $setup -ArgumentList '/S' -Wait
  Write-Host "  installed."
} catch {
  Write-Host "  No app release found yet — runtime is ready; build the app from source (pnpm dev) or retry after the first release." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Open GroupChat, pick a repo, and log in to each CLI once:" -ForegroundColor Cyan
Write-Host "  claude -> Anthropic account   codex -> ChatGPT account"
Write-Host "The room takes it from there."
