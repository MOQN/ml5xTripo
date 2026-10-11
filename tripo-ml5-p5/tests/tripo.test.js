import test from "node:test";
import assert from "node:assert/strict";
import { glb, loadLibrary, modelDemo, response, Sketch, source } from "./library-helper.js";

const pose = { keypoints3D: [
  { name: "left_elbow", x: -0.3, y: -0.2, z: 0, confidence: 1 },
  { name: "left_wrist", x: -0.3, y: -0.8, z: 0, confidence: 1 },
] };

test("one standalone class loads both GLBs and draws on the existing WEBGL canvas", async () => {
  assert.match(source, /^class TripoRiggedModel \{/);
  assert.equal((source.match(/\bclass\s/g) ?? []).length, 1);
  assert.doesNotMatch(source, /TripoP5|createLoaderClass|createGraphics|detectStart|createCapture|GLTFLoader|^\s*(import|export)\s/m);
  for (const name of ["moon", "yinan"]) {
    const { p, model } = await modelDemo({}, name);
    assert.equal(model.p, p);
    assert.equal(model.rig.length, 9);
    assert.ok(model.parts.length > 0);
    model.update([]).draw();
    assert.equal(p.drawn.length, model.parts.length);
    assert.equal(p.depth, 0);
    for (const part of model.parts) {
      assert.ok(part.geometry.faces.length > 0);
      assert.equal(part.geometry.uvs.length, part.vertexCount * 2);
      assert.ok(part.geometry.vertices.every((point) => [point.x, point.y, point.z].every(Number.isFinite)));
      assert.equal(part.geometry.dirtyFlags.vertices, true);
      assert.equal(part.geometry.dirtyFlags.vertexNormals, true);
    }
    model.dispose();
    assert.equal(model.scene, null);
    assert.equal(p.freed.length, p.drawn.length);
  }
});

test("update accepts an ml5 results array, copies the first pose and deforms vertices before draw", async () => {
  const { p, model } = await modelDemo({ smoothing: 1 });
  const part = model.parts.find((item) => item.jointsData && item.weightsData);
  const before = part.geometry.vertices.map(({ x, y, z }) => [x, y, z]);
  const input = structuredClone(pose);
  model.update([input, { keypoints3D: [] }]);
  assert.equal(p.drawn.length, 0);
  assert.ok(part.geometry.vertices.some((point, index) => (
    Math.hypot(point.x - before[index][0], point.y - before[index][1], point.z - before[index][2]) > 0.01
  )));
  assert.deepEqual(input, pose);
  input.keypoints3D[0].x = 99;
  assert.equal(model.pose.get("left_elbow").x, pose.keypoints3D[0].x);
  model.draw();
  const quaternions = model.rig.map((item) => Array.from(item.currentQuaternion));
  model.draw();
  assert.deepEqual(model.rig.map((item) => Array.from(item.currentQuaternion)), quaternions);
  model.update([]);
  assert.equal(model.pose.size, 0);
  const after = part.geometry.vertices.map(({ x, y, z }) => [x, y, z]);
  assert.ok(after.every((point, i) => point.every((value, j) => Math.abs(value - before[i][j]) < 1e-8)));
  model.dispose();
});

test("visibility, mirroring, confidence, skeleton and bounded traces remain available", async () => {
  const { p, model } = await modelDemo({
    showSkeleton: true, traceLandmark: "left_wrist", traceLength: 3, traceRotation: 0,
  });
  model.setSkeleton([[0, 1]]);
  for (let i = 0; i < 10; i++) model.update([pose]);
  assert.equal(model.trace.length, 3);
  assert.deepEqual(Array.from(model.trace[0]), [-75, 200, 0]);
  model.draw();
  assert.deepEqual(p.lines[0], [-75, 50, -0, -75, 200, -0]);
  model.setOptions({ mirror: true });
  model.update([pose]);
  assert.deepEqual(Array.from(model.trace.at(-1)), [75, 200, -0]);
  const draws = p.drawn.length;
  model.setOptions({ visible: false }).draw();
  assert.equal(p.drawn.length, draws);
  model.setOptions({ visible: true }).draw();
  assert.equal(p.drawn.length, draws + model.parts.length);
  model.setOptions({ traceLandmark: null }).update([pose]);
  assert.equal(model.trace.length, 0);
  model.setOptions({ traceLandmark: "left_wrist" });
  model.update([{ keypoints3D: [{ ...pose.keypoints3D[1], confidence: 0.1 }] }]);
  assert.equal(model.trace.length, 0);
  model.update([]);
  assert.equal(model.pose.size, 0);
  model.dispose();
});

test("bad renderer, URL, options and pose shapes are rejected explicitly", async () => {
  const Loader = loadLibrary(new Sketch());
  await assert.rejects(Loader.load(""), /GLB URL/);
  const p2d = new Sketch();
  p2d._renderer.isP3D = false;
  assert.throws(() => new (loadLibrary(p2d))(), /WEBGL/);
  const { model } = await modelDemo();
  assert.throws(() => model.update(pose), /poses array/);
  assert.throws(() => model.update([{}]), /keypoints3D/);
  assert.throws(() => model.update([{ keypoints3D: [null] }]), /landmark/);
  assert.throws(() => model.setOptions({ smoothing: 2 }), /between/);
  assert.throws(() => model.setOptions({ typo: true }), /Unknown/);
  assert.throws(() => model.setSkeleton([[0, -1]]), /index pairs/);
  await assert.rejects(model.load(""), /GLB URL/);
  model.dispose();
});

test("newest load wins and failed replacement preserves the current scene", async () => {
  const valid = await glb();
  const pending = new Map();
  const errors = [];
  const Loader = loadLibrary(new Sketch(), {
    fetch: (url) => new Promise((resolve) => pending.set(url, resolve)),
    console: { error: (...args) => errors.push(args) },
  });
  const model = new Loader();
  const old = model.load("old.glb");
  const newest = model.load("new.glb");
  pending.get("new.glb")(response(valid));
  assert.equal(await newest, model);
  const scene = model.scene;
  pending.get("old.glb")(response(valid));
  await assert.rejects(old, /cancelled/);
  assert.equal(model.scene, scene);
  const bad = model.load("bad.glb");
  pending.get("bad.glb")(response(Buffer.from("not a GLB")));
  await assert.rejects(bad, /Invalid GLB/);
  assert.equal(model.scene, scene);
  assert.match(model.error.message, /Invalid GLB/);
  assert.equal(errors.length, 2);
  const recovery = model.load("recovery.glb");
  pending.get("recovery.glb")(response(valid));
  assert.equal(await recovery, model);
  assert.equal(model.error, null);
  const cancelled = model.load("cancelled.glb");
  model.dispose();
  pending.get("cancelled.glb")(response(valid));
  await assert.rejects(cancelled, /cancelled/);
  assert.equal(model.scene, null);
  assert.throws(() => model.draw(), /disposed/);
  assert.throws(() => model.update([]), /disposed/);
});

test("automatic loading reports HTTP and malformed GLB failures", async () => {
  for (const bytes of [new Uint8Array(8), new Uint8Array(20)]) {
    if (bytes.length === 20) {
      const view = new DataView(bytes.buffer);
      view.setUint32(0, 0x46546c67, true);
      view.setUint32(4, 1, true);
    }
    const errors = [];
    const Loader = loadLibrary(new Sketch(), {
      fetch: async () => response(bytes),
      console: { error: (...args) => errors.push(args) },
    });
    const model = new Loader();
    await assert.rejects(model.load("bad.glb"), /Invalid GLB|version 2/);
    assert.equal(errors.length, 1);
    assert.ok(model.error);
    model.dispose();
  }
  const errors = [];
  const Loader = loadLibrary(new Sketch(), {
    fetch: async () => ({ ok: false, status: 404 }),
    console: { error: (...args) => errors.push(args) },
  });
  await assert.rejects(Loader.load("missing.glb"), /404/);
  assert.equal(errors.length, 1);
});

test("construction performs no loading and instance load returns the same configured object", async () => {
  const p = new Sketch();
  let fetches = 0;
  const Loader = loadLibrary(p, {
    fetch: async () => { fetches++; return response(await glb()); },
  });
  const model = new Loader({ smoothing: 1 });
  assert.equal(fetches, 0);
  assert.equal(model.scene, null);
  assert.equal(await model.load("moon.glb"), model);
  assert.equal(fetches, 1);
  assert.equal(model.options.smoothing, 1);
  assert.equal(await model.load("yinan.glb"), model);
  assert.equal(model.options.smoothing, 1);
  model.dispose();
});

test("draw fits the model after resizing and restores p5 state on drawing failures", async () => {
  const { p, model } = await modelDemo();
  model.update([pose]).draw();
  const originalScale = p.scales.at(-1);
  p.width /= 2;
  p.height /= 2;
  model.draw();
  assert.equal(p.scales.at(-1), originalScale / 2);
  assert.equal(p.depth, 0);
  p.model = () => { throw new Error("Draw failed"); };
  assert.throws(() => model.draw(), /Draw failed/);
  assert.equal(p.depth, 0);
  model.dispose();
});

test("texture coordinates preserve the original glb v direction", async () => {
  for (const name of ["moon", "yinan"]) {
    const bytes = await glb(name);
    const jsonLength = bytes.readUInt32LE(12);
    const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
    const binaryStart = 20 + jsonLength + 8;
    const accessor = gltf.accessors[gltf.meshes[0].primitives[0].attributes.TEXCOORD_0];
    const bufferView = gltf.bufferViews[accessor.bufferView];
    assert.equal(accessor.componentType, 5126);
    const offset = binaryStart + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const stride = bufferView.byteStride ?? 8;
    const { model } = await modelDemo({}, name);
    const uvs = model.parts[0].geometry.uvs;
    for (let i = 0; i < accessor.count; i++) {
      assert.equal(uvs[i * 2], bytes.readFloatLE(offset + i * stride));
      assert.equal(uvs[i * 2 + 1], bytes.readFloatLE(offset + i * stride + 4));
    }
    model.dispose();
  }
});

test("idle and settled poses leave gpu buffers clean but scaling still updates geometry", async () => {
  const { model } = await modelDemo();
  const geometry = model.parts[0].geometry;
  const clean = () => {
    geometry.dirtyFlags.vertices = false;
    geometry.dirtyFlags.vertexNormals = false;
  };
  clean();
  for (let i = 0; i < 10; i++) model.update([]);
  assert.equal(geometry.dirtyFlags.vertices, false);
  assert.equal(geometry.dirtyFlags.vertexNormals, false);
  model.update([pose]);
  assert.equal(geometry.dirtyFlags.vertices, true);
  for (let i = 0; i < 200; i++) model.update([pose]);
  clean();
  model.update([pose]);
  assert.equal(geometry.dirtyFlags.vertices, false);
  for (let i = 0; i < 200; i++) model.update([]);
  clean();
  model.update([]);
  assert.equal(geometry.dirtyFlags.vertices, false);
  const before = geometry.vertices[0].x;
  model.setOptions({ modelScale: 500 }).update([]);
  assert.equal(geometry.dirtyFlags.vertices, true);
  assert.ok(Math.abs(geometry.vertices[0].x - before * 2) < 1e-8);
  model.dispose();
});

test("equivalent quaternion signs settle without redundant skinning", async () => {
  const { model } = await modelDemo();
  for (const item of model.rig) {
    item.currentQuaternion = item.bindLocalQuaternion.map((value) => -value);
    item.bone.rotation = item.currentQuaternion.slice();
  }
  for (let i = 0; i < 200; i++) model.update([]);
  const geometry = model.parts[0].geometry;
  geometry.dirtyFlags.vertices = false;
  model.update([]);
  assert.equal(geometry.dirtyFlags.vertices, false);
  model.dispose();
});

test("scalar skinning preserves previously measured positions", async () => {
  const { model } = await modelDemo({ smoothing: 1 });
  model.update([pose]);
  const geometry = model.parts[0].geometry;
  const samples = [
    [0, [18.73800932183394, 120.90577499977951, 4.453006019707433]],
    [100, [65.24794413394933, -117.6857962224252, -1.107724425427975]],
    [30000, [-15.685821445640329, 121.51607224197278, 1.1575353680307812]],
  ];
  for (const [index, position] of samples) {
    for (const [axis, key] of ["x", "y", "z"].entries()) {
      assert.ok(Math.abs(geometry.vertices[index][key] - position[axis]) < 1e-8);
    }
  }
  model.dispose();
});

test("rigid meshes attached to moving bones also refresh their vertices", async () => {
  const { model } = await modelDemo({ smoothing: 1 });
  const part = model.parts[0];
  part.jointsData = null;
  part.weightsData = null;
  part.node = model.rig.find((item) => item.bone.name === "mixamorigLeftForeArm").bone;
  part.modelScale = null;
  model.update([]);
  const before = part.geometry.vertices.map(({ x, y, z }) => [x, y, z]);
  model.update([pose]);
  assert.ok(part.geometry.vertices.some((p, i) => (
    Math.hypot(p.x - before[i][0], p.y - before[i][1], p.z - before[i][2]) > 0.01
  )));
  model.dispose();
});
