// Gallery Admin Worker — Cloudflare Worker backend for the gallery CMS
// Handles authentication (PBKDF2 + JWT) and proxies GitHub API calls.
// All secrets stored via `wrangler secret put`. Zero npm dependencies.

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 3600; // 1 hour
const JWT_EXPIRY = 2 * 60 * 60; // 2 hours
const GITHUB_API = 'https://api.github.com';

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(env.ALLOWED_ORIGIN) });
    }

    // Origin validation
    const origin = request.headers.get('Origin');
    if (!origin || origin !== env.ALLOWED_ORIGIN) {
      return json({ error: 'Forbidden' }, 403, env.ALLOWED_ORIGIN);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ── Public route: authentication ──────────────────────────────
      if (path === '/auth' && request.method === 'POST') {
        return await handleAuth(request, env);
      }

      // ── All other routes require valid JWT ────────────────────────
      const payload = await verifyJWT(request, env);
      if (!payload) {
        return json({ error: 'Unauthorized' }, 401, env.ALLOWED_ORIGIN);
      }

      // ── Image routes ──────────────────────────────────────────────
      if (path === '/images' && request.method === 'GET') {
        return await listImages(env);
      }

      if (path === '/upload' && request.method === 'POST') {
        return await uploadImage(request, env);
      }

      if (path === '/delete-image' && request.method === 'POST') {
        return await deleteImage(request, env);
      }

      // ── Gallery data routes ───────────────────────────────────────
      if (path === '/gallery' && request.method === 'GET') {
        return await getGallery(env);
      }

      if (path === '/gallery' && request.method === 'PUT') {
        return await updateGallery(request, env);
      }

      return json({ error: 'Not found' }, 404, env.ALLOWED_ORIGIN);
    } catch (err) {
      console.error('Worker error:', err);
      return json({ error: 'Internal server error' }, 500, env.ALLOWED_ORIGIN);
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════
// Authentication
// ═══════════════════════════════════════════════════════════════════════

async function handleAuth(request, env) {
  // Rate limiting
  if (env.RATE_LIMIT) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const key = `auth-rate:${ip}`;
    const current = await env.RATE_LIMIT.get(key);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= RATE_LIMIT_MAX) {
      return json({ error: 'Too many attempts. Try again later.' }, 429, env.ALLOWED_ORIGIN);
    }
    await env.RATE_LIMIT.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW });
  }

  const { password } = await request.json();
  if (!password) {
    return json({ error: 'Password required' }, 400, env.ALLOWED_ORIGIN);
  }

  // Verify password via PBKDF2
  const isValid = await verifyPassword(password, env.ADMIN_PASSWORD_HASH, env.ADMIN_PASSWORD_SALT);
  if (!isValid) {
    return json({ error: 'Invalid password' }, 401, env.ALLOWED_ORIGIN);
  }

  // Issue JWT
  const token = await signJWT({ sub: 'admin', iat: now(), exp: now() + JWT_EXPIRY }, env.JWT_SECRET);
  return json({ token }, 200, env.ALLOWED_ORIGIN);
}

// ═══════════════════════════════════════════════════════════════════════
// PBKDF2 Password Verification
// ═══════════════════════════════════════════════════════════════════════

async function verifyPassword(password, storedHashHex, saltHex) {
  const enc = new TextEncoder();
  const salt = hexToBuffer(saltHex);

  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );

  const derivedHex = bufferToHex(new Uint8Array(derivedBits));
  return timingSafeEqual(derivedHex, storedHashHex);
}

// ═══════════════════════════════════════════════════════════════════════
// JWT (HS256 via Web Crypto API)
// ═══════════════════════════════════════════════════════════════════════

async function signJWT(payload, secretHex) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = encodedHeader + '.' + encodedPayload;

  const key = await crypto.subtle.importKey(
    'raw', hexToBuffer(secretHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const encodedSig = base64urlFromBuffer(new Uint8Array(sig));

  return signingInput + '.' + encodedSig;
}

async function verifyJWT(request, env) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;

  const token = auth.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const signingInput = parts[0] + '.' + parts[1];
  const signature = base64urlToBuffer(parts[2]);

  const key = await crypto.subtle.importKey(
    'raw', hexToBuffer(env.JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );

  const valid = await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(signingInput));
  if (!valid) return null;

  const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
  if (payload.exp && payload.exp < now()) return null;

  return payload;
}

// ═══════════════════════════════════════════════════════════════════════
// GitHub API: Images
// ═══════════════════════════════════════════════════════════════════════

async function listImages(env) {
  const res = await github(env, 'GET', `/repos/${env.GITHUB_REPO}/contents/assets/images/gallery`);

  if (res.status === 404) {
    return json([], 200, env.ALLOWED_ORIGIN);
  }

  const data = await res.json();

  if (!Array.isArray(data)) {
    return json([], 200, env.ALLOWED_ORIGIN);
  }

  const images = data
    .filter((f) => f.type === 'file' && f.name !== '.gitkeep')
    .map((f) => ({ name: f.name, sha: f.sha, size: f.size, download_url: f.download_url }));

  return json(images, 200, env.ALLOWED_ORIGIN);
}

async function uploadImage(request, env) {
  const { filename, content } = await request.json();

  if (!filename || !content) {
    return json({ error: 'filename and content (base64) required' }, 400, env.ALLOWED_ORIGIN);
  }

  // Check if file already exists to get its SHA
  const existingRes = await github(env, 'GET', `/repos/${env.GITHUB_REPO}/contents/assets/images/gallery/${filename}`);
  let sha = undefined;
  if (existingRes.ok) {
    const existing = await existingRes.json();
    sha = existing.sha;
  }

  const body = {
    message: `Add gallery image: ${filename}`,
    content: content,
    branch: env.GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await github(env, 'PUT', `/repos/${env.GITHUB_REPO}/contents/assets/images/gallery/${filename}`, body);

  if (res.ok) {
    const data = await res.json();
    return json({ sha: data.content.sha, name: filename }, 201, env.ALLOWED_ORIGIN);
  }

  const err = await res.text();
  console.error('GitHub upload error:', err);
  return json({ error: 'Upload failed' }, 500, env.ALLOWED_ORIGIN);
}

async function deleteImage(request, env) {
  const { filename, sha } = await request.json();

  if (!filename || !sha) {
    return json({ error: 'filename and sha required' }, 400, env.ALLOWED_ORIGIN);
  }

  const res = await github(env, 'DELETE', `/repos/${env.GITHUB_REPO}/contents/assets/images/gallery/${filename}`, {
    message: `Remove gallery image: ${filename}`,
    sha: sha,
    branch: env.GITHUB_BRANCH,
  });

  if (res.ok) {
    return json({ success: true }, 200, env.ALLOWED_ORIGIN);
  }

  const err = await res.text();
  console.error('GitHub delete error:', err);
  return json({ error: 'Delete failed' }, 500, env.ALLOWED_ORIGIN);
}

// ═══════════════════════════════════════════════════════════════════════
// GitHub API: Gallery YAML
// ═══════════════════════════════════════════════════════════════════════

async function getGallery(env) {
  const res = await github(env, 'GET', `/repos/${env.GITHUB_REPO}/contents/_data/gallery.yml`);

  if (res.status === 404) {
    return json({ entries: [], sha: null }, 200, env.ALLOWED_ORIGIN);
  }

  const data = await res.json();
  const content = atob(data.content.replace(/\n/g, ''));

  // Parse simple YAML (array of objects with image, caption, category)
  const entries = parseSimpleYaml(content);

  return json({ entries, sha: data.sha }, 200, env.ALLOWED_ORIGIN);
}

async function updateGallery(request, env) {
  const { content, sha } = await request.json();

  if (content === undefined) {
    return json({ error: 'content (YAML string) required' }, 400, env.ALLOWED_ORIGIN);
  }

  // Get current SHA if not provided
  let currentSha = sha;
  if (!currentSha) {
    const getRes = await github(env, 'GET', `/repos/${env.GITHUB_REPO}/contents/_data/gallery.yml`);
    if (getRes.ok) {
      const data = await getRes.json();
      currentSha = data.sha;
    }
  }

  const body = {
    message: 'Update gallery data',
    content: btoa(content),
    branch: env.GITHUB_BRANCH,
  };
  if (currentSha) body.sha = currentSha;

  const res = await github(env, 'PUT', `/repos/${env.GITHUB_REPO}/contents/_data/gallery.yml`, body);

  if (res.ok) {
    const data = await res.json();
    return json({ sha: data.content.sha }, 200, env.ALLOWED_ORIGIN);
  }

  const err = await res.text();
  console.error('GitHub gallery update error:', err);
  return json({ error: 'Update failed' }, 500, env.ALLOWED_ORIGIN);
}

// ═══════════════════════════════════════════════════════════════════════
// Simple YAML Parser (for gallery.yml structure only)
// ═══════════════════════════════════════════════════════════════════════

function parseSimpleYaml(yaml) {
  const entries = [];
  let current = null;

  const lines = yaml.split('\n');
  for (const line of lines) {
    // Skip comments and empty lines
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // New array entry
    if (trimmed.startsWith('- ')) {
      if (current) entries.push(current);
      current = {};
      const kv = trimmed.slice(2);
      const parsed = parseYamlKV(kv);
      if (parsed) current[parsed.key] = parsed.value;
    } else if (current && trimmed.includes(':')) {
      // Continuation key
      const parsed = parseYamlKV(trimmed);
      if (parsed) current[parsed.key] = parsed.value;
    }
  }

  if (current) entries.push(current);
  return entries;
}

function parseYamlKV(str) {
  const match = str.match(/^(\w+)\s*:\s*(.*)$/);
  if (!match) return null;
  let value = match[2].trim();
  // Remove surrounding quotes
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key: match[1], value };
}

// ═══════════════════════════════════════════════════════════════════════
// GitHub API Helper
// ═══════════════════════════════════════════════════════════════════════

async function github(env, method, path, body) {
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'gallery-admin-worker',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  return fetch(GITHUB_API + path, opts);
}

// ═══════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════

function now() {
  return Math.floor(Date.now() / 1000);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes.buffer;
}

function bufferToHex(buffer) {
  return Array.from(buffer).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function base64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlFromBuffer(buffer) {
  let binary = '';
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuffer(str) {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
