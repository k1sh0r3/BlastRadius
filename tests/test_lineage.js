'use strict';
const fs = require('fs');
const path = require('path');
const { assert, engine, inputKeys, colsOf } = require('./helpers');

function demoProject() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/demo/manifest.json'), 'utf8'));
  return engine.parseManifest(manifest);
}
const S = 'source.analytics.raw.customers';
const SO = 'source.analytics.raw.orders';
const SC = 'model.analytics.stg_customers';
const SOR = 'model.analytics.stg_orders';
const ICO = 'model.analytics.int_customer_orders';
const MCS = 'model.analytics.mart_customer_summary';
const MVC = 'model.analytics.mart_vip_customers';
const DBG = 'model.analytics.mart_orders_debug';

const tests = [
  {
    name: 'rename is traced: stg_customers.customer_id -> raw.customers.id',
    fn() {
      const lin = engine.buildColumnLineage(demoProject(), 'bigquery');
      assert(!lin.parseErrors.length, 'parse errors: ' + JSON.stringify(lin.parseErrors));
      assert.deepStrictEqual(inputKeys(lin, SC, 'customer_id'), [S + '::id']);
    },
  },
  {
    name: 'expression traced: stg_orders.amount -> raw.orders.amount_cents',
    fn() {
      const lin = engine.buildColumnLineage(demoProject(), 'bigquery');
      assert.deepStrictEqual(inputKeys(lin, SOR, 'amount'), [SO + '::amount_cents']);
      assert.deepStrictEqual(inputKeys(lin, SOR, 'order_id'), [SO + '::order_id']);
    },
  },
  {
    name: 'CTE + join: int_customer_orders maps through order_stats',
    fn() {
      const lin = engine.buildColumnLineage(demoProject(), 'bigquery');
      assert.deepStrictEqual(inputKeys(lin, ICO, 'customer_id'), [SC + '::customer_id']);
      assert.deepStrictEqual(inputKeys(lin, ICO, 'name'), [SC + '::name']);
      assert.deepStrictEqual(inputKeys(lin, ICO, 'total_spent'), [SOR + '::amount']);
      // customer_tier = case on total_spent -> traces to stg_orders.amount
      assert.deepStrictEqual(inputKeys(lin, ICO, 'customer_tier'), [SOR + '::amount']);
    },
  },
  {
    name: 'count(*) yields a column with no column inputs (honest, not faked)',
    fn() {
      const lin = engine.buildColumnLineage(demoProject(), 'bigquery');
      assert.deepStrictEqual(inputKeys(lin, ICO, 'order_count'), []);
    },
  },
  {
    name: 'multi-hop chain resolves through marts',
    fn() {
      const lin = engine.buildColumnLineage(demoProject(), 'bigquery');
      assert.deepStrictEqual(inputKeys(lin, MVC, 'total_spent'), [MCS + '::total_spent']);
      assert.deepStrictEqual(inputKeys(lin, MCS, 'total_spent'), [ICO + '::total_spent']);
    },
  },
  {
    name: 'SELECT * expands to upstream columns and is flagged viaStar',
    fn() {
      const lin = engine.buildColumnLineage(demoProject(), 'bigquery');
      const cols = colsOf(lin, DBG);
      assert.deepStrictEqual(cols, ['amount', 'customer_id', 'order_id', 'ordered_at', 'status']);
      const info = lin.upstream.get(engine.outKey(DBG, 'amount'));
      assert(info.viaStar, 'expected viaStar flag');
      assert.deepStrictEqual(inputKeys(lin, DBG, 'amount'), [SOR + '::amount']);
    },
  },
  {
    name: 'join with aliases resolves qualified refs',
    fn() {
      const project = engine.parseManifest({
        nodes: {
          'model.p.j': {
            resource_type: 'model', name: 'j', alias: 'j', database: 'd', schema: 's',
            relation_name: '"d"."s"."j"', depends_on: { nodes: [] }, columns: {},
            compiled_sql: 'select a.id as aid, b.val from "d"."s"."ta" a join "d"."s"."tb" b on a.id = b.id',
          },
          'model.p.ta': {
            resource_type: 'model', name: 'ta', alias: 'ta', database: 'd', schema: 's',
            relation_name: '"d"."s"."ta"', depends_on: { nodes: [] },
            columns: { id: {}, x: {} }, compiled_sql: 'select 1 as id',
          },
          'model.p.tb': {
            resource_type: 'model', name: 'tb', alias: 'tb', database: 'd', schema: 's',
            relation_name: '"d"."s"."tb"', depends_on: { nodes: [] },
            columns: { id: {}, val: {} }, compiled_sql: 'select 1 as id',
          },
        },
        sources: {},
      });
      const lin = engine.buildColumnLineage(project, 'bigquery');
      assert(!lin.parseErrors.length, JSON.stringify(lin.parseErrors));
      assert.deepStrictEqual(inputKeys(lin, 'model.p.j', 'aid'), ['model.p.ta::id']);
      assert.deepStrictEqual(inputKeys(lin, 'model.p.j', 'val'), ['model.p.tb::val']);
    },
  },
  {
    name: 'ambiguous unqualified column links all candidates and flags ambiguous',
    fn() {
      const project = engine.parseManifest({
        nodes: {
          'model.p.j': {
            resource_type: 'model', name: 'j', alias: 'j', database: 'd', schema: 's',
            relation_name: '"d"."s"."j"', depends_on: { nodes: [] }, columns: {},
            compiled_sql: 'select id from "d"."s"."ta" a, "d"."s"."tb" b',
          },
          'model.p.ta': {
            resource_type: 'model', name: 'ta', alias: 'ta', database: 'd', schema: 's',
            relation_name: '"d"."s"."ta"', depends_on: { nodes: [] },
            columns: { id: {} }, compiled_sql: 'select 1 as id',
          },
          'model.p.tb': {
            resource_type: 'model', name: 'tb', alias: 'tb', database: 'd', schema: 's',
            relation_name: '"d"."s"."tb"', depends_on: { nodes: [] },
            columns: { id: {} }, compiled_sql: 'select 1 as id',
          },
        },
        sources: {},
      });
      const lin = engine.buildColumnLineage(project, 'bigquery');
      const keys = inputKeys(lin, 'model.p.j', 'id');
      assert.deepStrictEqual(keys, ['model.p.ta::id', 'model.p.tb::id']);
      assert(lin.upstream.get(engine.outKey('model.p.j', 'id')).ambiguous);
    },
  },
  {
    name: 'unresolvable table is marked unknown explicitly, never faked',
    fn() {
      const project = engine.parseManifest({
        nodes: {
          'model.p.j': {
            resource_type: 'model', name: 'j', alias: 'j', database: 'd', schema: 's',
            relation_name: '"d"."s"."j"', depends_on: { nodes: [] }, columns: {},
            compiled_sql: 'select z from mystery_table',
          },
        },
        sources: {},
      });
      const lin = engine.buildColumnLineage(project, 'bigquery');
      const info = lin.upstream.get(engine.outKey('model.p.j', 'z'));
      assert(info.inputs.length === 1 && info.inputs[0].unknown, 'expected unknown input');
      assert.strictEqual(info.inputs[0].tableLabel, 'mystery_table');
      assert.strictEqual(info.inputs[0].column, 'z');
    },
  },
  {
    name: 'scalar subquery in SELECT is traced',
    fn() {
      const project = engine.parseManifest({
        nodes: {
          'model.p.j': {
            resource_type: 'model', name: 'j', alias: 'j', database: 'd', schema: 's',
            relation_name: '"d"."s"."j"', depends_on: { nodes: [] }, columns: {},
            compiled_sql: 'select (select max(val) from "d"."s"."tb") as mx, id from "d"."s"."ta"',
          },
          'model.p.ta': {
            resource_type: 'model', name: 'ta', alias: 'ta', database: 'd', schema: 's',
            relation_name: '"d"."s"."ta"', depends_on: { nodes: [] },
            columns: { id: {} }, compiled_sql: 'select 1 as id',
          },
          'model.p.tb': {
            resource_type: 'model', name: 'tb', alias: 'tb', database: 'd', schema: 's',
            relation_name: '"d"."s"."tb"', depends_on: { nodes: [] },
            columns: { val: {} }, compiled_sql: 'select 1 as val',
          },
        },
        sources: {},
      });
      const lin = engine.buildColumnLineage(project, 'bigquery');
      assert(!lin.parseErrors.length, JSON.stringify(lin.parseErrors));
      assert.deepStrictEqual(inputKeys(lin, 'model.p.j', 'mx'), ['model.p.tb::val']);
    },
  },
  {
    name: 'invalid SQL is recorded in parseErrors, not thrown',
    fn() {
      const project = engine.parseManifest({
        nodes: {
          'model.p.bad': {
            resource_type: 'model', name: 'bad', alias: 'bad', database: 'd', schema: 's',
            relation_name: '"d"."s"."bad"', depends_on: { nodes: [] }, columns: { a: {} },
            compiled_sql: 'select from where ((((',
          },
        },
        sources: {},
      });
      const lin = engine.buildColumnLineage(project, 'bigquery');
      assert.strictEqual(lin.parseErrors.length, 1);
      assert.strictEqual(lin.parseErrors[0].nodeId, 'model.p.bad');
    },
  },
];

module.exports = { tests };
