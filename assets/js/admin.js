(function () {
  'use strict';

  // ── Configuration ──────────────────────────────────────────────────────
  const API_BASE = 'https://gallery-admin.etzrodt-martin.workers.dev';
  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
  const MAX_IMAGE_WIDTH = 1920;
  const JPEG_QUALITY = 0.85;
  const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  // ── State ──────────────────────────────────────────────────────────────
  let galleryEntries = [];   // Current gallery.yml data
  let gallerySha = null;     // SHA of _data/gallery.yml for GitHub API updates
  let repoImages = [];       // All images in assets/images/gallery/
  let uploadedBlobs = {};    // filename → blob URL for preview of just-uploaded images
  let dragSrcIndex = null;

  // ── DOM refs ───────────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const loginSection = $('#admin-login');
  const panelSection = $('#admin-panel');
  const loginForm = $('#loginForm');
  const passwordInput = $('#adminPassword');
  const loginError = $('#loginError');
  const logoutBtn = $('#logoutBtn');
  const tabBtns = document.querySelectorAll('.admin-tab');
  const tabContents = document.querySelectorAll('.admin-tab-content');
  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');
  const uploadQueue = $('#uploadQueue');
  const galleryEditor = $('#galleryEditor');
  const galleryLoading = $('#galleryLoading');
  const galleryEmpty = $('#galleryEmpty');
  const galleryActions = $('#galleryActions');
  const unassignedSection = $('#unassignedSection');
  const unassignedList = $('#unassignedList');
  const previewBtn = $('#previewBtn');
  const saveBtn = $('#saveBtn');
  const previewModal = $('#previewModal');
  const previewContent = $('#previewContent');
  const closePreviewBtn = $('#closePreviewBtn');
  const adminToast = $('#adminToast');

  // ── JWT Helpers ────────────────────────────────────────────────────────
  function getToken() {
    return sessionStorage.getItem('admin_jwt');
  }

  function setToken(token) {
    sessionStorage.setItem('admin_jwt', token);
  }

  function clearToken() {
    sessionStorage.removeItem('admin_jwt');
  }

  function isTokenValid() {
    const token = getToken();
    if (!token) return false;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.exp * 1000 > Date.now();
    } catch {
      return false;
    }
  }

  function authHeaders() {
    return { 'Authorization': 'Bearer ' + getToken() };
  }

  // ── API Helpers ────────────────────────────────────────────────────────
  async function apiRequest(path, options = {}) {
    const url = API_BASE + path;
    const headers = { ...authHeaders(), ...options.headers };
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401) {
      clearToken();
      showLogin();
      throw new Error('Session expired');
    }
    return res;
  }

  // ── UI State Toggles ──────────────────────────────────────────────────
  function showLogin() {
    loginSection.hidden = false;
    panelSection.hidden = true;
    loginError.hidden = true;
    passwordInput.value = '';
  }

  function showPanel() {
    loginSection.hidden = true;
    panelSection.hidden = false;
    loadGalleryData();
  }

  // ── Toast ──────────────────────────────────────────────────────────────
  function showToast(message, type = 'success') {
    adminToast.textContent = message;
    adminToast.className = 'admin-toast admin-toast--' + type;
    adminToast.hidden = false;
    setTimeout(() => { adminToast.hidden = true; }, 4000);
  }

  // ── Login ──────────────────────────────────────────────────────────────
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = passwordInput.value;
    if (!password) return;

    loginError.hidden = true;
    const btn = loginForm.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    try {
      const res = await fetch(API_BASE + '/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();

      if (res.ok && data.token) {
        setToken(data.token);
        showPanel();
      } else {
        loginError.textContent = data.error || 'Invalid password';
        loginError.hidden = false;
      }
    } catch (err) {
      loginError.textContent = 'Connection failed. Please try again.';
      loginError.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });

  logoutBtn.addEventListener('click', () => {
    clearToken();
    showLogin();
  });

  // ── Tabs ───────────────────────────────────────────────────────────────
  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabBtns.forEach((b) => b.classList.remove('active'));
      tabContents.forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.getAttribute('data-tab');
      document.getElementById('tab-' + tab).classList.add('active');
    });
  });

  // ── Drag & Drop Upload ─────────────────────────────────────────────────
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files);
    fileInput.value = '';
  });

  function handleFiles(fileList) {
    Array.from(fileList).forEach((file) => {
      if (!ALLOWED_TYPES.includes(file.type)) {
        showToast('Skipped ' + file.name + ' — unsupported format', 'error');
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        showToast('Skipped ' + file.name + ' — exceeds 10 MB', 'error');
        return;
      }
      uploadFile(file);
    });
  }

  async function uploadFile(file) {
    // Create queue item UI
    const item = document.createElement('div');
    item.className = 'admin-upload-item';
    item.innerHTML =
      '<div class="admin-upload-thumb-wrap"><img class="admin-upload-thumb" alt=""></div>' +
      '<div class="admin-upload-info">' +
        '<span class="admin-upload-name">' + escapeHtml(file.name) + '</span>' +
        '<div class="admin-upload-progress"><div class="admin-upload-bar"></div></div>' +
        '<span class="admin-upload-status">Resizing…</span>' +
      '</div>';
    uploadQueue.prepend(item);

    const thumb = item.querySelector('.admin-upload-thumb');
    const bar = item.querySelector('.admin-upload-bar');
    const status = item.querySelector('.admin-upload-status');

    try {
      // Resize image client-side
      const { base64, blob, width, height } = await resizeImage(file);
      const blobUrl = URL.createObjectURL(blob);
      thumb.src = blobUrl;

      // Sanitize filename
      const filename = sanitizeFilename(file.name);

      // Store blob URL for preview
      uploadedBlobs[filename] = blobUrl;

      status.textContent = 'Uploading…';
      bar.style.width = '50%';

      // Upload to Worker
      const res = await apiRequest('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content: base64 }),
      });

      bar.style.width = '100%';

      if (res.ok) {
        status.textContent = 'Uploaded ✓';
        item.classList.add('admin-upload-done');
        // Refresh image list in background
        await loadRepoImages();
        renderUnassigned();
      } else {
        const data = await res.json();
        status.textContent = data.error || 'Upload failed';
        item.classList.add('admin-upload-error');
      }
    } catch (err) {
      status.textContent = 'Error: ' + err.message;
      item.classList.add('admin-upload-error');
    }
  }

  function sanitizeFilename(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .replace(/-+/g, '-');
  }

  // ── Image Resize ───────────────────────────────────────────────────────
  function resizeImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.onerror = reject;
      reader.readAsDataURL(file);

      img.onload = () => {
        let w = img.width;
        let h = img.height;

        if (w > MAX_IMAGE_WIDTH) {
          h = Math.round(h * (MAX_IMAGE_WIDTH / w));
          w = MAX_IMAGE_WIDTH;
        }

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        canvas.toBlob(
          (blob) => {
            const reader2 = new FileReader();
            reader2.onload = () => {
              const base64 = reader2.result.split(',')[1];
              resolve({ base64, blob, width: w, height: h });
            };
            reader2.onerror = reject;
            reader2.readAsDataURL(blob);
          },
          'image/jpeg',
          JPEG_QUALITY
        );
      };
      img.onerror = () => reject(new Error('Failed to load image'));
    });
  }

  // ── Gallery Data Loading ───────────────────────────────────────────────
  async function loadGalleryData() {
    galleryLoading.hidden = false;
    galleryEmpty.hidden = true;
    galleryActions.hidden = true;

    try {
      await Promise.all([loadGalleryYaml(), loadRepoImages()]);
      renderGalleryEditor();
      renderUnassigned();
    } catch (err) {
      galleryLoading.textContent = 'Failed to load gallery data.';
    }
  }

  async function loadGalleryYaml() {
    const res = await apiRequest('/gallery');
    if (res.ok) {
      const data = await res.json();
      galleryEntries = data.entries || [];
      gallerySha = data.sha || null;
    } else {
      galleryEntries = [];
      gallerySha = null;
    }
  }

  async function loadRepoImages() {
    const res = await apiRequest('/images');
    if (res.ok) {
      repoImages = await res.json();
    } else {
      repoImages = [];
    }
  }

  // ── Gallery Editor Rendering ───────────────────────────────────────────
  function renderGalleryEditor() {
    galleryLoading.hidden = true;
    galleryEditor.innerHTML = '';

    if (galleryEntries.length === 0) {
      galleryEmpty.hidden = false;
      galleryActions.hidden = true;
      return;
    }

    galleryEmpty.hidden = true;
    galleryActions.hidden = false;

    galleryEntries.forEach((entry, i) => {
      const imgUrl = getImageUrl(entry.image);
      const el = document.createElement('div');
      el.className = 'admin-gallery-item';
      el.draggable = true;
      el.setAttribute('data-index', i);
      el.innerHTML =
        '<span class="admin-drag-handle" title="Drag to reorder">&#9776;</span>' +
        '<img src="' + escapeHtml(imgUrl) + '" alt="" class="admin-gallery-thumb">' +
        '<div class="admin-gallery-fields">' +
          '<input type="text" class="admin-input admin-input-sm" placeholder="Caption" value="' + escapeHtml(entry.caption || '') + '" data-field="caption">' +
          '<input type="text" class="admin-input admin-input-sm" placeholder="Category" value="' + escapeHtml(entry.category || '') + '" data-field="category">' +
        '</div>' +
        '<button class="admin-delete-btn" title="Remove from gallery">&times;</button>';

      // Field change handlers
      el.querySelectorAll('input').forEach((input) => {
        input.addEventListener('input', () => {
          galleryEntries[i][input.getAttribute('data-field')] = input.value;
        });
      });

      // Delete handler
      el.querySelector('.admin-delete-btn').addEventListener('click', () => {
        galleryEntries.splice(i, 1);
        renderGalleryEditor();
        renderUnassigned();
      });

      // Drag handlers
      el.addEventListener('dragstart', (e) => {
        dragSrcIndex = i;
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      el.addEventListener('dragend', () => { el.classList.remove('dragging'); });
      el.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('drag-over');
      });
      el.addEventListener('dragleave', () => { el.classList.remove('drag-over'); });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('drag-over');
        if (dragSrcIndex !== null && dragSrcIndex !== i) {
          const moved = galleryEntries.splice(dragSrcIndex, 1)[0];
          galleryEntries.splice(i, 0, moved);
          renderGalleryEditor();
        }
        dragSrcIndex = null;
      });

      galleryEditor.appendChild(el);
    });
  }

  // ── Unassigned Images ──────────────────────────────────────────────────
  function renderUnassigned() {
    const assignedNames = new Set(galleryEntries.map((e) => e.image));
    const unassigned = repoImages.filter((img) => !assignedNames.has(img.name) && img.name !== '.gitkeep');

    if (unassigned.length === 0) {
      unassignedSection.hidden = true;
      return;
    }

    unassignedSection.hidden = false;
    unassignedList.innerHTML = '';

    unassigned.forEach((img) => {
      const imgUrl = getImageUrl(img.name);
      const el = document.createElement('div');
      el.className = 'admin-unassigned-item';
      el.innerHTML =
        '<img src="' + escapeHtml(imgUrl) + '" alt="" class="admin-gallery-thumb">' +
        '<span class="admin-unassigned-name">' + escapeHtml(img.name) + '</span>' +
        '<button class="btn btn-outline admin-add-btn">Add to Gallery</button>';

      el.querySelector('.admin-add-btn').addEventListener('click', () => {
        galleryEntries.push({ image: img.name, caption: '', category: '' });
        renderGalleryEditor();
        renderUnassigned();
        // Show actions bar now that we have items
        galleryEmpty.hidden = true;
        galleryActions.hidden = false;
      });

      unassignedList.appendChild(el);
    });
  }

  function getImageUrl(filename) {
    // Prefer blob URL for just-uploaded images not yet deployed
    if (uploadedBlobs[filename]) return uploadedBlobs[filename];
    // Fall back to the deployed site path
    return '/assets/images/gallery/' + filename;
  }

  // ── Preview ────────────────────────────────────────────────────────────
  previewBtn.addEventListener('click', () => {
    previewContent.innerHTML = '';

    if (galleryEntries.length === 0) {
      previewContent.innerHTML = '<p class="gallery-empty">No items to preview.</p>';
    } else {
      const grid = document.createElement('div');
      grid.className = 'gallery-grid';

      galleryEntries.forEach((entry) => {
        const imgUrl = getImageUrl(entry.image);
        const item = document.createElement('div');
        item.className = 'gallery-item';
        item.innerHTML =
          '<img src="' + escapeHtml(imgUrl) + '" alt="' + escapeHtml(entry.caption || '') + '" class="gallery-img">' +
          (entry.caption ? '<div class="gallery-caption"><p>' + escapeHtml(entry.caption) + '</p></div>' : '');
        grid.appendChild(item);
      });

      previewContent.appendChild(grid);
    }

    previewModal.hidden = false;
    document.body.style.overflow = 'hidden';
  });

  closePreviewBtn.addEventListener('click', closePreview);
  previewModal.addEventListener('click', (e) => {
    if (e.target === previewModal) closePreview();
  });

  function closePreview() {
    previewModal.hidden = true;
    document.body.style.overflow = '';
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !previewModal.hidden) closePreview();
  });

  // ── Publish ────────────────────────────────────────────────────────────
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Publishing…';

    try {
      const yaml = galleryToYaml(galleryEntries);
      const res = await apiRequest('/gallery', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: yaml, sha: gallerySha }),
      });

      if (res.ok) {
        const data = await res.json();
        gallerySha = data.sha;
        showToast('Published! Site will redeploy in ~60 seconds.');
      } else {
        const data = await res.json();
        showToast(data.error || 'Publish failed', 'error');
      }
    } catch (err) {
      showToast('Publish failed: ' + err.message, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Publish Changes';
    }
  });

  function galleryToYaml(entries) {
    if (entries.length === 0) return '# Gallery is empty\n';
    return entries.map((e) => {
      let yaml = '- image: "' + e.image + '"';
      if (e.caption) yaml += '\n  caption: "' + e.caption.replace(/"/g, '\\"') + '"';
      if (e.category) yaml += '\n  category: "' + e.category.replace(/"/g, '\\"') + '"';
      return yaml;
    }).join('\n\n') + '\n';
  }

  // ── Utilities ──────────────────────────────────────────────────────────
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // ── Init ───────────────────────────────────────────────────────────────
  if (isTokenValid()) {
    showPanel();
  } else {
    clearToken();
    showLogin();
  }

})();
