// fp-preload.js — AEGIS Shield: canvas & WebGL fingerprint randomizer.
//
// Attached to every content view (see contentWebPreferences in main.js) with
// contextIsolation: false so the patches land in the PAGE's own JavaScript
// world — an isolated-world preload would be invisible to site scripts. The
// preload stays sandboxed (no Node for the page) and exposes nothing: the
// whole file is one IIFE and `require` is the sandbox wrapper's parameter,
// never a window property. It runs before any page script.
//
// Noise model (Brave-style farbling):
//   * seed comes from the main process and changes on every AEGIS launch →
//     a fingerprint cannot be linked across sessions;
//   * the seed is combined with location.origin → the same canvas farbles
//     differently on two sites, which breaks cross-site linkage;
//   * the pattern is deterministic per (origin, size, read function) →
//     reading the same canvas twice returns the SAME bytes, so equality
//     checks, CAPTCHAs and anti-fraud "did it change?" tests keep working.
//
// Only the 1–2 least significant bits of sparse RGB pixels are flipped
// (alpha is never touched), which is visually imperceptible but changes every
// hash derived from the readback. toDataURL/toBlob/convertToBlob work on a
// scratch copy so the page's own canvas is never mutated; large canvases
// (> 2 MP, i.e. exports/snapshots rather than fingerprints) are left alone.
(() => {
  let cfg = null;
  try { cfg = require('electron').ipcRenderer.sendSync('shield-fp-bootstrap'); } catch (e) {}
  if (!cfg || !cfg.enabled || !cfg.seed) return;
  const SEED = String(cfg.seed);

  // ── Deterministic PRNG: FNV-1a hash → mulberry32 ──────────────────────────
  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Computed at call time: by then location is certainly the document's URL.
  function originKey() {
    try { return location.origin || String(location.href || ''); } catch (e) { return ''; }
  }

  // ── Sparse noise patterns, cached per (function, origin, geometry) ────────
  const patternCache = new Map();
  function getPattern(fn, w, h, extra) {
    const key = fn + '|' + originKey() + '|' + w + 'x' + h + (extra || '');
    let p = patternCache.get(key);
    if (p) return p;
    const rng = mulberry32(hash32(SEED + ' ' + key));
    const total = w * h;
    // ~1/16 of the pixels (1 … 1024): sparse enough to be imperceptible,
    // dense enough that any derived hash changes.
    const target = Math.max(1, Math.min(1024, Math.floor(total / 16)));
    const stride = Math.max(1, Math.floor(total / target));
    const start = Math.floor(rng() * stride);
    const idx = [];
    const mask = [];
    for (let i = start, n = 0; i < total && n < target; i += stride, n++) {
      const ch = Math.floor(rng() * 3);      // 0..2 — never the alpha channel
      idx.push(i * 4 + ch);
      mask.push(1 + Math.floor(rng() * 3));  // flip 1–2 LSBs (XOR 1, 2 or 3)
    }
    p = { idx: Int32Array.from(idx), mask: Uint8Array.from(mask) };
    if (patternCache.size >= 512) patternCache.clear();
    patternCache.set(key, p);
    return p;
  }
  function applyNoise(data, w, h, fn, extra) {
    if (!data || !data.length) return;
    const W = Math.abs(Math.trunc(Number(w))) || 0;
    const H = Math.abs(Math.trunc(Number(h))) || 0;
    if (!W || !H) return;
    const p = getPattern(fn, W, H, extra);
    const len = data.length;
    for (let i = 0; i < p.idx.length; i++) {
      const ix = p.idx[i];
      if (ix < len) data[ix] ^= p.mask[i];
    }
  }

  // ── Wrapper hygiene: native-looking name/length/toString ──────────────────
  function safeDefine(obj, name, fn, length) {
    try {
      Object.defineProperty(fn, 'name', { value: name, configurable: true });
      Object.defineProperty(fn, 'length', { value: length, configurable: true });
      Object.defineProperty(fn, 'toString', {
        value: () => 'function ' + name + '() { [native code] }',
        configurable: true,
      });
      Object.defineProperty(obj, name, { value: fn, writable: true, configurable: true });
      return true;
    } catch (e) { return false; }
  }

  const MAX_COPY_PIXELS = 2000000; // above this it's an export/snapshot, not a fingerprint

  // ── 2D readback: getImageData / toDataURL / toBlob ───────────────────────
  let origGetImageData = null;

  if (typeof CanvasRenderingContext2D !== 'undefined' &&
      typeof CanvasRenderingContext2D.prototype.getImageData === 'function') {
    origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    safeDefine(CanvasRenderingContext2D.prototype, 'getImageData',
      function (sx, sy, sw, sh) {
        const img = origGetImageData.call(this, sx, sy, sw, sh, arguments[4]);
        try { applyNoise(img.data, sw, sh, '2d'); } catch (e) {}
        return img;
      }, 4);
    // OffscreenCanvas 2d contexts normally inherit the patch above; patch a
    // browser that ships its own copy too.
    try {
      if (typeof OffscreenCanvasRenderingContext2D !== 'undefined' &&
          Object.prototype.hasOwnProperty.call(OffscreenCanvasRenderingContext2D.prototype, 'getImageData')) {
        safeDefine(OffscreenCanvasRenderingContext2D.prototype, 'getImageData',
          function (sx, sy, sw, sh) {
            const img = origGetImageData.call(this, sx, sy, sw, sh, arguments[4]);
            try { applyNoise(img.data, sw, sh, '2d'); } catch (e) {}
            return img;
          }, 4);
      }
    } catch (e) {}
  }

  if (typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.toDataURL === 'function' && origGetImageData) {
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    safeDefine(HTMLCanvasElement.prototype, 'toDataURL',
      function () {                       // length 0: type/quality are optional
        const type = arguments[0], quality = arguments[1];
        const w = this.width, h = this.height;
        if (!w || !h || w * h > MAX_COPY_PIXELS) return origToDataURL.call(this, type, quality);
        try {
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          if (!ctx) return origToDataURL.call(this, type, quality);
          ctx.drawImage(this, 0, 0);                 // scratch copy — page canvas untouched
          const img = origGetImageData.call(ctx, 0, 0, w, h);
          applyNoise(img.data, w, h, '2d');
          ctx.putImageData(img, 0, 0);
          return origToDataURL.call(c, type, quality);
        } catch (e) {
          return origToDataURL.call(this, type, quality); // tainted/unsupported → stock behaviour
        }
      }, 0);

    const origToBlob = HTMLCanvasElement.prototype.toBlob;
    safeDefine(HTMLCanvasElement.prototype, 'toBlob',
      function (callback) {               // length 1: only callback is required
        const type = arguments[1], quality = arguments[2];
        const w = this.width, h = this.height;
        if (!w || !h || w * h > MAX_COPY_PIXELS || typeof callback !== 'function') {
          return origToBlob.call(this, callback, type, quality);
        }
        try {
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const ctx = c.getContext('2d');
          if (!ctx) return origToBlob.call(this, callback, type, quality);
          ctx.drawImage(this, 0, 0);
          const img = origGetImageData.call(ctx, 0, 0, w, h);
          applyNoise(img.data, w, h, '2d');
          ctx.putImageData(img, 0, 0);
          origToBlob.call(c, callback, type, quality);
        } catch (e) {
          origToBlob.call(this, callback, type, quality);
        }
      }, 1);
  }

  if (typeof OffscreenCanvas !== 'undefined' &&
      typeof OffscreenCanvas.prototype.convertToBlob === 'function' && origGetImageData) {
    const origConvertToBlob = OffscreenCanvas.prototype.convertToBlob;
    safeDefine(OffscreenCanvas.prototype, 'convertToBlob',
      function () {                       // length 0: options is optional
        const options = arguments[0];
        const w = this.width, h = this.height;
        if (!w || !h || w * h > MAX_COPY_PIXELS) return origConvertToBlob.call(this, options);
        try {
          const c = new OffscreenCanvas(w, h);
          const ctx = c.getContext('2d');
          if (!ctx) return origConvertToBlob.call(this, options);
          ctx.drawImage(this, 0, 0);
          const img = origGetImageData.call(ctx, 0, 0, w, h);
          applyNoise(img.data, w, h, '2d');
          ctx.putImageData(img, 0, 0);
          return origConvertToBlob.call(c, options);
        } catch (e) {
          return origConvertToBlob.call(this, options);
        }
      }, 0);
  }

  // ── WebGL: readPixels noise + GPU string farbling ─────────────────────────
  // getParameter capability values (MAX_TEXTURE_SIZE …) are NEVER faked —
  // lying about them breaks rendering. Only the debug renderer strings are
  // farbled (one digit/letter, per origin) and the pixel readback is noised.
  const GL_UNMASKED_VENDOR = 0x9245;
  const GL_UNMASKED_RENDERER = 0x9246;

  function farbleGlString(str, kind) {
    if (typeof str !== 'string' || !str) return str;
    const rng = mulberry32(hash32(SEED + ' glstr ' + originKey() + ' ' + kind));
    const digits = [];
    const letters = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c >= 48 && c <= 57) digits.push(i);
      else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letters.push(i);
    }
    const pool = digits.length ? digits : letters;   // prefer version-like digits
    if (!pool.length) return str;
    const pos = pool[Math.floor(rng() * pool.length)];
    const code = str.charCodeAt(pos);
    let out;
    if (code >= 48 && code <= 57) {
      out = String.fromCharCode(48 + ((code - 48 + 1 + Math.floor(rng() * 9)) % 10));
    } else {
      const base = code >= 97 ? 97 : 65;
      out = String.fromCharCode(base + ((code - base + 1 + Math.floor(rng() * 25)) % 26));
    }
    return str.slice(0, pos) + out + str.slice(pos + 1);
  }

  function patchGL(proto) {
    if (typeof proto === 'undefined' || !proto) return;
    if (typeof proto.readPixels === 'function') {
      const origReadPixels = proto.readPixels;
      safeDefine(proto, 'readPixels',
        function (x, y, w, h, format, type, pixels) {   // length 7
          const r = origReadPixels.apply(this, arguments);
          try {
            // Only byte views (RGBA/UNSIGNED_BYTE fingerprints): Float32
            // readbacks are image-processing data where XOR would corrupt it.
            if (pixels && pixels.BYTES_PER_ELEMENT === 1 && typeof pixels.length === 'number' &&
                w > 0 && h > 0 && pixels.length >= w * h * 4) {
              applyNoise(pixels, w, h, 'gl', '|' + x + ',' + y);
            }
          } catch (e) {}
          return r;
        }, 7);
    }
    if (typeof proto.getParameter === 'function') {
      const origGetParameter = proto.getParameter;
      safeDefine(proto, 'getParameter',
        function (pname) {                 // length 1
          const v = origGetParameter.call(this, pname);
          try {
            if ((pname === GL_UNMASKED_VENDOR || pname === GL_UNMASKED_RENDERER) && typeof v === 'string') {
              return farbleGlString(v, pname === GL_UNMASKED_VENDOR ? 'vendor' : 'renderer');
            }
          } catch (e) {}
          return v;
        }, 1);
    }
  }
  if (typeof WebGLRenderingContext !== 'undefined') patchGL(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== 'undefined') patchGL(WebGL2RenderingContext.prototype);
})();
