# BlastRadius — Know what breaks before you change it.

Column-level data lineage that runs **100% in the browser**. Drop in a dbt
`manifest.json` or a folder of `.sql` files, click any column, and see its full
upstream chain and downstream **blast radius**. No backend, no API keys, no
uploads — your warehouse schema never leaves your machine.

## Run it

No build step. Serve the folder (it must be served over HTTP for `fetch()` of the
demo manifest — `file://` will block that one request):

```bash
cd ~/workspace/blast-radius
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
  run.js                       node test runner (24 tests)
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
cd ~/workspace/blast-radius
NODE_PATH=/tmp/nsp-test/node_modules node tests/run.js
# 24 passed, 0 failed
```

(`node-sql-parser` is a dev-only node dependency for the test runner; the
browser uses the vendored UMD bundle.)

## Cost

$0 — static files only.
