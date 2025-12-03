# 🐝 bee-threads

[![npm version](https://img.shields.io/npm/v/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![npm downloads](https://img.shields.io/npm/dm/bee-threads.svg)](https://www.npmjs.com/package/bee-threads)
[![license](https://img.shields.io/npm/l/bee-threads.svg)](https://github.com/samsantosb/BeeThreads/blob/main/LICENSE)
[![GitHub](https://img.shields.io/badge/GitHub-BeeThreads-blue?logo=github)](https://github.com/samsantosb/BeeThreads)

> **Handle threading as promises.**

Run CPU-intensive JavaScript in worker threads. No separate files, just inline functions.

```js
const { beeThreads } = require('bee-threads');

// Hash password without blocking the event loop
const hash = await beeThreads
  .run((password) => {
    const crypto = require('crypto');
    return crypto.pbkdf2Sync(password, 'salt', 100000, 64, 'sha512').toString('hex');
  })
  .usingParams('user-password')
  .execute();
```

## Install

```bash
npm install bee-threads
```

## Examples

### External Variables

```js
const TAX = 0.2;

await beeThreads
  .run((price) => price * (1 + TAX))
  .usingParams(100)
  .setContext({ TAX })
  .execute();
// → 120
```

### Safe Mode

```js
const result = await beeThreads
  .safeRun(() => JSON.parse('invalid'))
  .execute();

if (result.status === 'rejected') {
  console.error(result.error);
}
```

### Timeout & Cancellation

```js
// Timeout
await beeThreads.withTimeout(5000)(task).execute();

// Cancel
const ctrl = new AbortController();
beeThreads.run(task).signal(ctrl.signal).execute();
ctrl.abort();
```

### Streaming

```js
const stream = beeThreads
  .stream(function* (n) {
    for (let i = 0; i < n; i++) yield i * i;
  })
  .usingParams(5)
  .execute();

for await (const v of stream) console.log(v);
```

### Priority

```js
// Critical - first in queue
beeThreads.run(task).priority('high').execute();

// Background - last in queue
beeThreads.run(task).priority('low').execute();
```

## API

| Method | Description |
|--------|-------------|
| `run(fn)` | Execute in worker |
| `safeRun(fn)` | Never throws |
| `withTimeout(ms)(fn)` | Time limit |
| `stream(fn)` | Generator streaming |

### Executor Chain

| Method | Description |
|--------|-------------|
| `.usingParams(...args)` | Arguments |
| `.setContext(obj)` | Inject variables |
| `.signal(signal)` | Cancellation |
| `.transfer(list)` | Zero-copy buffers |
| `.retry(opts)` | Auto-retry |
| `.priority(level)` | Queue priority |
| `.execute()` | Run |

### Pool

| Method | Description |
|--------|-------------|
| `configure(opts)` | Pool settings |
| `warmup(n)` | Pre-create workers |
| `shutdown()` | Terminate all |
| `getPoolStats()` | Metrics |

## Configuration

```js
beeThreads.configure({
  poolSize: 8,              // Max workers
  minThreads: 2,            // Always-ready workers
  maxQueueSize: 500,        // Queue limit
  workerIdleTimeout: 60000  // Idle cleanup (ms)
});

// Eliminate cold-start
await beeThreads.warmup(4);
```

## Errors

```js
const { TimeoutError, AbortError, QueueFullError, WorkerError } = require('bee-threads');
```

## Use Cases

### Password Hashing

PBKDF2, bcrypt, scrypt are CPU-intensive and will block your server.

```js
const hash = await beeThreads
  .run((password) => {
    const crypto = require('crypto');
    return crypto.pbkdf2Sync(password, 'salt', 100000, 64, 'sha512').toString('hex');
  })
  .usingParams(password)
  .execute();
```

### Image Processing

Resize, compress, or apply filters without blocking.

```js
const thumbnail = await beeThreads
  .run((buffer) => {
    const sharp = require('sharp');
    return sharp(buffer).resize(200, 200).jpeg({ quality: 80 }).toBuffer();
  })
  .usingParams(imageBuffer)
  .execute();
```

### Large JSON Parsing

Parsing 50MB+ JSON will freeze your event loop.

```js
const data = await beeThreads
  .run((jsonString) => JSON.parse(jsonString))
  .usingParams(hugeJsonString)
  .execute();
```

### Data Compression

gzip, brotli, zstd for large payloads.

```js
const compressed = await beeThreads
  .run((data) => {
    const zlib = require('zlib');
    return zlib.brotliCompressSync(data);
  })
  .usingParams(largeBuffer)
  .execute();
```

### Complex Regex

Regex on large text files can take seconds.

```js
const matches = await beeThreads
  .run((text) => {
    const regex = /(\d{3})-(\d{3})-(\d{4})/g;
    return [...text.matchAll(regex)].map(m => m[0]);
  })
  .usingParams(millionLineLog)
  .execute();
```

### PDF/Report Generation

Generate large documents without blocking.

```js
const pdf = await beeThreads
  .run((data) => {
    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument();
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    // ... generate 500 pages ...
    doc.end();
    return Buffer.concat(chunks);
  })
  .usingParams(reportData)
  .execute();
```

### Batch Data Validation

Validate thousands of records in parallel.

```js
const results = await Promise.all(
  chunks.map(chunk =>
    beeThreads
      .run((records) => records.filter(r => !isValidEmail(r.email)))
      .usingParams(chunk)
      .execute()
  )
);
```

### When NOT to Use

| Scenario | Why |
|----------|-----|
| `fetch()` / HTTP requests | Already async (I/O bound) |
| Database queries | Already async (I/O bound) |
| `fs.readFile` | Already async (I/O bound) |
| Fast operations (<10ms) | Overhead > benefit |

**Rule of thumb:** If it blocks the event loop for >50ms, use bee-threads.

## License

MIT © [samsantosb](https://github.com/samsantosb)
