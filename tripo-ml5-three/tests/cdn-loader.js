const base = 'https://cdn.jsdelivr.net/npm/three@0.168.0/';
const sources = new Map();

export async function resolve(specifier, context, nextResolve) {
  let url;
  if (specifier === 'three') url = `${base}build/three.module.js`;
  else if (specifier.startsWith('three/addons/')) url = `${base}examples/jsm/${specifier.slice(13)}`;
  else if (specifier.startsWith(base)) url = specifier;
  else if (context.parentURL?.startsWith(base) && specifier.startsWith('.')) {
    url = new URL(specifier, context.parentURL).href;
  }
  if (url) return { url, shortCircuit: true };
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith(base)) return nextLoad(url, context);
  if (!sources.has(url)) {
    sources.set(url, fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`CDN load failed (${response.status}): ${url}`);
      return response.text();
    }));
  }
  return { format: 'module', source: await sources.get(url), shortCircuit: true };
}
