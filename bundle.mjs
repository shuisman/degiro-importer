import { copyFileSync, readFileSync, rmSync } from 'fs';
import { execSync } from 'child_process';

// Wealthfolio's (Rust) manifest parser rejects a UTF-8 BOM or invalid JSON with
// "expected value at line 1 column 1" — fail here instead of at install time.
const manifest = readFileSync('manifest.json', 'utf8');
if (manifest.charCodeAt(0) === 0xfeff) {
  throw new Error('manifest.json starts with a UTF-8 BOM; save it as UTF-8 without BOM');
}
JSON.parse(manifest);

copyFileSync('manifest.json', 'dist/manifest.json');

// Zip dist/ contents at the archive root. PowerShell on Windows, `zip` elsewhere
// (same as CI). Remove any old zip first: `zip` updates an existing archive.
rmSync('degiro-importer.zip', { force: true });
if (process.platform === 'win32') {
  execSync(
    'powershell -Command "Compress-Archive -Path dist\\* -DestinationPath degiro-importer.zip -Force"',
  );
} else {
  execSync("cd dist && zip -r ../degiro-importer.zip . -x '*.map'");
}
console.log('Created degiro-importer.zip');
