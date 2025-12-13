# bee-threads Benchmark Suite

Sistema de benchmarks para comparar performance de processamento paralelo.

## Benchmarks

### Benchmark 1: Turbo Mode (`bench-turbo.ts`)

Compara diferentes abordagens de paralelização:

| Método | Descrição |
|--------|-----------|
| **RAW** | `Array.prototype.map()` - baseline single-thread |
| **BEE.TURBO** | `beeThreads.turbo(arr).map(fn)` - workers internos |
| **BEE.WORKER.TURBO** | `beeThreads.worker('./file').turbo(arr)` - workers externos |
| **PISCINA** | Pool de workers externo (lib popular) |

**Cenários testados:**
- `CPU-HEAVY`: 1000 iterações de Math por item (onde paralelismo DEVE ganhar)
- `CPU-LIGHT`: Operação simples `x * 2 + 1` (onde overhead pode dominar)
- `OBJECT`: Transformação de objetos (testa AutoPack)

### Benchmark 2: Serialização (`bench-serialization.ts`)

Compara estratégias de serialização para transferência de dados:

| Método | Suporta | Descrição |
|--------|---------|-----------|
| **structuredClone** | Tudo | Nativo do V8 (baseline) |
| **JSON** | Tudo | `JSON.stringify/parse` |
| **AutoPack** | `object[]` | Serialização columnar para TypedArrays |
| **packNumberArray** | `number[]` | Converte para Float64Array |
| **packStringArray** | `string[]` | Converte para Uint8Array UTF-8 |
| **SharedArrayBuffer** | `number[]` | Zero-copy (mais rápido possível) |

**Tipos de dados testados:**
- `number[]`: Arrays de números
- `string[]`: Arrays de strings
- `object[]`: Arrays de objetos simples
- `nested[]`: Arrays de objetos aninhados

## Como Rodar

### Com Docker (Recomendado)

```bash
# Linux/Mac
./benchmarks/run.sh

# Windows PowerShell
.\benchmarks\run.ps1

# Apenas Node.js
./benchmarks/run.sh node

# Apenas Bun
./benchmarks/run.sh bun
```

### Localmente (Sem Docker)

```bash
# Instalar dependências
npm install
npm install piscina

# Build
npm run build

# Rodar com Node.js
npx tsx benchmarks/bench-turbo.ts
npx tsx benchmarks/bench-serialization.ts

# Rodar com Bun
bun benchmarks/bench-turbo.ts
bun benchmarks/bench-serialization.ts
```

## Estrutura

```
benchmarks/
├── bench-turbo.ts          # Benchmark 1: RAW vs BEE.TURBO vs PISCINA
├── bench-serialization.ts  # Benchmark 2: Serialização
├── workers/
│   ├── heavy-worker.js     # Worker para operações pesadas
│   ├── object-worker.js    # Worker para objetos
│   └── piscina-worker.js   # Worker para Piscina
├── Dockerfile.node         # Container Node.js
├── Dockerfile.bun          # Container Bun
├── docker-compose.yml      # Orquestração
├── run.sh                  # Script Linux/Mac
├── run.ps1                 # Script Windows
└── README.md               # Este arquivo
```

## Output

Os benchmarks geram arquivos JSON em `benchmarks/results/`:
- `results-node.json` - Resultados do Benchmark 1 (Node.js)
- `results-bun.json` - Resultados do Benchmark 1 (Bun)
- `serialization-node.json` - Resultados do Benchmark 2 (Node.js)
- `serialization-bun.json` - Resultados do Benchmark 2 (Bun)

Use esses arquivos para gerar o relatório de análise.

## Análise

Após rodar os benchmarks, gere o relatório:

```bash
npx tsx benchmarks/generate-analysis.ts
```

Isso criará `benchmarks/ANALYSIS.md` com:
- Tabelas comparativas
- Gráficos de speedup
- Recomendações de uso

