import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TripoP5, parseGLB } from '../TripoP5.js';

class Geometry {
  constructor() {
    this.vertices = [];
    this.vertexNormals = [];
    this.faces = [];
    this.uvs = [];
    this.dirtyFlags = {};
  }
}

class Sketch {
  static Geometry = Geometry;
  RGB = 'rgb';
  NORMAL = 'normal';
  drawn = [];
  freed = [];
  depth = 0;
  createVector(x = 0, y = 0, z = 0) {
    return { x, y, z, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } };
  }
  model(geometry) { this.drawn.push(geometry); }
  freeGeometry(geometry) { this.freed.push(geometry); }
  loadImage(source, success) { success({ source, width: 2, height: 2 }); }
  push() { this.depth++; }
  pop() { this.depth--; }
  colorMode() {}
  noStroke() {}
  textureMode() {}
  fill() {}
  tint() {}
  texture() {}
  stroke() {}
  strokeWeight() {}
  line() {}
  translate() {}
  box() {}
  noFill() {}
  beginShape() {}
  vertex() {}
  endShape() {}
}

const assets = new Map();
async function glb(name) {
  if (!assets.has(name)) assets.set(name, await readFile(new URL(`../assets/${name}.glb`, import.meta.url)));
  return assets.get(name);
}

function response(bytes) {
  return {
    ok: true,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test('native parser reads both GLB 2.0 rigged models', async (t) => {
  let selected = 'moon';
  t.mock.method(globalThis, 'fetch', async () => response(await glb(selected)));
  for (const name of ['moon', 'yinan']) {
    selected = name;
    const parsed = parseGLB(await glb(name));
    assert.equal(parsed.gltf.asset.version, '2.0');
    const p = new Sketch();
    const avatar = new TripoP5(p);
    assert.equal(await avatar.load(`./assets/${name}.glb`), true);
    assert.equal(avatar.rig.length, 9);
    assert.ok(avatar.parts.length > 0);
    avatar.draw();
    assert.equal(p.drawn.length, avatar.parts.length);
    assert.equal(p.depth, 0);
    for (const part of avatar.parts) {
      assert.ok(part.geometry.faces.length > 0);
      assert.equal(part.geometry.uvs.length, part.vertexCount * 2);
      assert.ok(part.geometry.vertices.every((point) => [point.x, point.y, point.z].every(Number.isFinite)));
      assert.equal(part.geometry.dirtyFlags.vertices, true);
      assert.equal(part.geometry.dirtyFlags.vertexNormals, true);
    }
    avatar.dispose();
    assert.equal(avatar.model, null);
    assert.equal(p.freed.length, p.drawn.length);
  }
  const source = await readFile(new URL('../TripoP5.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /GLTFLoader|from\s+['"]three/i);
});

test('pose updates deform skinned vertices and visibility toggles mesh drawing', async (t) => {
  const p = new Sketch();
  const avatar = new TripoP5(p, { smoothing: 1 });
  t.mock.method(globalThis, 'fetch', async () => response(await glb('moon')));
  await avatar.load('./assets/moon.glb');
  avatar.draw();
  const part = avatar.parts.find((item) => item.jointsData && item.weightsData);
  const before = part.geometry.vertices.map(({ x, y, z }) => [x, y, z]);
  avatar.updatePose({ keypoints3D: [
    { name: 'left_elbow', x: -0.3, y: -0.2, z: 0, confidence: 1 },
    { name: 'left_wrist', x: -0.3, y: -0.8, z: 0, confidence: 1 },
  ] }).draw();
  assert.ok(part.geometry.vertices.some((point, index) => (
    Math.hypot(point.x - before[index][0], point.y - before[index][1], point.z - before[index][2]) > 0.01
  )));
  const draws = p.drawn.length;
  avatar.setOptions({ visible: false }).draw();
  assert.equal(p.drawn.length, draws);
  avatar.setOptions({ visible: true }).draw();
  assert.equal(p.drawn.length, draws + avatar.parts.length);
  avatar.dispose();
});

test('input validation, mirroring, confidence filtering, and bounded traces remain available', () => {
  const avatar = new TripoP5(new Sketch(), {
    showSkeleton: true, traceLandmark: 'left_wrist', traceLength: 3, traceRotation: 0,
  });
  const pose = { keypoints3D: [
    { name: 'left_elbow', x: 1, y: 2, z: 3, confidence: 1 },
    { name: 'left_wrist', x: 4, y: 5, z: 6, confidence: 1 },
  ] };
  avatar.setSkeleton([[0, 1]]);
  avatar.updatePose(pose);
  assert.deepEqual(avatar.landmark('left_wrist'), [4, -5, -6]);
  avatar.setOptions({ mirror: true });
  assert.deepEqual(avatar.landmark('left_wrist'), [-4, -5, -6]);
  for (let i = 0; i < 10; i++) avatar.draw();
  assert.equal(avatar.trace.length, 3);
  avatar.setOptions({ traceLandmark: null }).draw();
  assert.equal(avatar.trace.length, 0);
  avatar.updatePose({ keypoints3D: [{ ...pose.keypoints3D[1], confidence: 0.1 }] });
  assert.equal(avatar.landmark('left_wrist'), null);
  avatar.updatePose(null);
  assert.equal(avatar.pose.size, 0);
  assert.throws(() => avatar.updatePose({ keypoints: [] }), /keypoints3D/);
  assert.throws(() => avatar.setOptions({ smoothing: 2 }), /between/);
  assert.throws(() => avatar.setOptions({ typo: true }), /Unknown/);
  assert.throws(() => avatar.setSkeleton([[0, -1]]), /index pairs/);
});

test('newest load wins, invalid GLBs preserve the active model, and disposal rejects drawing', async (t) => {
  const valid = await glb('moon');
  const invalid = Buffer.from('not a GLB');
  const pending = new Map();
  t.mock.method(globalThis, 'fetch', (url) => new Promise((resolve) => pending.set(String(url), resolve)));
  const avatar = new TripoP5(new Sketch());
  const oldLoad = avatar.load('old.glb');
  const newLoad = avatar.load('new.glb');
  pending.get('new.glb')(response(valid));
  assert.equal(await newLoad, true);
  const oldModel = avatar.model;
  pending.get('old.glb')(response(valid));
  assert.equal(await oldLoad, false);
  assert.equal(avatar.model, oldModel);
  const badLoad = avatar.load('bad.glb');
  pending.get('bad.glb')(response(invalid));
  await assert.rejects(badLoad, /Invalid GLB/);
  assert.equal(avatar.model, oldModel);
  avatar.dispose();
  assert.throws(() => avatar.draw(), /disposed/);
});

test('GLB parser reports malformed and unsupported input explicitly', () => {
  assert.throws(() => parseGLB(new ArrayBuffer(8)), /Invalid GLB header/);
  const bytes = new ArrayBuffer(20);
  const view = new DataView(bytes);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 1, true);
  assert.throws(() => parseGLB(bytes), /version 2/);
});
