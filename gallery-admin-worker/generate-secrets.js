#!/usr/bin/env node
// Helper script to generate the secrets needed for the gallery-admin Worker.
// Run: node generate-secrets.js <your-password>
//
// It will output the values to set via:
//   wrangler secret put ADMIN_PASSWORD_HASH
//   wrangler secret put ADMIN_PASSWORD_SALT
//   wrangler secret put JWT_SECRET

const crypto = require('crypto');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node generate-secrets.js <your-admin-password>');
  process.exit(1);
}

// Generate random salt (32 bytes)
const salt = crypto.randomBytes(32);
const saltHex = salt.toString('hex');

// Derive key via PBKDF2 (matches the Worker's verification)
crypto.pbkdf2(password, salt, 100000, 32, 'sha256', (err, derivedKey) => {
  if (err) throw err;

  const hashHex = derivedKey.toString('hex');
  const jwtSecret = crypto.randomBytes(32).toString('hex');

  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log('  Gallery Admin Worker — Generated Secrets');
  console.log('══════════════════════════════════════════════════════');
  console.log('');
  console.log('Run these commands in the gallery-admin-worker/ directory:');
  console.log('');
  console.log(`  echo "${hashHex}" | wrangler secret put ADMIN_PASSWORD_HASH`);
  console.log(`  echo "${saltHex}" | wrangler secret put ADMIN_PASSWORD_SALT`);
  console.log(`  echo "${jwtSecret}" | wrangler secret put JWT_SECRET`);
  console.log('');
  console.log('Then set your GitHub fine-grained PAT (Contents: read/write on etzm/etzm.github.io):');
  console.log('');
  console.log('  wrangler secret put GITHUB_TOKEN');
  console.log('  (paste your token when prompted)');
  console.log('');
  console.log('══════════════════════════════════════════════════════');
  console.log('');
});
