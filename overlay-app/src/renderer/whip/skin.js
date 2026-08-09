
(function () {
  'use strict';

  const SKIN_ROOT = '../../assets/skins';

  const FALLBACK = {
    name: 'Vector fallback',
    images: {},
    colors: { core: '#2a1a10', outline: '#f6e4c1', glow: '#ffcf6b' },
    handle: { anchor: [0.12, 0.5], scale: 1, lengthScale: 1 },
    segment: { widthScale: 1, tileLength: 0 },
    tip: { anchor: [0, 0.5], scale: 1 },
    crack: { scale: 1 },
    spark: { scale: 1 }
  };

  async function loadSkin(name, root = SKIN_ROOT) {
    const base = `${root}/${name || 'default'}`;
    let meta = { ...FALLBACK };

    try {
      const response = await fetch(`${base}/skin.json`);
      if (response.ok) meta = deepMerge(FALLBACK, await response.json());
    } catch {
      console.warn(`[whip] no skin.json for "${name}" - using the vector renderer`);
    }

    const images = {};
    const entries = Object.entries(meta.images || {});
    await Promise.all(entries.map(async ([slot, file]) => {
      if (!file) return;
      const image = await loadImage(`${base}/${file}`);
      if (image) images[slot] = image;
    }));

    return { ...meta, name: meta.name || name, base, images, loaded: Object.keys(images) };
  }

  function loadImage(src) {
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => {
        console.warn(`[whip] could not load ${src}`);
        resolve(null);
      };
      image.src = src;
    });
  }

  function deepMerge(base, patch) {
    if (!isObject(base)) return patch;
    const out = { ...base };
    if (!isObject(patch)) return out;
    for (const [k, v] of Object.entries(patch)) {
      out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : v;
    }
    return out;
  }
  function isObject(v) { return Object.prototype.toString.call(v) === '[object Object]'; }

  window.WhipSkin = { loadSkin, FALLBACK, SKIN_ROOT };
})();
