const BONE_MAPPINGS = [
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
  modelScale: 250,
  poseScale: 250,
  smoothing: 0.25,
  minConfidence: 0.3,
  mirror: false,
  modelMirror: false,
  visible: true,
  showSkeleton: false,
  jointSize: 6,
  traceLandmark: null,
  traceLength: 80,
  traceRotation: 0.01,
};

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
let nextId = 0;

const add = (a, b) => a.map((value, i) => value + b[i]);
const subtract = (a, b) => a.map((value, i) => value - b[i]);
const scale = (a, scalar) => a.map((value) => value * scalar);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const length = (a) => Math.sqrt(dot(a, a));
const normalize = (a) => {
  const magnitude = length(a);
  return magnitude > 1e-12 ? scale(a, 1 / magnitude) : [0, 0, 0];
};

function multiplyQuaternion(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function normalizeQuaternion(q) {
  const magnitude = Math.hypot(...q);
  return magnitude > 1e-12 ? q.map((value) => value / magnitude) : [0, 0, 0, 1];
}

function inverseQuaternion(q) {
  const n = dot(q, q);
  return n > 1e-12 ? [-q[0] / n, -q[1] / n, -q[2] / n, q[3] / n] : [0, 0, 0, 1];
}

function rotateVector(q, vector) {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = vector;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + y * tz - z * ty,
    vy + w * ty + z * tx - x * tz,
    vz + w * tz + x * ty - y * tx,
  ];
}

function quaternionBetween(from, to) {
  const a = normalize(from);
  const b = normalize(to);
  const cosine = dot(a, b);
  if (cosine < -0.999999) {
    const axis = Math.abs(a[0]) < 0.9 ? normalize([0, -a[2], a[1]]) : normalize([-a[1], a[0], 0]);
    return [...axis, 0];
  }
  const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return normalizeQuaternion([...cross, 1 + cosine]);
}

function slerp(a, b, amount) {
  let target = b;
  let cosine = dot(a, target);
  if (cosine < 0) {
    target = target.map((value) => -value);
    cosine = -cosine;
  }
  if (cosine > 0.9995) return normalizeQuaternion(a.map((value, i) => value + amount * (target[i] - value)));
  const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
  const denominator = Math.sin(angle);
  const left = Math.sin((1 - amount) * angle) / denominator;
  const right = Math.sin(amount * angle) / denominator;
  return normalizeQuaternion(a.map((value, i) => left * value + right * target[i]));
}

function identityMatrix() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMatrix(a, b) {
  const out = new Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      out[column * 4 + row] = a[row] * b[column * 4]
        + a[4 + row] * b[column * 4 + 1]
        + a[8 + row] * b[column * 4 + 2]
        + a[12 + row] * b[column * 4 + 3];
    }
  }
  return out;
}

function composeMatrix(translation, rotation, size) {
  const [x, y, z, w] = normalizeQuaternion(rotation);
  const [sx, sy, sz] = size;
  const xx = x * x; const yy = y * y; const zz = z * z;
  const xy = x * y; const xz = x * z; const yz = y * z;
  const wx = w * x; const wy = w * y; const wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    ...translation, 1,
  ];
}

function transformPoint(matrix, point) {
  const [x, y, z] = point;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  const divisor = w && w !== 1 ? w : 1;
  return [
    (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / divisor,
    (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / divisor,
    (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / divisor,
  ];
}

function matrixQuaternion(matrix) {
  const sx = Math.hypot(matrix[0], matrix[1], matrix[2]) || 1;
  const sy = Math.hypot(matrix[4], matrix[5], matrix[6]) || 1;
  const sz = Math.hypot(matrix[8], matrix[9], matrix[10]) || 1;
  const m00 = matrix[0] / sx; const m11 = matrix[5] / sy; const m22 = matrix[10] / sz;
  const m01 = matrix[4] / sy; const m02 = matrix[8] / sz;
  const m10 = matrix[1] / sx; const m12 = matrix[9] / sz;
  const m20 = matrix[2] / sx; const m21 = matrix[6] / sy;
  const trace = m00 + m11 + m22;
  let q;
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return normalizeQuaternion(q);
}

function readComponent(view, offset, type) {
  switch (type) {
    case 5120: return view.getInt8(offset);
    case 5121: return view.getUint8(offset);
    case 5122: return view.getInt16(offset, true);
    case 5123: return view.getUint16(offset, true);
    case 5125: return view.getUint32(offset, true);
    case 5126: return view.getFloat32(offset, true);
    default: throw new Error(`Unsupported GLB accessor component type: ${type}`);
  }
}

function normalizedValue(value, type) {
  if (type === 5120) return Math.max(value / 127, -1);
  if (type === 5121) return value / 255;
  if (type === 5122) return Math.max(value / 32767, -1);
  if (type === 5123) return value / 65535;
  return value;
}

function readAccessor(gltf, binary, accessorIndex) {
  const accessor = gltf.accessors?.[accessorIndex];
  if (!accessor) throw new Error(`Missing GLB accessor ${accessorIndex}.`);
  if (accessor.sparse) throw new Error('Sparse GLB accessors are not supported.');
  const components = COMPONENTS[accessor.type];
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  if (!components || !componentBytes) throw new Error(`Unsupported GLB accessor type: ${accessor.type}.`);
  const result = new Array(accessor.count * components).fill(0);
  if (accessor.bufferView === undefined) return result;
  const bufferView = gltf.bufferViews[accessor.bufferView];
  if (!bufferView || bufferView.buffer !== 0) throw new Error('GLB accessor references an invalid buffer view.');
  const stride = bufferView.byteStride ?? components * componentBytes;
  const start = bufferView.byteOffset ?? 0;
  const accessorOffset = accessor.byteOffset ?? 0;
  if (stride < components * componentBytes) throw new Error('Invalid GLB accessor byte stride.');
  const view = new DataView(binary);
  for (let row = 0; row < accessor.count; row++) {
    for (let column = 0; column < components; column++) {
      let value = readComponent(view, start + accessorOffset + row * stride + column * componentBytes, accessor.componentType);
      if (accessor.normalized) value = normalizedValue(value, accessor.componentType);
      result[row * components + column] = value;
    }
  }
  return result;
}

export function parseGLB(input) {
  const buffer = input instanceof ArrayBuffer
    ? input
    : ArrayBuffer.isView(input)
      ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
      : null;
  if (!buffer) throw new TypeError('parseGLB() requires an ArrayBuffer or byte view.');
  const view = new DataView(buffer);
  if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error('Invalid GLB header.');
  if (view.getUint32(4, true) !== 2) throw new Error('Only GLB version 2 is supported.');
  const declaredLength = view.getUint32(8, true);
  if (declaredLength > view.byteLength) throw new Error('Incomplete GLB file.');
  let offset = 12;
  let gltf;
  let binary;
  while (offset + 8 <= declaredLength) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + chunkLength > declaredLength) throw new Error('Invalid GLB chunk length.');
    if (chunkType === 0x4e4f534a) gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, chunkLength)));
    if (chunkType === 0x004e4942) binary = buffer.slice(start, start + chunkLength);
    offset = start + chunkLength;
  }
  if (!gltf || !binary) throw new Error('GLB must contain JSON and binary chunks.');
  if (!Array.isArray(gltf.nodes) || !Array.isArray(gltf.meshes)) throw new Error('GLB has no drawable scene nodes.');
  return { gltf, binary };
}

function makeNode(definition, index) {
  const matrix = definition.matrix ? [...definition.matrix] : null;
  const matrixScale = matrix && [
    Math.hypot(matrix[0], matrix[1], matrix[2]),
    Math.hypot(matrix[4], matrix[5], matrix[6]),
    Math.hypot(matrix[8], matrix[9], matrix[10]),
  ];
  const node = {
    index,
    name: (definition.name ?? '').replace('mixamorig:', 'mixamorig'),
    mesh: definition.mesh,
    skin: definition.skin,
    translation: [...(definition.translation ?? (matrix ? matrix.slice(12, 15) : [0, 0, 0]))],
    rotation: normalizeQuaternion([...(definition.rotation ?? (matrix ? matrixQuaternion(matrix) : [0, 0, 0, 1]))]),
    scale: [...(definition.scale ?? matrixScale ?? [1, 1, 1])],
    matrix: null,
    parent: null,
    children: [],
    worldMatrix: identityMatrix(),
    worldRotation: [0, 0, 0, 1],
  };
  return node;
}

function updateWorld(nodes) {
  const visit = (node, parentMatrix = null, parentRotation = [0, 0, 0, 1]) => {
    const local = node.matrix ?? composeMatrix(node.translation, node.rotation, node.scale);
    node.worldMatrix = parentMatrix ? multiplyMatrix(parentMatrix, local) : local;
    node.worldRotation = normalizeQuaternion(multiplyQuaternion(parentRotation, node.rotation));
    for (const child of node.children) visit(child, node.worldMatrix, node.worldRotation);
  };
  for (const node of nodes) if (!node.parent) visit(node);
}

function createModel(parsed) {
  const { gltf, binary } = parsed;
  const nodes = gltf.nodes.map(makeNode);
  for (const definition of gltf.nodes) {
    for (const childIndex of definition.children ?? []) {
      const child = nodes[childIndex];
      if (!child || child.parent) throw new Error('GLB contains an invalid node hierarchy.');
      child.parent = nodes[gltf.nodes.indexOf(definition)];
      child.parent.children.push(child);
    }
  }
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  if (!scene || !Array.isArray(scene.nodes)) throw new Error('GLB has no active scene.');
  const active = new Set();
  const include = (index) => {
    const node = nodes[index];
    if (!node) throw new Error(`GLB scene references missing node ${index}.`);
    active.add(node);
    for (const child of node.children) include(child.index);
  };
  for (const root of scene.nodes) include(root);
  updateWorld(nodes);
  const byName = new Map();
  for (const node of active) {
    if (node.name && !byName.has(node.name)) byName.set(node.name, node);
  }
  const hips = byName.get('mixamorigHips');
  const offset = hips ? scale(transformPoint(hips.worldMatrix, [0, 0, 0]), -1) : [0, 0, 0];
  const rig = [];
  for (const [name, endName, ...landmarks] of BONE_MAPPINGS) {
    const bone = byName.get(name);
    const end = byName.get(endName);
    if (!bone || !end) continue;
    const direction = normalize(subtract(transformPoint(end.worldMatrix, [0, 0, 0]), transformPoint(bone.worldMatrix, [0, 0, 0])));
    if (length(direction) < 1e-8) continue;
    rig.push({
      bone, landmarks, bindDirection: direction,
      bindWorldQuaternion: bone.worldRotation.slice(),
      bindLocalQuaternion: bone.rotation.slice(),
      currentQuaternion: bone.rotation.slice(),
    });
  }
  const parts = [];
  for (const node of active) {
    if (node.mesh === undefined) continue;
    const mesh = gltf.meshes[node.mesh];
    if (!mesh) throw new Error(`GLB node ${node.name} references a missing mesh.`);
    if (mesh.weights?.length || mesh.primitives.some((primitive) => primitive.targets?.length)) {
      throw new Error('Morph targets are not supported by TripoP5.');
    }
    const skin = node.skin === undefined ? null : gltf.skins?.[node.skin];
    if (node.skin !== undefined && !skin) throw new Error(`GLB node ${node.name} references a missing skin.`);
    const joints = skin ? skin.joints.map((index) => nodes[index]) : [];
    if (joints.some((joint) => !joint)) throw new Error(`GLB node ${node.name} has an invalid joint.`);
    const inverseBinds = skin?.inverseBindMatrices === undefined
      ? joints.map(() => identityMatrix())
      : Array.from({ length: joints.length }, (_, index) => (
        readAccessor(gltf, binary, skin.inverseBindMatrices).slice(index * 16, index * 16 + 16)
      ));
    for (const primitive of mesh.primitives) {
      if (primitive.mode !== undefined && primitive.mode !== 4) {
        throw new Error('Only triangle-list GLB primitives are supported.');
      }
      if (primitive.targets?.length) throw new Error('Morph targets are not supported by TripoP5.');
      const attributes = primitive.attributes;
      if (attributes.POSITION === undefined) throw new Error(`Mesh ${node.name} has no position attribute.`);
      const positions = readAccessor(gltf, binary, attributes.POSITION);
      const vertexCount = positions.length / 3;
      const indices = primitive.indices === undefined
        ? Array.from({ length: vertexCount }, (_, index) => index)
        : readAccessor(gltf, binary, primitive.indices);
      if (indices.length % 3) throw new Error(`Mesh ${node.name} has an incomplete triangle.`);
      const jointsData = attributes.JOINTS_0 === undefined ? null : readAccessor(gltf, binary, attributes.JOINTS_0);
      const weightsData = attributes.WEIGHTS_0 === undefined ? null : readAccessor(gltf, binary, attributes.WEIGHTS_0);
      if (!!jointsData !== !!weightsData) throw new Error(`Mesh ${node.name} has incomplete skin attributes.`);
      const uvs = attributes.TEXCOORD_0 === undefined ? null : readAccessor(gltf, binary, attributes.TEXCOORD_0);
      const material = gltf.materials?.[primitive.material] ?? {};
      const pbr = material.pbrMetallicRoughness ?? {};
      const baseColor = pbr.baseColorFactor ?? [1, 1, 1, 1];
      const p5Geometry = new this.p.constructor.Geometry();
      const part = {
        node, geometry: p5Geometry, positions, indices, jointsData, weightsData, joints, inverseBinds,
        baseColor, alpha: material.alphaMode === 'BLEND' ? baseColor[3] : 1,
        textureIndex: pbr.baseColorTexture?.index, texture: null, uvs, vertexCount,
      };
      p5Geometry.gid = `tripo-${this.id}-${parts.length}-${this.loadId}`;
      p5Geometry.vertexNormals = [];
      for (let index = 0; index < vertexCount; index++) {
        p5Geometry.vertices.push(this.p.createVector());
        p5Geometry.vertexNormals.push(this.p.createVector());
        p5Geometry.uvs.push(uvs ? uvs[index * 2] : 0, uvs ? 1 - uvs[index * 2 + 1] : 0);
      }
      p5Geometry.faces = [];
      for (let i = 0; i < indices.length; i += 3) {
        p5Geometry.faces.push([indices[i], indices[i + 2], indices[i + 1]]);
      }
      parts.push(part);
    }
  }
  if (!parts.length) throw new Error('The model contains no drawable meshes.');
  return { nodes, active, gltf, binary, offset, rig, parts };
}

function imageSource(parsed, textureIndex, url) {
  const { gltf, binary } = parsed;
  const texture = gltf.textures?.[textureIndex];
  const image = texture && gltf.images?.[texture.source];
  if (!image) throw new Error(`GLB references missing base-color texture ${textureIndex}.`);
  if (image.uri) {
    if (image.uri.startsWith('data:')) return image.uri;
    return new URL(image.uri, url).href;
  }
  const view = gltf.bufferViews?.[image.bufferView];
  if (!view || !image.mimeType) throw new Error('GLB texture image must have a buffer view and MIME type.');
  const bytes = binary.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
  return URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
}

function loadP5Image(p, source) {
  return new Promise((resolve, reject) => {
    p.loadImage(source, resolve, () => reject(new Error(`Could not load GLB texture: ${source}`)));
  });
}

export class TripoP5 {
  constructor(p, options = {}) {
    if (!p || typeof p.model !== 'function' || typeof p.freeGeometry !== 'function') {
      throw new TypeError('TripoP5 requires a p5 WEBGL instance (p5 1.11.x).');
    }
    this.p = p;
    this.options = { ...DEFAULTS };
    this.setOptions(options);
    this.model = null;
    this.rig = [];
    this.parts = [];
    this.textures = [];
    this.pose = new Map();
    this.connections = [];
    this.trace = [];
    this.loadId = 0;
    this.disposed = false;
    this.id = nextId++;
  }

  setOptions(options) {
    for (const key of Object.keys(options)) {
      if (!Object.hasOwn(DEFAULTS, key)) throw new TypeError(`Unknown TripoP5 option: ${key}`);
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
    if (!Number.isInteger(next.traceLength) || next.traceLength < 0) {
      throw new RangeError('traceLength must be a nonnegative integer.');
    }
    if (!Number.isFinite(next.traceRotation)) throw new RangeError('traceRotation must be finite.');
    for (const key of ['mirror', 'modelMirror', 'visible', 'showSkeleton']) {
      if (typeof next[key] !== 'boolean') throw new TypeError(`${key} must be a boolean.`);
    }
    if (next.traceLandmark !== null && typeof next.traceLandmark !== 'string') {
      throw new TypeError('traceLandmark must be a landmark name or null.');
    }
    if (next.traceLandmark !== this.options.traceLandmark) this.trace?.splice(0);
    this.options = next;
    return this;
  }

  async load(url) {
    this.assertActive();
    if (typeof url !== 'string' || !url.trim()) throw new TypeError('load() requires a GLB URL.');
    const loadId = ++this.loadId;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GLB load failed (${response.status}): ${url}`);
    const parsed = parseGLB(await response.arrayBuffer());
    const prepared = createModel.call(this, parsed);
    const objectUrls = [];
    try {
      for (const part of prepared.parts) {
        if (part.textureIndex === undefined) continue;
        const source = imageSource(parsed, part.textureIndex, url);
        if (source.startsWith('blob:')) objectUrls.push(source);
        part.texture = await loadP5Image(this.p, source);
      }
      if (this.disposed || loadId !== this.loadId) return false;
      this.releaseModel();
      this.model = prepared;
      this.rig = prepared.rig;
      this.parts = prepared.parts;
      return true;
    } finally {
      for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
    }
  }

  setSkeleton(connections) {
    if (!Array.isArray(connections) || connections.some((pair) => (
      !Array.isArray(pair) || pair.length !== 2 || pair.some((i) => !Number.isInteger(i) || i < 0)
    ))) throw new TypeError('setSkeleton() requires ml5 getSkeleton() index pairs.');
    this.connections = connections.map((pair) => [...pair]);
    return this;
  }

  updatePose(pose) {
    this.assertActive();
    if (pose == null) return this.clearPose();
    if (!Array.isArray(pose.keypoints3D)) throw new TypeError('A BlazePose result with keypoints3D is required.');
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
    return this;
  }

  landmark(name) {
    const point = this.pose.get(name);
    if (!point || point.confidence < this.options.minConfidence) return null;
    return [point.x * (this.options.mirror ? -1 : 1), -point.y, -point.z];
  }

  updateRig() {
    if (!this.model) return;
    for (const item of this.rig) {
      const names = item.landmarks.map((name) => {
        if (!this.options.modelMirror) return name;
        return name.startsWith('left_') ? `right_${name.slice(5)}` : `left_${name.slice(6)}`;
      });
      const points = names.map((name) => this.landmark(name));
      let target = item.bindLocalQuaternion;
      if (points.every(Boolean)) {
        let direction = subtract(points[1], points[0]);
        if (points.length === 4) direction = scale(add(direction, subtract(points[3], points[2])), 0.5);
        if (length(direction) > 1e-12) {
          const delta = quaternionBetween(item.bindDirection, normalize(direction));
          const desired = normalizeQuaternion(multiplyQuaternion(delta, item.bindWorldQuaternion));
          const parentRotation = item.bone.parent?.worldRotation ?? [0, 0, 0, 1];
          target = normalizeQuaternion(multiplyQuaternion(inverseQuaternion(parentRotation), desired));
        }
      }
      item.currentQuaternion = slerp(item.currentQuaternion, target, this.options.smoothing);
      item.bone.rotation = item.currentQuaternion.slice();
      item.bone.matrix = null;
      updateWorld(this.model.nodes);
    }
  }

  updateGeometry(part) {
    const matrices = part.joints.map((joint, index) => {
      const inverseBind = part.inverseBinds[index];
      return multiplyMatrix(multiplyMatrix(joint.worldMatrix, inverseBind), part.node.worldMatrix);
    });
    for (let index = 0; index < part.vertexCount; index++) {
      const vertex = [part.positions[index * 3], part.positions[index * 3 + 1], part.positions[index * 3 + 2]];
      let position;
      if (part.jointsData && part.weightsData) {
        position = [0, 0, 0];
        let total = 0;
        for (let slot = 0; slot < 4; slot++) {
          const weight = part.weightsData[index * 4 + slot];
          if (!weight) continue;
          const jointIndex = part.jointsData[index * 4 + slot];
          if (!matrices[jointIndex]) throw new Error(`Mesh ${part.node.name} references missing joint ${jointIndex}.`);
          position = add(position, scale(transformPoint(matrices[jointIndex], vertex), weight));
          total += weight;
        }
        if (total > 0 && Math.abs(total - 1) > 1e-5) position = scale(position, 1 / total);
        else if (total === 0) position = transformPoint(part.node.worldMatrix, vertex);
      } else position = transformPoint(part.node.worldMatrix, vertex);
      position = scale(add(position, this.model.offset), this.options.modelScale);
      part.geometry.vertices[index].set(position[0], -position[1], position[2]);
      part.geometry.vertexNormals[index].set(0, 0, 0);
    }
    for (const face of part.geometry.faces) {
      const a = part.geometry.vertices[face[0]];
      const b = part.geometry.vertices[face[1]];
      const c = part.geometry.vertices[face[2]];
      const ab = [b.x - a.x, b.y - a.y, b.z - a.z];
      const ac = [c.x - a.x, c.y - a.y, c.z - a.z];
      const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
      for (const vertexIndex of face) {
        const current = part.geometry.vertexNormals[vertexIndex];
        current.set(current.x + normal[0], current.y + normal[1], current.z + normal[2]);
      }
    }
    for (const normal of part.geometry.vertexNormals) {
      const unit = normalize([normal.x, normal.y, normal.z]);
      normal.set(...unit);
    }
    part.geometry.dirtyFlags.vertices = true;
    part.geometry.dirtyFlags.vertexNormals = true;
  }

  draw() {
    this.assertActive();
    const p = this.p;
    this.updateRig();
    p.push();
    try {
      p.colorMode(p.RGB, 255);
      p.noStroke();
      p.textureMode(p.NORMAL);
      if (this.options.visible) {
        for (const part of this.parts) {
          this.updateGeometry(part);
          const [r, g, b] = part.baseColor;
          p.fill(r * 255, g * 255, b * 255, part.alpha * 255);
          if (part.texture) {
            p.tint(r * 255, g * 255, b * 255, part.alpha * 255);
            p.texture(part.texture);
          }
          p.model(part.geometry);
        }
      }
      if (this.options.showSkeleton) this.drawSkeleton();
      this.drawTrace();
    } finally {
      p.pop();
    }
    return this;
  }

  drawSkeleton() {
    const p = this.p;
    const positions = new Map();
    for (const [name, point] of this.pose) {
      const position = this.landmark(name);
      if (position) positions.set(point.index, scale(position, this.options.poseScale));
    }
    p.fill(153, 0, 255);
    p.stroke(53, 255, 173);
    p.strokeWeight(2);
    for (const [a, b] of this.connections) {
      const start = positions.get(a);
      const end = positions.get(b);
      if (start && end) p.line(start[0], -start[1], start[2], end[0], -end[1], end[2]);
    }
    p.noStroke();
    p.fill(153, 0, 255);
    for (const point of positions.values()) {
      p.push();
      p.translate(point[0], -point[1], point[2]);
      p.box(this.options.jointSize);
      p.pop();
    }
  }

  drawTrace() {
    if (!this.options.traceLandmark || this.options.traceLength === 0) {
      this.trace.length = 0;
      return;
    }
    const point = this.landmark(this.options.traceLandmark);
    if (point) this.trace.push(scale(point, this.options.poseScale));
    for (const item of this.trace) {
      const [x, y, z] = item;
      const cosine = Math.cos(this.options.traceRotation);
      const sine = Math.sin(this.options.traceRotation);
      item[0] = x * cosine + z * sine;
      item[2] = -x * sine + z * cosine;
      item[1] = y;
    }
    while (this.trace.length > this.options.traceLength) this.trace.shift();
    if (this.trace.length < 2) return;
    const p = this.p;
    p.fill(238, 255, 255);
    p.noFill();
    p.stroke(238, 255, 255, 200);
    p.strokeWeight(3);
    p.beginShape();
    for (const item of this.trace) p.vertex(item[0], -item[1], item[2]);
    p.endShape();
  }

  releaseModel() {
    for (const part of this.parts) this.p.freeGeometry(part.geometry);
    this.model = null;
    this.parts = [];
    this.rig = [];
  }

  assertActive() {
    if (this.disposed) throw new Error('This TripoP5 object has been disposed.');
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loadId++;
    this.releaseModel();
    this.textures.length = 0;
    this.clearPose();
  }
}
