'use strict';
const assert = require('assert');
const { Parser } = require('../assets/vendor/node-sql-parser.umd.js');
const BlastLineage = require('../assets/lineage.js');

const engine = BlastLineage.createEngine(Parser);

function inputsOf(lineage, nodeId, col) {
  const info = lineage.upstream.get(engine.outKey(nodeId, col));
  assert(info, `expected lineage for ${nodeId}::${col}`);
  return info.inputs;
}
function inputKeys(lineage, nodeId, col) {
  return inputsOf(lineage, nodeId, col).map((r) => (r.nodeId || '?') + '::' + r.column).sort();
}
function colsOf(lineage, nodeId) {
  return (lineage.columnsByNode.get(nodeId) || []).slice().sort();
}
module.exports = { assert, engine, inputsOf, inputKeys, colsOf };
