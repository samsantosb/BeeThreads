# bee-threads Benchmark Analysis

**Data:** 2025-12-12  
**Ambiente:** Docker (Node 20 Alpine / Bun 1)  
**Workers:** 11 CPUs

---

## Node.js Results

### Diagnóstico de Serialização (100K objetos)

| Método | Pack | Unpack | Total | vs structuredClone |
|--------|------|--------|-------|-------------------|
| **structuredClone** | 172.44ms | 159.84ms | **332.28ms** | baseline |
| **AutoPack** | 19.38ms | 57.35ms | **76.73ms** | **4.3x mais rápido** ✅ |

> 🔑 **Insight:** AutoPack é 4.3x mais rápido que structuredClone para objetos!

---

### CPU-HEAVY (1000 Math iterations per item)

| Size | RAW | BEE.TURBO | BEE.WORKER.TURBO | PISCINA |
|------|-----|-----------|------------------|---------|
| 10K | 412ms | **72ms (5.72x)** ✅ | **66ms (6.23x)** ✅ | 400ms (1.03x) |
| 100K | 4,099ms | **824ms (4.97x)** ✅ | **767ms (5.34x)** ✅ | 1,065ms (3.85x) ✅ |
| 1M | 37,494ms | **10,108ms (3.71x)** ✅ | **9,608ms (3.90x)** ✅ | 9,516ms (3.94x) ✅ |

> 🔑 **Insight:** Para operações CPU-heavy, BEE.TURBO e BEE.WORKER.TURBO são **5-6x mais rápidos** que RAW!

---

### CPU-LIGHT (simple x * 2 + 1)

| Size | RAW | BEE.TURBO | BEE.WORKER.TURBO | PISCINA |
|------|-----|-----------|------------------|---------|
| 10K | 0.39ms | 15ms ❌ | 108ms ❌ | 768ms ❌ |
| 100K | 7.69ms | 33ms ❌ | 1,073ms ❌ | 818ms ❌ |
| 1M | 141ms | 358ms ❌ | 6,816ms ❌ | 979ms ❌ |

> ⚠️ **Insight:** Para operações simples, o overhead de workers é MAIOR que o benefício. Use RAW.

---

### OBJECT TRANSFORM (AutoPack territory)

| Size | RAW | BEE.TURBO | BEE.WORKER.TURBO | PISCINA |
|------|-----|-----------|------------------|---------|
| 10K | 44ms | 94ms (0.47x) ❌ | 99ms (0.45x) ❌ | 418ms ❌ |
| 100K | 433ms | 460ms (0.94x) → | 841ms (0.52x) ❌ | 880ms ❌ |
| 1M | 6,022ms | 7,311ms (0.82x) ❌ | 22,731ms ❌ | 10,051ms ❌ |

> ⚠️ **Insight:** Transformação de objetos simples não compensa paralelização. O overhead de serialização domina.

---

### Serialização: number[]

| Size | structuredClone | JSON | packNumberArray | SharedArrayBuffer |
|------|-----------------|------|-----------------|-------------------|
| 1K | 0.38ms | 0.61ms | **0.07ms (5.4x)** ✅ | 0.09ms (4.2x) ✅ |
| 10K | 3.99ms | 3.48ms | **0.28ms (14.3x)** ✅ | 0.78ms (5.1x) ✅ |
| 100K | 43.23ms | 35.61ms | **0.87ms (49.7x)** ✅ | 3.64ms (11.9x) ✅ |
| 500K | 264.05ms | 226.83ms | **5.61ms (47.1x)** ✅ | 7.34ms (36.0x) ✅ |

> 🔑 **Insight:** `packNumberArray` é até **50x mais rápido** que structuredClone para arrays numéricos!

---

### Serialização: string[]

| Size | structuredClone | JSON | packStringArray |
|------|-----------------|------|-----------------|
| 1K | 0.47ms | **0.12ms (3.9x)** ✅ | 0.99ms ❌ |
| 10K | 4.86ms | **1.57ms (3.1x)** ✅ | 3.28ms (1.5x) ✅ |
| 100K | 63.34ms | **16.34ms (3.9x)** ✅ | 46.37ms (1.4x) ✅ |
| 500K | 397.20ms | **139.43ms (2.9x)** ✅ | ERROR (buffer limit) |

> ⚠️ **Insight:** Para strings, JSON é mais rápido que AutoPack! packStringArray tem limite de 16MB.

---

## Bun Results

### Diagnóstico de Serialização (100K objetos)

| Método | Pack | Unpack | Total | vs structuredClone |
|--------|------|--------|-------|-------------------|
| **structuredClone** | 100.78ms | 100.72ms | **201.5ms** | baseline |
| **AutoPack** | 21.19ms | 18.64ms | **39.83ms** | **5.1x mais rápido** ✅ |

> 🔑 **Insight:** Bun + AutoPack = 5x mais rápido que structuredClone!

---

### Bun vs Node: Raw Performance (100K items)

| Operação | Node | Bun | Speedup |
|----------|------|-----|---------|
| RAW map (light) | 415.82ms | **10.97ms** | **38x** 🚀 |
| RAW map (heavy) | 1808.52ms | **979.38ms** | **1.8x** |
| structuredClone | 332.28ms | **201.5ms** | **1.6x** |
| AutoPack | 76.73ms | **39.83ms** | **1.9x** |

> 🚀 **Insight:** Bun é até **38x mais rápido** que Node para operações leves!

---

### CPU-HEAVY (Bun) - 1000 Math iterations per item

| Size | RAW | BEE.TURBO | BEE.WORKER.TURBO |
|------|-----|-----------|------------------|
| 10K | 237ms | **75ms (3.16x)** ✅ | **60ms (3.92x)** ✅ |
| 100K | 2,278ms | **712ms (3.20x)** ✅ | **530ms (4.30x)** ✅ |
| 500K | 11,868ms | **4,935ms (2.40x)** ✅ | **2,595ms (4.57x)** ✅ |

> 🔑 **Insight:** No Bun, BEE.WORKER.TURBO é ainda **MAIS RÁPIDO** que BEE.TURBO! Até 4.57x speedup!

---

### CPU-LIGHT (Bun) - simple x * 2 + 1

| Size | RAW | BEE.TURBO | BEE.WORKER.TURBO |
|------|-----|-----------|------------------|
| 10K | 0.25ms | 1.98ms ❌ | 54ms ❌ |
| 100K | 0.94ms | 5.40ms ❌ | 428ms ❌ |
| 500K | 2.92ms | 19.65ms ❌ | 2,170ms ❌ |

> ⚠️ **Insight:** Bun é TÃO rápido em single-thread que workers NÃO compensam para operações simples!

---

### OBJECT TRANSFORM (Bun)

| Size | RAW | BEE.TURBO | BEE.WORKER.TURBO |
|------|-----|-----------|------------------|
| 10K | 0.71ms | 18.62ms ❌ | 38.52ms ❌ |
| 100K | 8.33ms | 109.63ms ❌ | 99.53ms ❌ |
| 500K | 51.63ms | 667.62ms ❌ | 764.10ms ❌ |

> ⚠️ **Insight:** Para objetos simples, Bun single-thread é 10x mais rápido que com workers!

---

### Serialização: number[] (Bun)

| Size | structuredClone | JSON | packNumberArray | SharedArrayBuffer |
|------|-----------------|------|-----------------|-------------------|
| 1K | 0.10ms | 0.13ms | **0.06ms (1.7x)** ✅ | **0.05ms (2.0x)** ✅ |
| 10K | 0.67ms | 0.94ms | **0.08ms (8.4x)** ✅ | 0.20ms (3.4x) ✅ |
| 100K | 7.04ms | 10.01ms | **0.86ms (8.2x)** ✅ | 1.31ms (5.4x) ✅ |
| 500K | 35.70ms | 57.42ms | **3.29ms (10.9x)** ✅ | 5.86ms (6.1x) ✅ |

> 🔑 **Insight:** `packNumberArray` no Bun é até **11x mais rápido** que structuredClone!

---

### Serialização: string[] (Bun)

| Size | structuredClone | JSON | packStringArray |
|------|-----------------|------|-----------------|
| 1K | 0.41ms | **0.10ms (4.1x)** ✅ | 0.33ms (1.2x) ✅ |
| 10K | 4.95ms | **1.56ms (3.2x)** ✅ | 6.28ms ❌ |
| 100K | 64.47ms | **10.14ms (6.4x)** ✅ | 30.87ms (2.1x) ✅ |
| 500K | 477.07ms | **57.01ms (8.4x)** ✅ | ERROR (buffer limit) |

> 🔑 **Insight:** No Bun, JSON é até **8x mais rápido** que structuredClone para strings!

---

## Node vs Bun: Comparação

### Serialização number[] (100K items)

| Método | Node | Bun | Vencedor |
|--------|------|-----|----------|
| structuredClone | 43.23ms | 7.04ms | **Bun 6x** |
| JSON | 35.61ms | 10.01ms | **Bun 3.5x** |
| packNumberArray | 0.87ms | 0.86ms | **Empate** |
| SharedArrayBuffer | 3.64ms | 1.31ms | **Bun 2.8x** |

> 🔑 **Insight:** packNumberArray é consistentemente rápido em ambos runtimes!

### Serialização string[] (100K items)

| Método | Node | Bun | Vencedor |
|--------|------|-----|----------|
| structuredClone | 63.34ms | 64.47ms | **Empate** |
| JSON | 16.34ms | 10.14ms | **Bun 1.6x** |
| packStringArray | 46.37ms | 30.87ms | **Bun 1.5x** |

---

## Conclusões

### Quando usar BEE.TURBO:

| Cenário | Recomendação |
|---------|-------------|
| CPU-heavy (Math, crypto, parsing) | ✅ **USE BEE.TURBO** - até 6x speedup |
| CPU-light (x * 2, string concat) | ❌ **USE RAW** - overhead > benefício |
| Object transform simples | ❌ **USE RAW** - serialização domina |
| Object transform pesado | ✅ **USE BEE.TURBO** - se compute >> serialização |

### Quando usar AutoPack:

| Tipo de Dados | Recomendação |
|--------------|-------------|
| `number[]` | ✅ **USE packNumberArray** - 50x mais rápido |
| `string[]` | ❌ **USE JSON** - mais rápido e sem limite |
| `object[]` | ✅ **USE autoPack** - 4x mais rápido que structuredClone |

### Regra de Ouro:

```
Se tempo_compute > 10 * tempo_serialização:
    USE workers (turbo)
Senão:
    USE single-thread (raw)
```

Para 100K objetos:
- Serialização ≈ 77ms (AutoPack)
- Compute deve ser > 770ms para compensar
- Isso = ~7.7μs por item de processamento

---

## Resumo Final

### O que funciona bem:

| Feature | Status | Notas |
|---------|--------|-------|
| **BEE.TURBO (Node)** | ✅ | 5-6x speedup para CPU-heavy |
| **BEE.WORKER.TURBO (Node)** | ✅ | 5-6x speedup para CPU-heavy |
| **BEE.TURBO (Bun)** | ✅ | 2-3x speedup para CPU-heavy |
| **BEE.WORKER.TURBO (Bun)** | ✅ | **4-5x speedup** para CPU-heavy (melhor que Node!) |
| **AutoPack (objetos)** | ✅ | 4-5x mais rápido que structuredClone |
| **packNumberArray** | ✅ | 10-50x mais rápido que structuredClone |
| **Bun raw performance** | ✅ | 38x mais rápido que Node para ops leves |

### O que NÃO funciona:

| Feature | Status | Notas |
|---------|--------|-------|
| **CPU-light com workers** | ❌ | Overhead > benefício (ambos runtimes) |
| **Object transform simples** | ❌ | Serialização domina (ambos runtimes) |
| **packStringArray 500K+** | ❌ | Limite de 16MB |
| **Piscina no Bun** | ❌ | Incompatibilidade |

### Recomendações de Uso:

```typescript
// ✅ USE para CPU-heavy (>1ms por item)
await beeThreads.turbo(data).map(heavyComputation);

// ❌ NÃO use para operações simples
data.map(x => x * 2); // Use raw

// ✅ USE packNumberArray para arrays numéricos
const packed = packNumberArray(numbers); // 50x mais rápido

// ❌ NÃO use packStringArray para strings grandes
JSON.stringify(strings); // Mais rápido e sem limite
```

---

## Próximos Passos

1. ✅ Benchmark Node.js completo
2. ✅ Benchmark Bun completo (BEE.TURBO funciona!)
3. ✅ Comparar Node vs Bun
4. ✅ Piscina incompatível com Bun (skipped)
5. ⏳ Aumentar limite packStringArray ou usar JSON como fallback
6. ⏳ Adicionar detecção automática de "vale a pena usar workers"
