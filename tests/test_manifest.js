'use strict';
const { assert, engine } = require('./helpers');

function miniManifest() {
  return {
    nodes: {
      'model.p.m1': {
        resource_type: 'model', name: 'm1', alias: 'm1', database: 'db', schema: 's',
        relation_name: '"db"."s"."m1"',
        depends_on: { nodes: ['source.p.raw.t1'] },
        columns: { a: {}, b: {} },
        compiled_sql: 'select x as a, y as b from "db"."raw"."t1"',
      },
      'model.p.m2': {
        resource_type: 'model', name: 'm2', alias: 'm2', database: 'db', schema: 's',
        relation_name: '"db"."s"."m2"',
        depends_on: { nodes: [] },
        columns: {},
        raw_sql: 'select 1 as one', // no compiled_sql -> falls back to raw_sql
      },
      'test.p.t': { resource_type: 'test', name: 't' }, // skipped
    },
    sources: {
      'source.p.raw.t1': {
        resource_type: 'source', name: 't1', alias: 't1', database: 'db', schema: 'raw',
        relation_name: '"db"."raw"."t1"',
        columns: { x: {}, y: {} },
      },
    },
  };
}

const tests = [
  {
    name: 'parseManifest keeps models+seeds+snapshots+sources, skips tests',
    fn() {
      const p = engine.parseManifest(miniManifest());
      assert(p.nodes.has('model.p.m1'));
      assert(p.nodes.has('model.p.m2'));
      assert(p.nodes.has('source.p.raw.t1'));
      assert(!p.nodes.has('test.p.t'));
      assert.strictEqual(p.nodes.get('model.p.m1').kind, 'model');
      assert.strictEqual(p.nodes.get('source.p.raw.t1').kind, 'source');
    },
  },
  {
    name: 'parseManifest falls back to raw_sql when compiled_sql missing',
    fn() {
      const p = engine.parseManifest(miniManifest());
      assert.strictEqual(p.nodes.get('model.p.m2').compiledSql, 'select 1 as one');
    },
  },
  {
    name: 'parseManifest indexes relation names for resolution',
    fn() {
      const p = engine.parseManifest(miniManifest());
      assert.strictEqual(engine.resolveTable('"db"."raw"."t1"', p), 'source.p.raw.t1');
      assert.strictEqual(engine.resolveTable('db.raw.t1', p), 'source.p.raw.t1');
      assert.strictEqual(engine.resolveTable('t1', p), 'source.p.raw.t1');
      assert.strictEqual(engine.resolveTable('nope.nope.nope', p), null);
    },
  },
  {
    name: 'parseManifest records columns and dependsOn',
    fn() {
      const p = engine.parseManifest(miniManifest());
      const m1 = p.nodes.get('model.p.m1');
      assert.deepStrictEqual(m1.columns.map((c) => c.name).sort(), ['a', 'b']);
      assert.deepStrictEqual(m1.dependsOn, ['source.p.raw.t1']);
    },
  },
];

module.exports = { tests };
