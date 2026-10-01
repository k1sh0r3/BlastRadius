/* BlastRadius lineage engine — manifest parsing, SQL AST → column mapping,
 * reverse-graph blast radius. Works in node (tests) and the browser.
 * Usage: const engine = BlastLineage.createEngine(ParserClass);
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.BlastLineage = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createEngine(ParserClass) {
    /* ---------------- helpers ---------------- */
    function norm(s) {
      return String(s == null ? '' : s).replace(/["'`\[\]]/g, '').trim().toLowerCase();
    }
    // column_ref column can be a string or {expr:{type:'default',value:'id'}} etc.
    function refColName(c) {
      if (c == null) return null;
      if (typeof c === 'string') return c;
      if (typeof c === 'object') {
        if (typeof c.value === 'string') return c.value;
        if (c.expr) return refColName(c.expr);
      }
      return null;
    }
    function outKey(nodeId, col) { return nodeId + '::' + norm(col); }

    /* ---------------- manifest parsing ---------------- */
    const MODEL_KINDS = { model: 'model', seed: 'seed', snapshot: 'snapshot' };

    function parseManifest(manifest) {
      const nodes = new Map();
      const relIndex = new Map(); // normalized relation name -> node id
      const nameIndex = new Map(); // schema.alias / alias -> node id (first wins)

      function addNode(id, n, kind) {
        const database = n.database || '';
        const schema = n.schema || '';
        const alias = n.alias || n.name || id;
        const relation = norm(n.relation_name || '');
        const cols = n.columns ? Object.keys(n.columns).map((c) => ({
          name: c,
          description: (n.columns[c] && n.columns[c].description) || '',
        })) : [];
        const node = {
          id, kind,
          name: n.name || alias,
          alias,
          database, schema,
          relation,
          columns: cols,
          dependsOn: ((n.depends_on && n.depends_on.nodes) || []).slice(),
          compiledSql: n.compiled_sql || n.compiled_code || n.raw_sql || '',
        };
        nodes.set(id, node);
        if (relation && !relIndex.has(relation)) relIndex.set(relation, id);
        const keys = [];
        if (database && schema && alias) keys.push(norm(database + '.' + schema + '.' + alias));
        if (schema && alias) keys.push(norm(schema + '.' + alias));
        if (alias) keys.push(norm(alias));
        for (const k of keys) if (!nameIndex.has(k)) nameIndex.set(k, id);
        return node;
      }

      for (const [id, n] of Object.entries(manifest.nodes || {})) {
        if (MODEL_KINDS[n.resource_type]) addNode(id, n, MODEL_KINDS[n.resource_type]);
      }
      for (const [id, n] of Object.entries(manifest.sources || {})) {
        addNode(id, n, 'source');
      }
      return { nodes, relIndex, nameIndex };
    }

    function resolveTable(name, project) {
      const n = norm(name);
      if (!n) return null;
      if (project.relIndex.has(n)) return project.relIndex.get(n);
      if (project.nameIndex.has(n)) return project.nameIndex.get(n);
      // try stripping a trailing database part (a.b.c -> b.c, c)
      const parts = n.split('.');
      for (let i = 1; i < parts.length; i++) {
        const sub = parts.slice(i).join('.');
        if (project.nameIndex.has(sub)) return project.nameIndex.get(sub);
      }
      return null;
    }

    /* ---------------- SQL analysis ---------------- */

    // scope: [{ alias (norm), nodeId|null, tableLabel, columns: Map<normCol, inputs[]>, starUnknown, depth }]
    function scopeEntryForTable(db, schema, table, alias, project, depth) {
      const label = [db, schema, table].filter(Boolean).join('.');
      const nodeId = resolveTable(label, project);
      const columns = new Map();
      let starUnknown = false;
      if (nodeId) {
        const known = (project.computedColumns && project.computedColumns.get(nodeId)) ||
          (project.nodes.get(nodeId) || {}).columns;
        const cols = Array.isArray(known)
          ? known.map((c) => (typeof c === 'string' ? c : c.name)).filter(Boolean)
          : null;
        if (cols && cols.length) {
          for (const c of cols) columns.set(norm(c), [{ nodeId, column: c }]);
        } else {
          starUnknown = true; // node known but its columns aren't
        }
      } else {
        starUnknown = true; // unknown table entirely
      }
      return { alias: norm(alias || table), nodeId, tableLabel: label, columns, starUnknown, depth };
    }

    // Recursively collect {nodeId|null, column, tableLabel?} refs from an expression.
    function collectRefs(expr, scopes, project, parser, depth) {
      const refs = [];
      function walk(e, scopes) {
        if (!e || typeof e !== 'object') return;
        if (Array.isArray(e)) { e.forEach((x) => walk(x, scopes)); return; }
        if (e.type === 'column_ref') {
          const col = refColName(e.column);
          if (col === '*') {
            // t.* handled by caller via star expansion; bare * inside expr (count(*)) -> ignore
            return;
          }
          refs.push({ table: e.table ? norm(e.table) : null, column: col, scopes });
          return;
        }
        // nested SELECT (scalar subquery, EXISTS, IN-subquery...)
        if (e.ast && e.ast.type === 'select') {
          const inner = analyzeSelect(e.ast, scopes, project, parser, true, depth + 1);
          for (const oc of inner.outputs) {
            for (const inp of oc.inputs) refs.push({ table: null, column: null, passthrough: inp, scopes });
          }
          return;
        }
        for (const k of Object.keys(e)) {
          if (k === 'tableList' || k === 'columnList') continue;
          walk(e[k], scopes);
        }
      }
      walk(expr, scopes);
      return refs;
    }

    // Returns {inputs, found, ambiguous}. found=false means the ref could not be
    // tied to any scope entry (caller marks it unknown). An empty inputs array
    // with found=true is legitimate (e.g. count(*) has no column dependencies).
    function resolveRef(ref, scopes, project) {
      if (ref.passthrough) return { inputs: [ref.passthrough], found: true, ambiguous: false };
      const tryScopes = ref.scopes;
      const colN = norm(ref.column);
      if (ref.table) {
        for (const s of tryScopes) {
          if (s.alias === ref.table || norm(s.tableLabel).endsWith('.' + ref.table) || norm(s.tableLabel) === ref.table) {
            if (s.columns.has(colN)) return { inputs: [...s.columns.get(colN)], found: true, ambiguous: false };
            if (s.starUnknown) {
              // qualified ref into a table whose columns we don't know: keep the
              // requested name, flag unknown — never fake a resolution.
              return { inputs: [{ nodeId: s.nodeId, column: ref.column, unknown: true, tableLabel: s.tableLabel }], found: true, ambiguous: false };
            }
            return { inputs: [], found: false, ambiguous: false };
          }
        }
        return { inputs: [], found: false, ambiguous: false };
      }
      // unqualified: innermost scope level wins; multiple tables at that level
      // holding the column -> ambiguous, link all of them explicitly.
      let best = Infinity;
      const hits = [];
      for (const s of tryScopes) {
        if (!s.columns.has(colN)) continue;
        const d = s.depth || 0;
        if (d > best) continue;
        if (d < best) { best = d; hits.length = 0; }
        hits.push(...s.columns.get(colN));
      }
      if (hits.length || best !== Infinity) return { inputs: hits, found: true, ambiguous: hits.length > 1 };
      // fall back: any starUnknown scope could provide it — mark unknown explicitly,
      // keeping the requested column name and the candidate table label.
      const fb = [];
      for (const s of tryScopes) {
        if (s.starUnknown) fb.push({ nodeId: s.nodeId, column: ref.column, unknown: true, tableLabel: s.tableLabel });
      }
      if (fb.length) return { inputs: fb, found: true, ambiguous: fb.length > 1 };
      return { inputs: [], found: false, ambiguous: false };
    }

    // Analyze one SELECT ast. scopes = outer scopes (for correlated refs).
    // Returns { outputs: [{name, inputs:[{nodeId,column,unknown?}], star, ambiguous}], scope }
    function analyzeSelect(ast, outerScopes, project, parser, nested, depth) {
      depth = depth || 0;
      const scopes = [];
      // CTEs first (visible to FROM and to each other in order)
      const ctes = Array.isArray(ast.with) ? ast.with : [];
      for (const cte of ctes) {
        const cteName = cte.name && cte.name.value ? norm(cte.name.value) : null;
        if (!cteName || !cte.stmt || !cte.stmt.ast) continue;
        const inner = analyzeSelect(cte.stmt.ast, outerScopes.concat(scopes), project, parser, true, depth + 1);
        const columns = new Map();
        for (const oc of inner.outputs) columns.set(norm(oc.name), oc.inputs);
        scopes.push({ alias: cteName, nodeId: null, tableLabel: cteName, columns, starUnknown: false, isCte: true, depth });
      }
      // FROM items
      for (const f of ast.from || []) {
        if (f.expr && f.expr.ast) {
          // derived table
          const inner = analyzeSelect(f.expr.ast, outerScopes.concat(scopes), project, parser, true, depth + 1);
          const columns = new Map();
          for (const oc of inner.outputs) columns.set(norm(oc.name), oc.inputs);
          scopes.push({
            alias: norm(f.as || 'subq'), nodeId: null,
            tableLabel: f.as || 'subquery', columns, starUnknown: false, isSubquery: true, depth,
          });
        } else if (f.table) {
          // CTE reference?
          const cteHit = scopes.find((s) => s.isCte && s.alias === norm(f.table));
          if (cteHit) {
            scopes.push({ alias: norm(f.as || f.table), nodeId: null, tableLabel: f.table, columns: cteHit.columns, starUnknown: false, isCte: true, depth });
          } else {
            scopes.push(scopeEntryForTable(f.db || f.catalog, f.schema, f.table, f.as, project, depth));
          }
        }
      }
      const allScopes = scopes.concat(outerScopes);
      const outputs = [];
      let exprIdx = 0;
      for (const col of ast.columns || []) {
        const e = col.expr;
        const colN = e && e.type === 'column_ref' ? refColName(e.column) : null;
        if (e && e.type === 'column_ref' && colN === '*') {
          // star expansion
          const t = e.table ? norm(e.table) : null;
          const targets = t ? scopes.filter((s) => s.alias === t) : scopes;
          if (!targets.length && t) {
            outputs.push({ name: '*', inputs: [{ nodeId: null, column: '*', unknown: true, tableLabel: t }], star: true, ambiguous: true });
            continue;
          }
          for (const s of targets) {
            if (s.columns.size) {
              for (const [cn, inputs] of s.columns) {
                outputs.push({ name: displayOf(inputs, cn), inputs, star: true, ambiguous: false });
              }
            } else {
              outputs.push({ name: '*', inputs: [{ nodeId: s.nodeId, column: '*', unknown: true, viaStar: true }], star: true, ambiguous: true });
            }
          }
          continue;
        }
        const refs = collectRefs(e, allScopes, project, parser, depth);
        let inputs = [];
        let ambiguous = false;
        const seenIn = new Set();
        for (const r of refs) {
          const rr = resolveRef(r, allScopes, project);
          if (!rr.found) {
            inputs.push({ nodeId: null, column: r.column, unknown: true, tableLabel: r.table || '?' });
            ambiguous = true;
            continue;
          }
          if (rr.ambiguous) ambiguous = true;
          for (const inp of rr.inputs) {
            const k = (inp.nodeId || '?') + '::' + norm(inp.column);
            if (seenIn.has(k)) continue;
            seenIn.add(k);
            inputs.push(inp);
          }
        }
        let name = col.as || (e && e.type === 'column_ref' ? colN : null) || ('expr_' + (exprIdx++));
        // dedupe inputs
        const seen = new Set();
        inputs = inputs.filter((r) => {
          const k = (r.nodeId || '?') + '::' + norm(r.column);
          if (seen.has(k)) return false; seen.add(k); return true;
        });
        outputs.push({ name, inputs, star: false, ambiguous });
      }
      return { outputs, scope: scopes };
    }

    function displayOf(inputs, fallbackNorm) {
      // prefer the original-case column name from the single input when possible
      if (inputs.length === 1 && inputs[0].column && inputs[0].column !== '*') return inputs[0].column;
      return fallbackNorm;
    }

    function buildColumnLineage(project, dialect) {
      const parser = new ParserClass();
      const upstream = new Map(); // outKey -> {inputs:[{nodeId,column,unknown?,viaStar?}], viaStar, ambiguous, display}
      const columnsByNode = new Map();
      const displayName = new Map();
      const parseErrors = [];
      const starUnknownNodes = new Set();

      // seed columnsByNode with manifest columns; scope resolution consults this
      // live map so raw-SQL models see each other's computed columns.
      for (const [id, node] of project.nodes) {
        const cols = node.columns.map((c) => c.name);
        columnsByNode.set(id, cols);
        for (const c of cols) displayName.set(outKey(id, c), c);
      }
      project.computedColumns = columnsByNode;

      for (const [id, node] of project.nodes) {
        if (node.kind === 'source') continue;
        const sql = (node.compiledSql || '').trim();
        if (!sql) continue;
        let ast;
        try {
          ast = parser.parse(sql, { database: dialect || 'bigquery' }).ast;
        } catch (err) {
          parseErrors.push({ nodeId: id, error: String(err && err.message || err).slice(0, 200) });
          continue;
        }
        if (!ast || ast.type !== 'select') {
          parseErrors.push({ nodeId: id, error: 'not a SELECT statement' });
          continue;
        }
        let result;
        try {
          result = analyzeSelect(ast, [], project, parser, false);
        } catch (err) {
          parseErrors.push({ nodeId: id, error: 'analysis failed: ' + String(err && err.message || err).slice(0, 200) });
          continue;
        }
        const outCols = [];
        for (const oc of result.outputs) {
          const key = outKey(id, oc.name);
          const inputs = oc.inputs.map((r) => ({
            nodeId: r.nodeId, column: r.column == null ? '?' : r.column,
            unknown: !!r.unknown, viaStar: !!r.viaStar, tableLabel: r.tableLabel || null,
          }));
          upstream.set(key, { inputs, viaStar: !!oc.star, ambiguous: !!oc.ambiguous, display: oc.name });
          displayName.set(key, oc.name);
          if (oc.name !== '*') outCols.push(oc.name);
        }
        if (outCols.length) {
          columnsByNode.set(id, outCols);
        } else {
          starUnknownNodes.add(id);
          columnsByNode.set(id, ['*']);
          displayName.set(outKey(id, '*'), '*');
        }
      }
      return { upstream, columnsByNode, displayName, parseErrors, starUnknownNodes, project };
    }

    function buildDownstream(lineage) {
      const down = new Map(); // inKey -> Set(outKey)
      for (const [ok, info] of lineage.upstream) {
        for (const inp of info.inputs) {
          if (!inp.nodeId) continue;
          const ik = outKey(inp.nodeId, inp.column);
          if (!down.has(ik)) down.set(ik, new Set());
          down.get(ik).add(ok);
        }
      }
      return down;
    }

    function splitKey(k) {
      const i = k.lastIndexOf('::');
      return { nodeId: k.slice(0, i), column: k.slice(i + 2) };
    }

    // BFS blast radius from a column. Follows downstream edges; expands '*' pseudo-columns.
    function blastRadius(lineage, nodeId, column) {
      const down = lineage._downstream || (lineage._downstream = buildDownstream(lineage));
      const start = outKey(nodeId, column);
      const seen = new Set([start]);
      const affected = [];
      const queue = [{ key: start, depth: 0 }];
      while (queue.length) {
        const { key, depth } = queue.shift();
        let outs = down.get(key) || new Set();
        // '*' expansion: a hit on node::* also reaches everything downstream of node's real columns
        const { nodeId: nid, column: col } = splitKey(key);
        if (col === '*') {
          const cols = lineage.columnsByNode.get(nid) || [];
          for (const c of cols) {
            if (c === '*') continue;
            const ck = outKey(nid, c);
            for (const o of down.get(ck) || []) outs.add(o);
          }
        }
        for (const o of outs) {
          if (seen.has(o)) continue;
          seen.add(o);
          const { nodeId: onid, column: ocol } = splitKey(o);
          const info = lineage.upstream.get(o);
          affected.push({
            nodeId: onid, column: lineage.displayName.get(o) || ocol,
            depth: depth + 1, viaStar: !!(info && info.viaStar),
          });
          queue.push({ key: o, depth: depth + 1 });
        }
      }
      const models = [...new Set(affected.map((a) => a.nodeId))].filter((m) => m !== nodeId);
      return {
        start: { nodeId, column: lineage.displayName.get(start) || column },
        affected,
        models,
        modelCount: models.length,
        columnCount: affected.filter((a) => !(a.nodeId === nodeId && norm(a.column) === norm(column))).length,
      };
    }

    // BFS upstream chain (for highlight).
    function upstreamChain(lineage, nodeId, column) {
      const start = outKey(nodeId, column);
      const seen = new Set([start]);
      const chain = [];
      const queue = [start];
      while (queue.length) {
        const key = queue.shift();
        const info = lineage.upstream.get(key);
        if (!info) continue;
        for (const inp of info.inputs) {
          if (!inp.nodeId) continue;
          const ik = outKey(inp.nodeId, inp.column);
          if (seen.has(ik)) continue;
          seen.add(ik);
          const { nodeId: nid, column: c } = splitKey(ik);
          chain.push({ nodeId: nid, column: lineage.displayName.get(ik) || c, viaStar: !!inp.viaStar, unknown: !!inp.unknown });
          queue.push(ik);
        }
      }
      return { start: { nodeId, column: lineage.displayName.get(start) || column }, chain };
    }

    // Raw .sql files -> project. Unresolvable tables become kind:'unknown' nodes.
    function buildFromSqlFiles(files, dialect) {
      const project = { nodes: new Map(), relIndex: new Map(), nameIndex: new Map() };
      const ensureUnknown = (label) => {
        const id = 'unknown.' + norm(label).replace(/[^a-z0-9_]+/g, '_');
        if (!project.nodes.has(id)) {
          project.nodes.set(id, {
            id, kind: 'unknown', name: label, alias: label,
            database: '', schema: '', relation: norm(label),
            columns: [], dependsOn: [], compiledSql: '',
          });
          project.relIndex.set(norm(label), id);
          if (!project.nameIndex.has(norm(label))) project.nameIndex.set(norm(label), id);
        }
        return id;
      };
      for (const f of files) {
        const base = f.name.replace(/\.[^.]+$/, '');
        const id = 'model.raw.' + norm(base).replace(/[^a-z0-9_]+/g, '_');
        project.nodes.set(id, {
          id, kind: 'model', name: base, alias: base,
          database: '', schema: 'raw', relation: norm(base),
          columns: [], dependsOn: [], compiledSql: f.sql,
          fileName: f.name,
        });
        if (!project.nameIndex.has(norm(base))) project.nameIndex.set(norm(base), id);
      }
      // pre-scan: collect every table referenced so unknown nodes exist before lineage build
      const parser = new ParserClass();
      for (const [id, node] of project.nodes) {
        if (node.kind !== 'model') continue;
        try {
          const ast = parser.parse(node.compiledSql, { database: dialect || 'bigquery' }).ast;
          const tables = new Set();
          (function walk(n) {
            if (!n || typeof n !== 'object') return;
            if (Array.isArray(n)) return n.forEach(walk);
            if (n.table && typeof n.table === 'string') tables.add([n.db, n.table].filter(Boolean).join('.'));
            for (const k of Object.keys(n)) {
              if (k === 'tableList' || k === 'columnList') continue;
              walk(n[k]);
            }
          })(ast);
          for (const t of tables) {
            if (!resolveTable(t, project)) {
              const uid = ensureUnknown(t);
              node.dependsOn.push(uid);
            } else {
              const rid = resolveTable(t, project);
              if (rid && rid !== id && !node.dependsOn.includes(rid)) node.dependsOn.push(rid);
            }
          }
        } catch { /* parse error recorded later in buildColumnLineage */ }
      }
      return project;
    }

    return {
      parseManifest, buildColumnLineage, blastRadius, upstreamChain,
      buildFromSqlFiles, resolveTable, norm, outKey,
    };
  }

  return { createEngine };
});
