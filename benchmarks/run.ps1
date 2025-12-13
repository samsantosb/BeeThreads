# bee-threads Benchmark Runner (PowerShell)
# 
# Usage:
#   .\benchmarks\run.ps1          # Run both Node.js and Bun
#   .\benchmarks\run.ps1 node     # Run Node.js only
#   .\benchmarks\run.ps1 bun      # Run Bun only

param(
    [string]$Runtime = "all"
)

$ErrorActionPreference = "Stop"

# Navigate to project root
$ProjectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $ProjectRoot

# Create results directory
New-Item -ItemType Directory -Force -Path "benchmarks\results" | Out-Null

Write-Host "╔════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║           BEE-THREADS BENCHMARK SUITE                      ║" -ForegroundColor Cyan
Write-Host "╚════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

if ($Runtime -eq "node" -or $Runtime -eq "all") {
    Write-Host "🚀 Building and running Node.js benchmarks..." -ForegroundColor Yellow
    docker-compose -f benchmarks/docker-compose.yml build bench-node
    docker-compose -f benchmarks/docker-compose.yml run --rm bench-node
    Write-Host ""
}

if ($Runtime -eq "bun" -or $Runtime -eq "all") {
    Write-Host "🚀 Building and running Bun benchmarks..." -ForegroundColor Yellow
    docker-compose -f benchmarks/docker-compose.yml build bench-bun
    docker-compose -f benchmarks/docker-compose.yml run --rm bench-bun
    Write-Host ""
}

Write-Host "✅ Benchmarks complete!" -ForegroundColor Green
Write-Host "📊 Results saved in benchmarks\results\" -ForegroundColor Green

