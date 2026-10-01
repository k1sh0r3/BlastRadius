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
];

module.exports = { tests };
