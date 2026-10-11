import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

export const source = await readFile(new URL("../TripoRiggedModel.js", import.meta.url), "utf8");

export function loadLibrary(p, context = {}) {
  return runInNewContext(`${source}\nTripoRiggedModel;`, {
    ArrayBuffer, DataView, Uint8Array, TextDecoder, URL, Blob, File,
    p5: { instance: p, Geometry },
    fetch: (...args) => globalThis.fetch(...args),
    console, ...context,
  });
}

class Geometry {
  constructor() {
    this.vertices = [];
    this.vertexNormals = [];
    this.faces = [];
    this.uvs = [];
    this.dirtyFlags = {};
  }
}

export class Sketch {
  _renderer = { isP3D: true };
  canvas = { ownerDocument: { baseURI: "http://localhost/" } };
  width = 800;
  height = 500;
  deltaTime = 1000 / 60;
  RGB = "rgb";
  NORMAL = "normal";
  drawn = [];
  freed = [];
  lines = [];
  translations = [];
  scales = [];
  rotations = [];
  depth = 0;
  createVector(x, y, z) {
    return { x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; } };
  }
  model(geometry) { this.drawn.push(geometry); }
  freeGeometry(geometry) { this.freed.push(geometry); }
  loadImage(source, success) { success({ source, width: 2, height: 2 }); }
  push() { this.depth++; }
  pop() { this.depth--; }
  ambientLight() {}
  directionalLight() {}
  colorMode() {}
  noStroke() {}
  textureMode() {}
  fill() {}
  tint() {}
  texture() {}
  stroke() {}
  strokeWeight() {}
  line(...coords) { this.lines.push(coords); }
  translate(...coords) { this.translations.push(coords); }
  scale(value) { this.scales.push(value); }
  rotateX(value) { this.rotations.push(["x", value]); }
  rotateY(value) { this.rotations.push(["y", value]); }
  rotateZ(value) { this.rotations.push(["z", value]); }
  box() {}
  noFill() {}
  beginShape() {}
  vertex() {}
  endShape() {}
}

const assets = new Map();
export async function glb(name = "moon") {
  if (!assets.has(name)) {
    assets.set(name, await readFile(new URL(`../assets/${name}.glb`, import.meta.url)));
  }
  return assets.get(name);
}

export function response(bytes) {
  return {
    ok: true,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

export async function modelDemo(options = {}, name = "moon") {
  const p = new Sketch();
  const errors = [];
  const Loader = loadLibrary(p, {
    fetch: async () => response(await glb(name)),
    console: { error: (...args) => errors.push(args) },
  });
  const model = await Loader.load(`assets/${name}.glb`, options);
  return { p, model, Loader, errors };
}
