'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const notebooks = require('../src/main/notebooks');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cicada-notebook-'));
  try {
    const doc = notebooks.create('Research demo');
    doc.cells = [
      notebooks.cell('markdown', '# Experiment\nA markdown cell.'),
      notebooks.cell('code', 'x = 6\nprint("seeded", x)\n'),
      notebooks.cell('code', 'x * 7\n'),
      notebooks.cell('code', 'import pandas as pd\npd.DataFrame({"a": [1, 2], "b": [3, 4]})\n'),
      notebooks.cell('code', 'import matplotlib.pyplot as plt\nplt.plot([1,2,3],[1,4,9])\nplt.title("squares")\n'),
    ];
    notebooks.save(dir, 'analysis.ipynb', doc);
    const loaded = notebooks.load(dir, 'analysis.ipynb');
    assert.strictEqual(loaded.nbformat, 4);
    assert.strictEqual(loaded.cells.length, 5);

    const result = await notebooks.run(dir, 'analysis.ipynb', process.platform === 'win32' ? 'python' : 'python3');
    assert.strictEqual(result.ok, true, result.error);
    assert(result.notebook.cells[1].outputs.some((o) => o.output_type === 'stream' && /seeded 6/.test(o.text)));
    assert(result.notebook.cells[2].outputs.some((o) => o.data && o.data['text/plain'] === '42'));
    assert(result.notebook.cells[3].outputs.some((o) => o.data && o.data['application/vnd.cicada.table+json']));
    const image = result.notebook.cells[4].outputs.find((o) => o.cicada_path);
    assert(image && fs.existsSync(image.cicada_path));
    console.log('✓ notebook markdown, shared state, result, table, and figure checks passed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
