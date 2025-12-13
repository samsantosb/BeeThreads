/**
 * Generate Analysis Report from Benchmark Results
 * 
 * Usage: npx tsx benchmarks/generate-analysis.ts
 * 
 * Reads JSON results and generates ANALYSIS.md
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TurboResult {
  name: string;
  size: number;
  scenario: string;
  mean: number;
  std: number;
  min: number;
  max: number;
  opsPerSec: number;
}

interface SerializationResult {
  method: string;
  dataType: string;
  size: number;
  packTime: number;
  unpackTime: number;
  totalTime: number;
  throughputMBps: number;
}

interface TurboData {
  runtime: string;
  workers: number;
  results: TurboResult[];
}

interface SerializationData {
  runtime: string;
  results: SerializationResult[];
}

function loadJSON<T>(filename: string): T | null {
  const path = join(__dirname, filename);
  if (!existsSync(path)) {
    console.log(`⚠️  ${filename} not found`);
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return n.toString();
}

function generateTurboTable(data: TurboData): string {
  const { runtime, workers, results } = data;
  
  let md = `### ${runtime} (${workers} workers)\n\n`;
  
  const scenarios = ['cpu-heavy', 'cpu-light', 'object'];
  const methods = ['RAW', 'BEE.TURBO', 'BEE.WORKER.TURBO', 'PISCINA'];
  
  for (const scenario of scenarios) {
    const scenarioResults = results.filter(r => r.scenario === scenario);
    if (scenarioResults.length === 0) continue;
    
    md += `#### ${scenario.toUpperCase()}\n\n`;
    md += '| Size | ' + methods.join(' | ') + ' | Best Speedup |\n';
    md += '|------|' + methods.map(() => '---').join('|') + '|---|\n';
    
    const sizes = [...new Set(scenarioResults.map(r => r.size))].sort((a, b) => a - b);
    
    for (const size of sizes) {
      const sizeResults = scenarioResults.filter(r => r.size === size);
      const raw = sizeResults.find(r => r.name === 'RAW');
      if (!raw) continue;
      
      let row = `| ${formatNumber(size)} |`;
      let bestSpeedup = 1;
      let bestMethod = 'RAW';
      
      for (const method of methods) {
        const r = sizeResults.find(x => x.name === method);
        if (r) {
          const speedup = raw.mean / r.mean;
          row += ` ${r.mean.toFixed(1)}ms |`;
          if (speedup > bestSpeedup && method !== 'RAW') {
            bestSpeedup = speedup;
            bestMethod = method;
          }
        } else {
          row += ' - |';
        }
      }
      
      if (bestSpeedup >= 1.2) {
        row += ` ✅ ${bestMethod} ${bestSpeedup.toFixed(2)}x |`;
      } else if (bestSpeedup >= 1) {
        row += ` → ${bestMethod} ${bestSpeedup.toFixed(2)}x |`;
      } else {
        row += ` ❌ No speedup |`;
      }
      
      md += row + '\n';
    }
    md += '\n';
  }
  
  return md;
}

function generateSerializationTable(data: SerializationData): string {
  const { runtime, results } = data;
  
  let md = `### ${runtime}\n\n`;
  
  const dataTypes = ['number[]', 'string[]', 'object[]', 'nested[]'];
  
  for (const dataType of dataTypes) {
    const dtResults = results.filter(r => r.dataType === dataType);
    if (dtResults.length === 0) continue;
    
    const methods = [...new Set(dtResults.map(r => r.method))];
    
    md += `#### ${dataType}\n\n`;
    md += '| Size | ' + methods.join(' | ') + ' | Best |\n';
    md += '|------|' + methods.map(() => '---').join('|') + '|---|\n';
    
    const sizes = [...new Set(dtResults.map(r => r.size))].sort((a, b) => a - b);
    
    for (const size of sizes) {
      const sizeResults = dtResults.filter(r => r.size === size);
      const baseline = sizeResults.find(r => r.method === 'structuredClone');
      if (!baseline) continue;
      
      let row = `| ${formatNumber(size)} |`;
      let bestTime = Infinity;
      let bestMethod = 'structuredClone';
      
      for (const method of methods) {
        const r = sizeResults.find(x => x.method === method);
        if (r) {
          row += ` ${r.totalTime.toFixed(1)}ms |`;
          if (r.totalTime < bestTime) {
            bestTime = r.totalTime;
            bestMethod = r.method;
          }
        } else {
          row += ' - |';
        }
      }
      
      const speedup = baseline.totalTime / bestTime;
      if (speedup >= 1.2) {
        row += ` ✅ ${bestMethod} ${speedup.toFixed(2)}x |`;
      } else {
        row += ` → ${bestMethod} |`;
      }
      
      md += row + '\n';
    }
    md += '\n';
  }
  
  return md;
}

function main() {
  console.log('📊 Generating analysis report...\n');
  
  let md = `# bee-threads Benchmark Analysis

Generated: ${new Date().toISOString()}

## Benchmark 1: Turbo Mode

Comparison of parallel processing approaches.

**Legend:**
- ✅ Speedup >= 1.2x (significant improvement)
- → Speedup 1.0-1.2x (marginal improvement)
- ❌ No speedup (overhead > benefit)

`;

  // Load turbo results
  const nodeData = loadJSON<TurboData>('results-node.json');
  const bunData = loadJSON<TurboData>('results-bun.json');
  
  if (nodeData) {
    md += generateTurboTable(nodeData);
  }
  if (bunData) {
    md += generateTurboTable(bunData);
  }
  
  md += `
## Benchmark 2: Serialization

Comparison of data serialization strategies for worker transfer.

`;

  // Load serialization results
  const nodeSerial = loadJSON<SerializationData>('serialization-node.json');
  const bunSerial = loadJSON<SerializationData>('serialization-bun.json');
  
  if (nodeSerial) {
    md += generateSerializationTable(nodeSerial);
  }
  if (bunSerial) {
    md += generateSerializationTable(bunSerial);
  }
  
  md += `
## Conclusions

### When to use each approach:

| Scenario | Recommendation |
|----------|----------------|
| CPU-heavy, large arrays | \`beeThreads.turbo()\` or \`beeThreads.max()\` |
| CPU-light operations | Single-thread (overhead > benefit) |
| Object arrays > 500 items | AutoPack enabled |
| Number arrays + SharedArrayBuffer support | Use \`shared\` pack type |
| External modules needed | \`beeThreads.worker('./file').turbo()\` |

### Key insights:

1. **Parallelism only helps for CPU-heavy operations**
2. **Serialization overhead can dominate for simple operations**
3. **AutoPack provides benefit for large object arrays**
4. **SharedArrayBuffer is fastest for numeric arrays (when supported)**

`;

  const outputPath = join(__dirname, 'ANALYSIS.md');
  writeFileSync(outputPath, md);
  console.log(`✅ Analysis saved to: ${outputPath}`);
}

main();

