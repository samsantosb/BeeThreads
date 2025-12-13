#!/bin/bash

# bee-threads Benchmark Runner
# 
# Usage:
#   ./benchmarks/run.sh          # Run both Node.js and Bun
#   ./benchmarks/run.sh node     # Run Node.js only
#   ./benchmarks/run.sh bun      # Run Bun only

set -e

cd "$(dirname "$0")/.."

# Create results directory
mkdir -p benchmarks/results

echo "╔════════════════════════════════════════════════════════════╗"
echo "║           BEE-THREADS BENCHMARK SUITE                      ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

if [ "$1" == "node" ] || [ -z "$1" ]; then
    echo "🚀 Building and running Node.js benchmarks..."
    docker-compose -f benchmarks/docker-compose.yml build bench-node
    docker-compose -f benchmarks/docker-compose.yml run --rm bench-node
    echo ""
fi

if [ "$1" == "bun" ] || [ -z "$1" ]; then
    echo "🚀 Building and running Bun benchmarks..."
    docker-compose -f benchmarks/docker-compose.yml build bench-bun
    docker-compose -f benchmarks/docker-compose.yml run --rm bench-bun
    echo ""
fi

echo "✅ Benchmarks complete!"
echo "📊 Results saved in benchmarks/results/"

