import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MAPPINGS = [
  ['mixamorigSpine', 'mixamorigSpine1', 'left_hip', 'left_shoulder', 'right_hip', 'right_shoulder'],
  ['mixamorigLeftArm', 'mixamorigLeftForeArm', 'left_shoulder', 'left_elbow'],
  ['mixamorigLeftForeArm', 'mixamorigLeftHand', 'left_elbow', 'left_wrist'],
  ['mixamorigRightArm', 'mixamorigRightForeArm', 'right_shoulder', 'right_elbow'],
  ['mixamorigRightForeArm', 'mixamorigRightHand', 'right_elbow', 'right_wrist'],
  ['mixamorigLeftUpLeg', 'mixamorigLeftLeg', 'left_hip', 'left_knee'],
  ['mixamorigLeftLeg', 'mixamorigLeftFoot', 'left_knee', 'left_ankle'],
  ['mixamorigRightUpLeg', 'mixamorigRightLeg', 'right_hip', 'right_knee'],
  ['mixamorigRightLeg', 'mixamorigRightFoot', 'right_knee', 'right_ankle'],
];
const DEFAULTS = {
  modelScale: 250, poseScale: 250, smoothing: 0.25, minConfidence: 0.3,
  mirror: false, modelMirror: false, visible: true, showSkeleton: false,
  jointSize: 6, traceLandmark: null, traceLength: 80, traceRotation: 0.01,
};

function disposeModel(model) {
  const resources = new Set();
  const images = new Set();
  model.traverse((object) => {
    if (object.geometry) resources.add(object.geometry);
    if (object.skeleton) resources.add(object.skeleton);
    for (const material of [].concat(object.material ?? [])) {
      resources.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) {
          resources.add(value);
          if (value.image?.close) images.add(value.image);
        }
      }
    }
  });
  for (const resource of resources) resource.dispose();
  for (const image of images) image.close();
}

export class TripoThree {
  constructor(options = {}) {
    this.options = { ...DEFAULTS };
    this.object = new THREE.Group();
    this.object.name = 'TripoThree';
    this.model = null;
    this.rig = [];
    this.pose = new Map();
    this.connections = [];
    this.trace = [];
    this.loadId = 0;
    this.disposed = false;
    this.modelContainer = new THREE.Group();
    this.object.add(this.modelContainer);
    this.joints = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x9900ff }), 33,
    );
    this.joints.count = 0;
    this.joints.frustumCulled = false;
    this.bones = new THREE.LineSegments(
      new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x35ffad }),
    );
    this.trail = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xeeffff, transparent: true, opacity: 0.8 }),
    );
    this.bones.frustumCulled = false;
    this.trail.frustumCulled = false;
    this.object.add(this.joints, this.bones, this.trail);
    this.setSkeleton([]);
    this.setOptions(options);
    this.matrix = new THREE.Matrix4();
    this.up = new THREE.Vector3(0, 1, 0);
  }

  assertActive() {
    if (this.disposed) throw new Error('This TripoThree object has been disposed.');
  }

  setOptions(options) {
    this.assertActive();
    for (const key of Object.keys(options)) {
      if (!Object.hasOwn(DEFAULTS, key)) throw new TypeError(`Unknown TripoThree option: ${key}`);
    }
    const next = { ...this.options, ...options };
    for (const key of ['modelScale', 'poseScale', 'jointSize']) {
      if (!Number.isFinite(next[key]) || next[key] <= 0) throw new RangeError(`${key} must be positive.`);
    }
    for (const key of ['smoothing', 'minConfidence']) {
      if (!Number.isFinite(next[key]) || next[key] < 0 || next[key] > 1) {
        throw new RangeError(`${key} must be between 0 and 1.`);
      }
    }
    for (const key of ['mirror', 'modelMirror', 'visible', 'showSkeleton']) {
      if (typeof next[key] !== 'boolean') throw new TypeError(`${key} must be a boolean.`);
    }
    if (!Number.isInteger(next.traceLength) || next.traceLength < 0) throw new RangeError('traceLength must be a nonnegative integer.');
    if (!Number.isFinite(next.traceRotation)) throw new RangeError('traceRotation must be finite.');
    if (next.traceLandmark !== null && typeof next.traceLandmark !== 'string') {
      throw new TypeError('traceLandmark must be a landmark name or null.');
    }
    if (next.traceLandmark !== this.options.traceLandmark) this.trace.length = 0;
    if (next.traceLength !== this.options.traceLength || !this.trail.geometry.attributes.position) {
      this.trail.geometry.dispose();
      this.trail.geometry = new THREE.BufferGeometry();
      this.trail.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(next.traceLength * 3), 3));
    }
    this.options = next;
    this.modelContainer.scale.setScalar(next.modelScale);
    this.modelContainer.visible = next.visible;
    this.joints.visible = this.bones.visible = next.showSkeleton;
    this.trail.visible = Boolean(next.traceLandmark && next.traceLength && this.trace.length > 1);
    return this;
  }

  async load(url) {
    this.assertActive();
    if (typeof url !== 'string' || !url.trim()) throw new TypeError('load() requires a GLB/GLTF URL.');
    const id = ++this.loadId;
    const { scene: model } = await new GLTFLoader().loadAsync(url);
    if (this.disposed || id !== this.loadId) {
      disposeModel(model);
      return false;
    }
    let rig;
    try {
      rig = this.prepareModel(model);
    } catch (error) {
      disposeModel(model);
      throw error;
    }
    if (this.model) {
      this.modelContainer.remove(this.model);
      disposeModel(this.model);
    }
    this.model = model;
    this.rig = rig;
    this.modelContainer.add(model);
    return true;
  }

  prepareModel(model) {
    model.updateMatrixWorld(true);
    const restored = new Set();
    let meshes = 0;
    model.traverse((mesh) => {
      if (mesh.isMesh) meshes++;
      if (!mesh.isSkinnedMesh || restored.has(mesh.skeleton)) return;
      const skeleton = mesh.skeleton;
      restored.add(skeleton);
      const authored = skeleton.bones.some((bone) => (
        bone.position.lengthSq() > 1e-12 || Math.abs(bone.quaternion.x) > 1e-6
        || Math.abs(bone.quaternion.y) > 1e-6 || Math.abs(bone.quaternion.z) > 1e-6
        || Math.abs(Math.abs(bone.quaternion.w) - 1) > 1e-6
        || bone.scale.distanceTo(new THREE.Vector3(1, 1, 1)) > 1e-6
      ));
      if (authored) return;
      const ordered = skeleton.bones.map((bone, index) => {
        let depth = 0;
        for (let parent = bone.parent; parent; parent = parent.parent) depth++;
        return { bone, depth, world: mesh.bindMatrix.clone().multiply(skeleton.boneInverses[index].clone().invert()) };
      }).sort((a, b) => a.depth - b.depth);
      for (const { bone, world } of ordered) {
        const local = bone.parent ? bone.parent.matrixWorld.clone().invert().multiply(world) : world;
        local.decompose(bone.position, bone.quaternion, bone.scale);
        bone.updateMatrix();
        model.updateMatrixWorld(true);
      }
      skeleton.calculateInverses();
    });
    if (!meshes) throw new Error('The model contains no drawable meshes.');
    const pelvis = model.getObjectByName('mixamorigHips');
    if (pelvis) model.position.sub(pelvis.getWorldPosition(new THREE.Vector3()));
    model.updateMatrixWorld(true);
    const rig = [];
    for (const [name, endName, ...landmarks] of MAPPINGS) {
      const bone = model.getObjectByName(name);
      const end = model.getObjectByName(endName);
      if (!bone || !end) continue;
      const direction = end.getWorldPosition(new THREE.Vector3()).sub(bone.getWorldPosition(new THREE.Vector3()));
      if (direction.lengthSq() === 0) continue;
      rig.push({
        bone, landmarks,
        bindDirection: direction.normalize(),
        bindWorldQuaternion: bone.getWorldQuaternion(new THREE.Quaternion()).normalize(),
        bindLocalQuaternion: bone.quaternion.clone().normalize(),
        currentQuaternion: bone.quaternion.clone().normalize(),
      });
    }
    return rig;
  }

  setSkeleton(connections) {
    this.assertActive();
    if (!Array.isArray(connections) || connections.some((pair) => (
      !Array.isArray(pair) || pair.length !== 2 || pair.some((i) => !Number.isInteger(i) || i < 0)
    ))) throw new TypeError('setSkeleton() requires ml5 getSkeleton() index pairs.');
    this.connections = connections.map((pair) => [...pair]);
    this.bones.geometry.dispose();
    this.bones.geometry = new THREE.BufferGeometry();
    this.bones.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(connections.length * 6), 3));
    this.bones.geometry.setDrawRange(0, 0);
    return this;
  }

  updatePose(pose) {
    this.assertActive();
    if (pose == null) return this.clearPose();
    if (!Array.isArray(pose.keypoints3D)) throw new TypeError('A BlazePose result with keypoints3D is required.');
    if (pose.keypoints3D.length > 33) throw new RangeError('BlazePose supports at most 33 landmarks.');
    const next = new Map();
    for (const [index, point] of pose.keypoints3D.entries()) {
      const confidence = point.confidence ?? point.score;
      if (typeof point.name !== 'string' || ![point.x, point.y, point.z, confidence].every(Number.isFinite)) {
        throw new TypeError('Each 3D landmark requires a name, finite x/y/z and confidence (or score).');
      }
      next.set(point.name, { index, x: point.x, y: point.y, z: point.z, confidence });
    }
    this.pose = next;
    return this;
  }

  clearPose() {
    this.pose.clear();
    this.trace.length = 0;
    this.joints.count = 0;
    this.bones.geometry.setDrawRange(0, 0);
    this.trail.visible = false;
    return this;
  }

  landmark(name) {
    const point = this.pose.get(name);
    if (!point || point.confidence < this.options.minConfidence) return null;
    return new THREE.Vector3(point.x * (this.options.mirror ? -1 : 1), -point.y, -point.z);
  }

  updateRig() {
    if (!this.model) return;
    this.model.updateMatrixWorld(true);
    // Work in avatar-local coordinates so rotating its Group also rotates the pose.
    const basisInverse = this.modelContainer.getWorldQuaternion(new THREE.Quaternion()).normalize().invert();
    for (const item of this.rig) {
      const points = item.landmarks.map((name) => {
        if (this.options.modelMirror) name = name.startsWith('left_') ? `right_${name.slice(5)}` : `left_${name.slice(6)}`;
        return this.landmark(name);
      });
      let target = item.bindLocalQuaternion;
      if (points.every(Boolean)) {
        const direction = points[1].clone().sub(points[0]);
        if (points.length === 4) direction.add(points[3]).sub(points[2]).multiplyScalar(0.5);
        if (direction.lengthSq() > 1e-12) {
          const desired = new THREE.Quaternion().setFromUnitVectors(item.bindDirection, direction.normalize())
            .multiply(item.bindWorldQuaternion);
          const parent = item.bone.parent.getWorldQuaternion(new THREE.Quaternion()).normalize();
          parent.premultiply(basisInverse).invert();
          target = parent.multiply(desired).normalize();
        }
      }
      item.currentQuaternion.slerp(target, this.options.smoothing).normalize();
      item.bone.quaternion.copy(item.currentQuaternion);
      item.bone.updateMatrixWorld(true);
    }
    this.model.updateMatrixWorld(true);
  }

  update() {
    this.assertActive();
    this.object.updateWorldMatrix(true, true);
    this.updateRig();
    const positions = new Map();
    let count = 0;
    for (const [name, point] of this.pose) {
      const position = this.landmark(name);
      if (!position) continue;
      position.multiplyScalar(this.options.poseScale);
      positions.set(point.index, position);
      this.matrix.makeScale(this.options.jointSize, this.options.jointSize, this.options.jointSize).setPosition(position);
      this.joints.setMatrixAt(count++, this.matrix);
    }
    this.joints.count = count;
    this.joints.instanceMatrix.needsUpdate = true;
    const bones = this.bones.geometry.attributes.position;
    let segment = 0;
    for (const [a, b] of this.connections) {
      const start = positions.get(a);
      const end = positions.get(b);
      if (!start || !end) continue;
      start.toArray(bones.array, segment * 6);
      end.toArray(bones.array, segment * 6 + 3);
      segment++;
    }
    bones.needsUpdate = true;
    this.bones.geometry.setDrawRange(0, segment * 2);
    if (!this.options.traceLandmark || this.options.traceLength === 0) this.trace.length = 0;
    else {
      const point = this.landmark(this.options.traceLandmark);
      if (point) this.trace.push(point.multiplyScalar(this.options.poseScale));
    }
    for (const point of this.trace) point.applyAxisAngle(this.up, this.options.traceRotation);
    while (this.trace.length > this.options.traceLength) this.trace.shift();
    const trail = this.trail.geometry.attributes.position;
    this.trace.forEach((point, index) => point.toArray(trail.array, index * 3));
    trail.needsUpdate = true;
    this.trail.geometry.setDrawRange(0, this.trace.length);
    this.trail.visible = this.trace.length > 1;
    return this;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loadId++;
    this.object.removeFromParent();
    this.joints.dispose();
    disposeModel(this.object);
    this.object.clear();
    this.model = null;
    this.rig = [];
    this.pose.clear();
    this.trace.length = 0;
  }
}
