'use strict';
const fs = require('fs');
const path = require('path');
const { assert, engine } = require('./helpers');

function demoLineage() {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../assets/demo/manifest.json'), 'utf8'));
  return engine.buildColumnLineage(engine.parseManifest(manifest), 'bigquery');
}
const S = 'source.analytics.raw.customers';
const SO = 'source.analytics.raw.orders';
const SC = 'model.analytics.stg_customers';
const SOR = 'model.analytics.stg_orders';
const ICO = 'model.analytics.int_customer_orders';
const MCS = 'model.analytics.mart_customer_summary';
const MVC = 'model.analytics.mart_vip_customers';
const DBG = 'model.analytics.mart_orders_debug';

function affectedKeys(r) {
  return r.affected.map((a) => a.nodeId + '::' + a.column).sort();
}

const tests = [
  {
    name: 'blast radius of raw.orders.amount_cents reaches all downstream spend columns',
    fn() {
      const r = engine.blastRadius(demoLineage(), SO, 'amount_cents');
      assert.deepStrictEqual(affectedKeys(r), [
        DBG + '::amount',
        ICO + '::customer_tier',
        ICO + '::total_spent',
        MCS + '::customer_tier',
        MCS + '::total_spent',
        MVC + '::total_spent',
        SOR + '::amount',
      ].sort());
      assert.strictEqual(r.modelCount, 5);
    },
  },
  {
    name: 'blast radius of raw.customers.email is a clean rename chain',
    fn() {
      const r = engine.blastRadius(demoLineage(), S, 'email');
      assert.deepStrictEqual(affectedKeys(r), [
        ICO + '::email',
        MCS + '::email',
        MVC + '::email',
        SC + '::email',
      ].sort());
      assert.strictEqual(r.modelCount, 4);
      assert.strictEqual(r.columnCount, 4);
    },
  },
  {
    name: 'blast radius through SELECT * marks viaStar',
    fn() {
      const r = engine.blastRadius(demoLineage(), SOR, 'status');
      const hit = r.affected.find((a) => a.nodeId === DBG);
      assert(hit, 'expected mart_orders_debug in blast radius');
      assert(hit.viaStar, 'expected viaStar on star-propagated hit');
    },
  },
  {
    name: 'blast radius of an unused column is empty',
    fn() {
      const r = engine.blastRadius(demoLineage(), S, 'created_at');
      // created_at flows: stg_customers.created_at only
      assert.deepStrictEqual(affectedKeys(r), [SC + '::created_at']);
      assert.strictEqual(r.modelCount, 1);
    },
  },
  {
    name: 'upstream chain of mart_vip_customers.customer_id walks the rename chain',
    fn() {
      const c = engine.upstreamChain(demoLineage(), MVC, 'customer_id');
      assert.deepStrictEqual(c.chain.map((x) => x.nodeId + '::' + x.column), [
        MCS + '::customer_id',
        ICO + '::customer_id',
        SC + '::customer_id',
        S + '::id',
      ]);
    },
  },
  {
    name: 'upstream chain stops at sources (roots)',
    fn() {
      const c = engine.upstreamChain(demoLineage(), S, 'id');
      assert.deepStrictEqual(c.chain, []);
    },
  },
];

module.exports = { tests };
