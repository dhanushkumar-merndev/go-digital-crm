import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const assetPath = path.resolve(process.cwd(), 'public/Login Character Animation.lottie');
const animationPath = 'animations/c787c0e9-8a14-45f3-bd8a-1e6b4e4a44a4.json';
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'go-digital-lottie-'));
const cachedAnimationPath = '/tmp/login-lottie.json';

try {
  if (process.argv.includes('--restore-from-cache') && fs.existsSync(cachedAnimationPath)) {
    // Recovery switch for an interrupted local repack. It is intentionally
    // opt-in and only consumes the exact temporary extraction from this tool.
    fs.mkdirSync(path.dirname(path.join(workspace, animationPath)), { recursive: true });
    fs.writeFileSync(path.join(workspace, animationPath), fs.readFileSync(cachedAnimationPath));
    fs.writeFileSync(
      path.join(workspace, 'manifest.json'),
      JSON.stringify({
        version: '1',
        generator: '@dotlottie/dotlottie-js@1.7.0',
        author: '@dotlottie/dotlottie-js@1.7.0',
        animations: [{ id: 'c787c0e9-8a14-45f3-bd8a-1e6b4e4a44a4', playMode: 'normal' }],
      }),
    );
  } else if (fs.existsSync(assetPath)) {
    execFileSync('unzip', ['-q', assetPath, '-d', workspace]);
  } else {
    throw new Error(`Lottie asset is missing: ${assetPath}`);
  }
  const jsonPath = path.join(workspace, animationPath);
  const animation = fs.readFileSync(jsonPath, 'utf8');

  // Preserve the illustration's navy outlines and white highlights. All
  // coloured illustration accents use the same blue as the left-panel tagline
  // (#93C5FD), while the former teal/grey fill blends into the navy panel.
  const recolored = animation
    .replaceAll('[0,0.1686,0.1686,1]', '[0.0902,0.1373,0.2392,1]')
    .replaceAll('[0.22,0.376,1,1]', '[0.5765,0.7725,0.9922,1]')
    .replaceAll('[0.5725,0.6549,0.9961,1]', '[0.5765,0.7725,0.9922,1]')
    .replaceAll('[0.0431,0.3725,0.7765,1]', '[0.5765,0.7725,0.9922,1]')
    .replaceAll('[0.3249,0.4229,0.8151,1]', '[0.5765,0.7725,0.9922,1]')
    .replaceAll('[0.0196,0.2196,0.5451,1]', '[0.5765,0.7725,0.9922,1]')
    .replaceAll('[0.3765,0.6471,0.9804,1]', '[0.5765,0.7725,0.9922,1]');
  if (recolored === animation && !animation.includes('[0.5765,0.7725,0.9922,1]')) {
    throw new Error('Expected Lottie accent colours were not found.');
  }

  fs.writeFileSync(jsonPath, recolored);
  const rebuiltAssetPath = path.join(workspace, 'Login Character Animation.lottie');
  execFileSync('bsdtar', ['--format=zip', '-cf', rebuiltAssetPath, 'manifest.json', 'animations'], {
    cwd: workspace,
  });
  // The temporary directory may be mounted on a different filesystem in CI or
  // a sandbox, where rename() cannot cross devices.
  fs.copyFileSync(rebuiltAssetPath, assetPath);
  console.log('Recoloured auth Lottie accents to #93C5FD.');
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
