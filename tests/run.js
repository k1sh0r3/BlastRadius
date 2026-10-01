/* BlastRadius test runner: node tests/run.js (needs NODE_PATH to node-sql-parser) */
'use strict';
const path = require('path');
const files = ['test_manifest.js', 'test_lineage.js', 'test_blast.js', 'test_raw.js'];
let pass = 0, fail = 0;
const failures = [];
for (const f of files) {
  const suite = require(path.join(__dirname, f));
  for (const t of suite.tests) {
    try {
      t.fn();
      pass++;
      console.log('  ok  ' + t.name);
    } catch (e) {
      fail++;
      failures.push(t.name + '\n      ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n      '));
      console.log('  FAIL ' + t.name);
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nFailures:\n' + failures.join('\n'));
  process.exit(1);
}
