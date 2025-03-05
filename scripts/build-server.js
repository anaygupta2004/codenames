import fs from 'fs';
import { execSync } from 'child_process';

// Create build directory if it doesn't exist
if (!fs.existsSync('dist')) {
  fs.mkdirSync('dist');
}

// Use esbuild directly without TypeScript
try {
  console.log('Building server...');
  execSync('cp -r server/lib dist/ && node_modules/.bin/esbuild server/index.ts --platform=node --packages=external --outfile=dist/index.js --format=esm --target=es2020', { stdio: 'inherit' });
  console.log('Server build completed successfully');
} catch (error) {
  console.error('Server build failed:', error);
  process.exit(1);
} 