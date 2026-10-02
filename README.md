# BlastRadius — Know what breaks before you change it.

Column-level data lineage that runs **100% in the browser**. Drop in a dbt
`manifest.json` or a folder of `.sql` files, click any column, and see its full
upstream chain and downstream **blast radius**. No backend, no API keys, no
uploads — your warehouse schema never leaves your machine.

Live Site: https://k1sh0r3.github.io/BlastRadius/

## Run it

No build step. Serve the folder (it must be served over HTTP for `fetch()` of the
demo manifest — `file://` will block that one request):

```bash
cd BlastRadius
python3 -m http.server 8080
# open http://localhost:8080
```

## Project layout

```
index.html                     landing + analyzer
about.html                     how-it-works page
assets/
  style.css                    dark theme (#0b0e17 / #7c5cff)
  app.js                       UI wiring: upload, SVG graph, inspector panel, export
  lineage.js                   the engine (no dependencies, also used by tests)
  vendor/node-sql-parser.umd.js  vendored SQL parser — no CDN
  demo/manifest.json           demo dbt project (2 sources, 6 models)
tests/
  run.js                       node test runner (27 tests)
  test_*.js                    manifest parsing, lineage, blast radius, raw SQL
```

## The engine (`assets/lineage.js`)

`BlastLineage.createEngine(Parser)` exposes:

- `parseManifest(manifest)` → project graph (models, seeds, snapshots, sources)
- `buildFromSqlFiles([{name, sql}], dialect)` → project graph from raw SQL
- `buildColumnLineage(project, dialect)` → `{ upstream, downstream, columnsByNode, parseErrors }`
- `upstreamChain(lineage, nodeId, column)` → full root-to-column path
- `blastRadius(lineage, nodeId, column)` → every downstream model/column

Honesty rules: unresolvable tables become explicit `unknown` nodes (never
dropped); `SELECT *` links are flagged `viaStar`; ambiguous unqualified columns
link to all candidates and are flagged; `count(*)` yields an empty lineage
rather than a fabricated one.

## Tests

```bash
cd BlastRadius
node tests/run.js
# 27 passed, 0 failed
```

(The tests load `node-sql-parser` from the vendored UMD bundle, so no `npm install` is needed.)

## Cost

$0 — static files only.
