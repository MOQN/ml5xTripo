import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { TripoThree } from '../TripoThree.js';

globalThis.ProgressEvent ??= class ProgressEvent {
  constructor(type, values) { Object.assign(this, { type }, values); }
};

async function asset(name) {
  const bytes = await readFile(new URL(`../assets/${name}.glb`, import.meta.url));
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const binaryStart = 20 + jsonLength;
  const binaryLength = bytes.readUInt32LE(binaryStart);
  const binary = bytes.subarray(binaryStart + 8, binaryStart + 8 + binaryLength);
  json.buffers[0].uri = `data:application/octet-stream;base64,${binary.toString('base64')}`;
  // Preserve real geometry/skin, leaving image decoding to browser validation.
  json.materials = json.materials.map((material) => ({
    name: material.name,
    pbrMetallicRoughness: { baseColorFactor: material.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1] },
  }));
  delete json.textures;
  delete json.images;
  delete json.extensionsUsed;
  delete json.extensionsRequired;
  return (await new GLTFLoader().parseAsync(JSON.stringify(json), '')).scene;
}

const END_NAMES = [
  'mixamorigSpine1', 'mixamorigLeftForeArm', 'mixamorigLeftHand',
  'mixamorigRightForeArm', 'mixamorigRightHand', 'mixamorigLeftLeg',
  'mixamorigLeftFoot', 'mixamorigRightLeg', 'mixamorigRightFoot',
];

for (const name of ['moon', 'yinan']) {
  test(`${name}: authored transforms, GPU skinned meshes and all nine bone targets`, async () => {
    const model = await asset(name);
    const authored = [];
    model.traverse((bone) => {
      if (bone.isBone) authored.push([bone, bone.position.toArray(), bone.quaternion.toArray(), bone.scale.toArray()]);
    });
    const avatar = new TripoThree({ smoothing: 1, showSkeleton: true, traceLandmark: 'left_wrist', traceLength: 3 });
    avatar.rig = avatar.prepareModel(model);
    for (const [bone, position, quaternion, scale] of authored) {
      assert.deepEqual(bone.position.toArray(), position);
      assert.deepEqual(bone.quaternion.toArray(), quaternion);
      assert.deepEqual(bone.scale.toArray(), scale);
    }
    avatar.model = model;
    avatar.modelContainer.add(model);
    assert.equal(avatar.rig.length, 9);
    let meshes = 0;
    model.traverse((mesh) => { if (mesh.isSkinnedMesh) meshes++; });
    assert.ok(meshes > 0);
    const coordinates = {
      left_hip: [-0.2, 0, 0], right_hip: [0.2, 0, 0],
      left_shoulder: [-0.3, -0.5, 0.1], right_shoulder: [0.3, -0.5, 0.1],
      left_elbow: [-0.6, -0.6, -0.1], right_elbow: [0.6, -0.6, -0.1],
      left_wrist: [-0.6, -0.9, 0.2], right_wrist: [0.6, -0.9, 0.2],
      left_knee: [-0.3, 0.4, -0.2], right_knee: [0.3, 0.4, -0.2],
      left_ankle: [-0.1, 0.8, 0.1], right_ankle: [0.1, 0.8, 0.1],
    };
    const pose = { keypoints3D: Object.entries(coordinates).map(([name, [x, y, z]]) => ({ name, x, y, z, confidence: 1 })) };
    const copy = structuredClone(pose);
    const scene = new THREE.Scene();
    const parent = new THREE.Group();
    parent.rotation.set(0.3, 0.5, -0.2);
    parent.scale.setScalar(1.4);
    scene.add(parent);
    avatar.object.position.set(70, 80, -30);
    avatar.object.rotation.set(-0.2, 0.4, 0.1);
    parent.add(avatar.object);
    avatar.setSkeleton([[0, 2], [2, 4]]).updatePose(pose);
    for (let i = 0; i < 5; i++) avatar.update();
    assert.deepEqual(pose, copy);
    const worldRotation = avatar.object.getWorldQuaternion(new THREE.Quaternion());
    for (const [index, item] of avatar.rig.entries()) {
      const [start, end, secondStart, secondEnd] = item.landmarks;
      const target = avatar.landmark(end).sub(avatar.landmark(start));
      if (secondStart) target.add(avatar.landmark(secondEnd)).sub(avatar.landmark(secondStart));
      target.normalize().applyQuaternion(worldRotation);
      const actual = model.getObjectByName(END_NAMES[index]).getWorldPosition(new THREE.Vector3())
        .sub(item.bone.getWorldPosition(new THREE.Vector3())).normalize();
      assert.ok(actual.dot(target) > 0.99999, `${item.bone.name} must respect parent transforms`);
    }
    assert.equal(avatar.joints.count, 12);
    assert.equal(avatar.bones.geometry.drawRange.count, 4);
    assert.equal(avatar.trace.length, 3);
    assert.equal(avatar.trail.geometry.drawRange.count, 3);
    avatar.setOptions({ visible: false, showSkeleton: false, traceLength: 0 });
    avatar.update();
    assert.equal(avatar.modelContainer.visible, false);
    assert.equal(avatar.joints.visible, false);
    assert.equal(avatar.trail.visible, false);
    avatar.clearPose().update();
    for (const item of avatar.rig) assert.ok(item.bone.quaternion.angleTo(item.bindLocalQuaternion) < 1e-7);
    let disposed = 0;
    avatar.joints.addEventListener('dispose', () => disposed++);
    avatar.dispose();
    assert.equal(disposed, 1);
    assert.equal(avatar.object.parent, null);
    assert.equal(avatar.object.children.length, 0);
    assert.throws(() => avatar.update(), /disposed/);
    avatar.dispose();
  });
}

test('mirroring, confidence, option validation and debug buffer reuse', () => {
  const avatar = new TripoThree({ mirror: true, showSkeleton: true });
  avatar.updatePose({ keypoints3D: [
    { name: 'left_wrist', x: 1, y: 2, z: 3, confidence: 1 },
    { name: 'left_elbow', x: 4, y: 5, z: 6, confidence: 0.1 },
  ] }).setSkeleton([[0, 1]]).update();
  assert.deepEqual(avatar.landmark('left_wrist').toArray(), [-1, -2, -3]);
  assert.equal(avatar.landmark('left_elbow'), null);
  assert.equal(avatar.joints.count, 1);
  assert.equal(avatar.bones.geometry.drawRange.count, 0);
  const buffer = avatar.bones.geometry.attributes.position;
  avatar.update();
  assert.equal(avatar.bones.geometry.attributes.position, buffer);
  assert.throws(() => avatar.setOptions({ smoothing: 2 }), /between/);
  assert.throws(() => avatar.setOptions({ unknown: true }), /Unknown/);
  assert.throws(() => avatar.updatePose({ keypoints: [] }), /keypoints3D/);
  assert.throws(() => avatar.setSkeleton([[0, -1]]), /index pairs/);
  avatar.dispose();
});

test('model load races, failures, replacement disposal and pending disposal', async (t) => {
  const pending = new Map();
  t.mock.method(GLTFLoader.prototype, 'loadAsync', (url) => new Promise((resolve, reject) => {
    pending.set(url, { resolve, reject });
  }));
  const model = () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
    return root;
  };
  const avatar = new TripoThree();
  const first = avatar.load('first');
  const second = avatar.load('second');
  const selected = model();
  let disposal = 0;
  selected.children[0].geometry.addEventListener('dispose', () => disposal++);
  pending.get('second').resolve({ scene: selected });
  assert.equal(await second, true);
  const old = model();
  pending.get('first').resolve({ scene: old });
  assert.equal(await first, false);
  assert.equal(avatar.model, selected);
  const bad = avatar.load('bad');
  pending.get('bad').reject(new Error('404'));
  await assert.rejects(bad, /404/);
  assert.equal(avatar.model, selected);
  const empty = avatar.load('empty');
  pending.get('empty').resolve({ scene: new THREE.Group() });
  await assert.rejects(empty, /no drawable/);
  assert.equal(avatar.model, selected);
  const replacement = avatar.load('replacement');
  pending.get('replacement').resolve({ scene: model() });
  await replacement;
  assert.equal(disposal, 1);
  const late = avatar.load('late');
  avatar.dispose();
  pending.get('late').resolve({ scene: model() });
  assert.equal(await late, false);
  assert.equal(avatar.model, null);
});
