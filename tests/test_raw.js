'use strict';
const { assert, engine, inputKeys } = require('./helpers');

const tests = [
  {
    name: 'raw sql files become models; unresolvable tables become unknown nodes',
    fn() {
      const project = engine.buildFromSqlFiles([
        { name: 'mart.sql', sql: 'select a.id, b.val as v from analytics.staging.ta a join external_lookup b on a.id = b.id' },
      ], 'bigquery');
      assert(project.nodes.has('model.raw.mart'), 'mart model missing');
      const unk = [...project.nodes.values()].filter((n) => n.kind === 'unknown');
      assert(unk.length >= 1, 'expected at least one unknown node, got ' + unk.length);
      const lin = engine.buildColumnLineage(project, 'bigquery');
      // 'id' resolves against unknown node -> unknown input flagged
      const info = lin.upstream.get(engine.outKey('model.raw.mart', 'id'));
      assert(info, 'expected lineage for mart.id');
      assert(info.inputs.some((r) => r.unknown), 'expected unknown input, got ' + JSON.stringify(info.inputs));
    },
  },
  {
    name: 'two raw files resolve against each other',
    fn() {
      const project = engine.buildFromSqlFiles([
        { name: 'a.sql', sql: 'select id, val from raw_src' },
        { name: 'b.sql', sql: 'select id, val * 2 as double_val from a' },
      ], 'bigquery');
      const lin = engine.buildColumnLineage(project, 'bigquery');
      assert(!lin.parseErrors.length, JSON.stringify(lin.parseErrors));
      assert.deepStrictEqual(inputKeys(lin, 'model.raw.b', 'double_val'), ['model.raw.a::val']);
      // raw_src became an unknown node with unknown columns; a.id links to it as unknown
      const info = lin.upstream.get(engine.outKey('model.raw.a', 'id'));
      assert(info.inputs.some((r) => r.unknown), 'expected unknown input for a.id');
    },
  },
  {
    name: 'invalid raw sql records a parse error',
    fn() {
      const project = engine.buildFromSqlFiles([{ name: 'bad.sql', sql: 'select from where (((' }], 'bigquery');
      const lin = engine.buildColumnLineage(project, 'bigquery');
      assert(lin.parseErrors.some((e) => e.nodeId === 'model.raw.bad'));
    },
  },
  {
    name: 'CTEs resolve on non-bigquery dialects (parser CTE shape differs)',
    fn() {
      for (const dialect of ['postgresql', 'mysql', 'sqlite']) {
        const project = engine.buildFromSqlFiles([
          { name: 't1.sql', sql: 'select a, b from raw_stuff' },
          { name: 't2.sql', sql: 'with c as (select * from t1) select a from c' },
        ], dialect);
        const lin = engine.buildColumnLineage(project, dialect);
        assert(!lin.parseErrors.length, dialect + ' parse errors: ' + JSON.stringify(lin.parseErrors));
        assert.deepStrictEqual(inputKeys(lin, 'model.raw.t2', 'a'), ['model.raw.t1::a'], dialect);
      }
    },
  },
  {
    name: 'CTE referenced inside another CTE resolves; no phantom unknown nodes',
    fn() {
      const project = engine.buildFromSqlFiles([
        { name: 's.sql', sql: 'select id, amount from raw_src' },
        { name: 'm.sql', sql: 'with base as (select id, amount from s), agg as (select id, sum(amount) as total from base group by id) select id, total from agg' },
      ], 'postgresql');
        const unknowns = [...project.nodes.keys()].filter((k) => k.startsWith('unknown.'));
      assert.deepStrictEqual(unknowns, ['unknown.raw_src'], 'phantom unknowns: ' + unknowns.join(', '));
      const lin = engine.buildColumnLineage(project, 'postgresql');
      assert(!lin.parseErrors.length, JSON.stringify(lin.parseErrors));
      assert.deepStrictEqual(inputKeys(lin, 'model.raw.m', 'total'), ['model.raw.s::amount']);
      const info = lin.upstream.get(engine.outKey('model.raw.m', 'total'));
      assert(!info.ambiguous, 'spurious ambiguity flag');
    },
  },
  {
    name: 'mysql/sqlite: dotted table names are dequalified before parsing',
    fn() {
      for (const dialect of ['mysql', 'sqlite']) {
        const project = engine.buildFromSqlFiles([
          { name: 'a.sql', sql: 'select id, amount from raw_src' },
          { name: 'b.sql', sql: 'select x.id, y.amount * 2 as d from "db"."sch"."a" x join a y on x.id = y.id' },
        ], dialect);
        const lin = engine.buildColumnLineage(project, dialect);
        assert(!lin.parseErrors.length, dialect + ' parse errors: ' + JSON.stringify(lin.parseErrors));
        // qualified column refs (x.id, y.amount) must survive dequalification
        assert.deepStrictEqual(inputKeys(lin, 'model.raw.b', 'id'), ['model.raw.a::id'], dialect);
        assert.deepStrictEqual(inputKeys(lin, 'model.raw.b', 'd'), ['model.raw.a::amount'], dialect);
      }
    },
  },
];

module.exports = { tests };
