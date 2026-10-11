import test from "node:test";
import assert from "node:assert/strict";
import { fixture, identity, loadFixture, pack, writeAttribute } from "./glb-fixture.js";
import { loadLibrary, response, Sketch } from "./library-helper.js";

function near(actual, expected, tolerance = 1e-6) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < tolerance, `${value} != ${expected[i]}`));
}

const xyz = (v) => [v.x, v.y, v.z];
const pose = [{ keypoints3D: [
  { name: "left_elbow", x: 0, y: 0, z: 0, confidence: 1 },
  { name: "left_wrist", x: 1, y: 0, z: 0, confidence: 1 },
] }];

function rigFixture() {
  const f = fixture({ skin: true });
  f.gltf.nodes[1].name = "mixamorigLeftForeArm";
  f.gltf.nodes[1].children = [2];
  f.gltf.nodes.push({ name: "mixamorigLeftHand", translation: [0, 1, 0] });
  return f;
}

test("30, 60 and 120 fps produce the same rotation after equal elapsed time", async () => {
  const rotations = [];
  for (const fps of [30, 60, 120]) {
    const { model, p } = await loadFixture(rigFixture(), { smoothing: 0.03 });
    p.deltaTime = 1000 / fps;
    for (let i = 0; i < fps; i++) model.update(pose);
    rotations.push(Array.from(model.rig[0].currentQuaternion));
    model.dispose();
  }
  near(rotations[0], rotations[1]);
  near(rotations[1], rotations[2]);
});

test("explicit elapsed time handles zero, immediate and disabled smoothing", async () => {
  const { model } = await loadFixture(rigFixture());
  const initial = Array.from(model.rig[0].currentQuaternion);
  model.update(pose, 0);
  near(Array.from(model.rig[0].currentQuaternion), initial);
  model.setOptions({ smoothing: 0 }).update(pose, 1000);
  near(Array.from(model.rig[0].currentQuaternion), initial);
  model.setOptions({ smoothing: 1 }).update(pose, 1);
  near(Array.from(model.rig[0].currentQuaternion), [0, 0, -Math.SQRT1_2, Math.SQRT1_2]);
  for (const dt of [-1, NaN, Infinity]) assert.throws(() => model.update(pose, dt), /elapsed time/);
  model.dispose();
});

test("hierarchy updates each affected node once and leaves unrelated meshes clean", async () => {
  const f = fixture({ skin: true });
  f.gltf.nodes[1].name = "mixamorigLeftArm";
  f.gltf.nodes[1].children = [2];
  f.gltf.nodes.push(
    { name: "mixamorigLeftForeArm", translation: [0, 1, 0], children: [3] },
    { name: "mixamorigLeftHand", translation: [0, 1, 0] },
    { mesh: 1, name: "unrelated" }
  );
  const primitive = structuredClone(f.gltf.meshes[0].primitives[0]);
  delete primitive.attributes.JOINTS_0;
  delete primitive.attributes.WEIGHTS_0;
  f.gltf.meshes.push({ primitives: [primitive] });
  f.gltf.scenes[0].nodes.push(4);
  const { model } = await loadFixture(f, { smoothing: 1 });
  const versions = model.scene.nodes.map((node) => node.worldVersion);
  const independent = model.parts.find((part) => part.node.name === "unrelated");
  independent.geometry.dirtyFlags.vertices = false;
  model.update([{ keypoints3D: [
    { name: "left_shoulder", x: 0, y: 0, z: 0, confidence: 1 },
    { name: "left_elbow", x: 1, y: 0, z: 0, confidence: 1 },
    { name: "left_wrist", x: 1, y: -1, z: 0, confidence: 1 },
  ] }]);
  assert.deepEqual(Array.from(model.scene.nodes, (node, i) => node.worldVersion - versions[i]), [0, 1, 1, 1, 0]);
  assert.equal(independent.geometry.dirtyFlags.vertices, false);
  model.dispose();
});

test("authored normals use inverse transpose under reflected nonuniform scale", async () => {
  for (const useMatrix of [false, true]) {
    const f = fixture();
    writeAttribute(f, "NORMAL", [1, 1, 0, 1, 1, 0, 1, 1, 0]);
    if (useMatrix) {
      f.gltf.nodes[0].matrix = [-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1];
    } else {
      f.gltf.nodes[0].scale = [-2, 3, 4];
      f.gltf.nodes[0].translation = [5, 6, 7];
    }
    const { model } = await loadFixture(f, { modelScale: 1 });
    near(xyz(model.parts[0].geometry.vertices[1]), [3, -6, 7]);
    const length = Math.hypot(1 / 2, 1 / 3);
    near(xyz(model.parts[0].geometry.vertexNormals[0]), [-0.5 / length, -(1 / 3) / length, 0]);
    assert.deepEqual(Array.from(model.parts[0].geometry.faces[0]), [0, 1, 2]);
    model.dispose();
  }
});

test("skinning ignores mesh node transform and transforms authored normals", async () => {
  const f = fixture({ skin: true });
  writeAttribute(f, "NORMAL", [1, 1, 0, 1, 1, 0, 1, 1, 0]);
  f.gltf.nodes[1].scale = [2, 3, 4];
  const { model } = await loadFixture(f, { modelScale: 1 });
  near(xyz(model.parts[0].geometry.vertices[1]), [4, 0, 0]);
  const length = Math.hypot(1 / 2, 1 / 3);
  near(xyz(model.parts[0].geometry.vertexNormals[0]), [0.5 / length, -(1 / 3) / length, 0]);
  model.dispose();
});

test("inverse bind matrices are applied once in world space", async () => {
  const f = fixture({ skin: true });
  const inverse = identity();
  inverse[12] = -2;
  f.binary = Buffer.concat([f.binary, Buffer.alloc(64)]);
  f.gltf.buffers[0].byteLength = f.binary.length;
  inverse.forEach((value, i) => f.binary.writeFloatLE(value, 256 + i * 4));
  f.gltf.bufferViews.push({ buffer: 0, byteOffset: 256, byteLength: 64 });
  f.gltf.accessors.push({ bufferView: f.gltf.bufferViews.length - 1, type: "MAT4", componentType: 5126, count: 1 });
  f.gltf.skins[0].inverseBindMatrices = f.gltf.accessors.length - 1;
  const { model } = await loadFixture(f, { modelScale: 1 });
  near(xyz(model.parts[0].geometry.vertices[1]), [1, 0, 0]);
  model.dispose();
});

test("interleaved attributes and normalized integer weights remain supported", async () => {
  const f = fixture({ skin: true });
  const primitive = f.gltf.meshes[0].primitives[0];
  const positions = f.gltf.accessors[primitive.attributes.POSITION];
  const view = f.gltf.bufferViews[positions.bufferView];
  f.binary = Buffer.concat([f.binary, Buffer.alloc(48)]);
  f.gltf.buffers[0].byteLength = f.binary.length;
  view.byteOffset = 256;
  view.byteLength = 48;
  view.byteStride = 16;
  [0, 0, 0, 99, 1, 0, 0, 99, 0, 1, 0, 99].forEach((value, i) => f.binary.writeFloatLE(value, 256 + i * 4));
  const weights = f.gltf.accessors[primitive.attributes.WEIGHTS_0];
  const weightsView = f.gltf.bufferViews[weights.bufferView];
  weights.componentType = 5121;
  weights.normalized = true;
  weightsView.byteLength = 12;
  f.binary.fill(0, weightsView.byteOffset, weightsView.byteOffset + 12);
  for (let i = 0; i < 3; i++) f.binary[weightsView.byteOffset + i * 4] = 255;
  const { model } = await loadFixture(f, { modelScale: 1 });
  near(xyz(model.parts[0].geometry.vertices[1]), [3, 0, 0]);
  model.dispose();
});

test("normals missing from the file are reconstructed, including mirrored rigid meshes", async () => {
  for (const scale of [[1, 1, 1], [-2, 3, 4]]) {
    const f = fixture({ normals: false });
    f.gltf.nodes[0].scale = scale;
    const { model } = await loadFixture(f);
    assert.equal(model.parts[0].normalsData, null);
    for (const normal of model.parts[0].geometry.vertexNormals) near(xyz(normal), [0, 0, 1]);
    model.dispose();
  }
});

test("invalid glb inputs reject without replacing the active model", async () => {
  const invalid = [
    ["cycle", f => { f.gltf.nodes.push({ children: [2] }, { children: [1] }); }, /cycle/],
    ["self cycle", f => { f.gltf.nodes[0].children = [0]; }, /cycle/],
    ["child index", f => { f.gltf.nodes[0].children = [99]; }, /node index/],
    ["duplicate child", f => { f.gltf.nodes.push({}); f.gltf.nodes[0].children = [1, 1]; }, /hierarchy/],
    ["parented scene root", f => { f.gltf.nodes.push({}); f.gltf.nodes[0].children = [1]; f.gltf.scenes[0].nodes.push(1); }, /parentless/],
    ["view bounds", f => { f.gltf.bufferViews[1].byteLength = 10000; }, /buffer view/],
    ["accessor span", f => { f.gltf.accessors[1].count = 10000; }, /exceeds/],
    ["negative count", f => { f.gltf.accessors[1].count = -1; }, /count/],
    ["accessor alignment", f => { f.gltf.accessors[1].byteOffset = 1; }, /misaligned/],
    ["stride", f => { f.gltf.bufferViews[1].byteStride = 5; }, /stride/],
    ["attribute type", f => { f.gltf.accessors[1].type = "VEC2"; }, /VEC3/],
    ["normal count", f => { f.gltf.accessors[2].count = 2; }, /count/],
    ["normal component", f => { f.gltf.accessors[2].componentType = 5123; }, /component type/],
    ["nan position", f => { writeAttribute(f, "POSITION", [NaN]); }, /Non-finite/],
    ["triangle index", f => { f.binary.writeUInt16LE(99, 0); }, /triangle index/],
    ["sparse", f => { f.gltf.accessors[1].sparse = {}; }, /Sparse/],
    ["required extension", f => { f.gltf.extensionsRequired = ["KHR_draco_mesh_compression"]; }, /required.*extensions/],
    ["external buffer", f => { f.gltf.buffers[0].uri = "mesh.bin"; }, /embedded/],
    ["invalid version", f => { f.gltf.asset.version = "1.0"; }, /version/],
    ["matrix and trs", f => { f.gltf.nodes[0].matrix = identity(); f.gltf.nodes[0].translation = [1, 0, 0]; }, /cannot combine/],
    ["perspective matrix", f => { f.gltf.nodes[0].matrix = identity(); f.gltf.nodes[0].matrix[3] = 1; }, /affine/],
    ["shear matrix", f => { f.gltf.nodes[0].matrix = identity(); f.gltf.nodes[0].matrix[4] = 0.5; }, /shear/],
    ["zero scale", f => { f.gltf.nodes[0].scale = [0, 1, 1]; }, /zero scale/],
    ["bad quaternion", f => { f.gltf.nodes[0].rotation = [0, 0, 0, 0]; }, /quaternion/],
    ["bad material reference", f => { f.gltf.meshes[0].primitives[0].material = 4; }, /material index/],
    ["bad skin reference", f => { f.gltf.nodes[0].skin = 4; }, /skin index/],
  ];
  let bytes = pack(fixture());
  const errors = [];
  const Model = loadLibrary(new Sketch(), {
    fetch: async () => response(bytes),
    console: { error: (...args) => errors.push(args) },
  });
  const model = await Model.load("valid.glb");
  const scene = model.scene;
  for (const [name, mutate, message] of invalid) {
    const f = fixture();
    mutate(f);
    bytes = pack(f);
    await assert.rejects(model.load(`${name}.glb`), message, name);
    assert.equal(model.scene, scene, name);
  }
  assert.equal(errors.length, invalid.length);
  model.dispose();
});

test("invalid skin indices, weights and inverse binds reject explicitly", async () => {
  for (const [mutate, message] of [
    [f => { f.gltf.skins[0].joints = [99]; }, /joint index/],
    [f => { f.gltf.skins[0].joints = [1, 1]; }, /duplicate joints/],
    [f => { writeAttribute(f, "WEIGHTS_0", [-1]); }, /weights/],
    [f => { writeAttribute(f, "WEIGHTS_0", [0, 0, 0, 0]); }, /weights/],
    [f => { f.gltf.skins[0].inverseBindMatrices = 1; }, /MAT4/],
    [f => { const a = f.gltf.accessors[f.gltf.meshes[0].primitives[0].attributes.JOINTS_0]; a.normalized = true; }, /normalized/],
    [f => { const a = f.gltf.accessors[f.gltf.meshes[0].primitives[0].attributes.JOINTS_0]; f.binary.writeUInt16LE(99, f.gltf.bufferViews[a.bufferView].byteOffset); }, /joint index/],
  ]) {
    const f = fixture({ skin: true });
    mutate(f);
    await assert.rejects(loadFixture(f), message);
  }
});

test("container lengths, alignment and duplicate chunks are checked", async () => {
  const valid = pack(fixture());
  const bad = [
    Buffer.from(valid),
    Buffer.from(valid),
    Buffer.concat([valid, Buffer.alloc(4)]),
    Buffer.concat([valid, valid.subarray(12, 20 + valid.readUInt32LE(12))]),
  ];
  bad[0].writeUInt32LE(valid.length - 4, 8);
  bad[1].writeUInt32LE(valid.readUInt32LE(12) - 1, 12);
  bad[2].writeUInt32LE(bad[2].length, 8);
  bad[3].writeUInt32LE(bad[3].length, 8);
  for (const bytes of bad) {
    const Model = loadLibrary(new Sketch(), {
      fetch: async () => response(bytes), console: { error() {} },
    });
    await assert.rejects(Model.load("bad.glb"), /length|chunk/i);
  }
});
