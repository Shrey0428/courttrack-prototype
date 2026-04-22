const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

async function pdfBufferToText(buffer) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'courttrack-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  await fs.promises.writeFile(pdfPath, buffer);

  try {
    const { stdout } = await execFileAsync('pdftotext', ['-layout', pdfPath, '-']);
    return stdout;
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { pdfBufferToText };
