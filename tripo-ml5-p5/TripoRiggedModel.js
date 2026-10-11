class TripoRiggedModel {
  constructor(options = {}) {
    const p = globalThis.p5?.instance;
    if (!p?._renderer?.isP3D) {
      throw new Error("Call createCanvas(width, height, WEBGL) before creating TripoRiggedModel.");
    }

    this.p = p;
    this.options = { ...TripoRiggedModel.#defaults };
    this.setOptions(options);
    this.scene = null;
    this.parts = [];
    this.rig = [];
    this.pose = new Map();
    this.connections = [];
    this.trace = [];
    this.bounds = null;
    this.error = null;
    this.loadId = 0;
    this.disposed = false;
    this.id = TripoRiggedModel.#nextId++;
    this.#dropDocument = p.canvas.ownerDocument;
    if (this.#dropDocument.addEventListener) {
      TripoRiggedModel.#dropModels.push(this);
      this.#dropDocument.addEventListener("dragover", this.#onDragOver);
      this.#dropDocument.addEventListener("drop", this.#onDrop);
    }
  }

  static async load(url, options = {}) {
    // let's keep construction synchronous and wait for the files here.
    const model = new TripoRiggedModel(options);
    try {
      await model.load(url);
      return model;
    } catch (error) {
      model.dispose();
      throw error;
    }
  }

  async load(source) {
    this.#assertActive();
    const loadId = ++this.loadId;
    const objectUrls = [];
    try {
      const isFile = typeof File !== "undefined" && source instanceof File;
      if (!isFile && (typeof source !== "string" || !source.trim())) {
        throw new TypeError("load() requires a GLB URL or File.");
      }
      if (isFile && !/\.glb$/i.test(source.name)) {
        throw new TypeError("Please drop a .glb file.");
      }
      let bytes;
      if (isFile) {
        // read local files directly; nothing needs to be uploaded.
        bytes = await source.arrayBuffer();
      } else {
        const response = await fetch(source);
        if (!response.ok) throw new Error(`GLB load failed (${response.status}): ${source}`);
        bytes = await response.arrayBuffer();
      }
      const parsed = this.#parseGLB(bytes);
      const prepared = this.#createScene(parsed, loadId);

      for (const part of prepared.parts) {
        if (part.textureIndex === undefined) continue;
        const imageSource = this.#imageSource(parsed, part.textureIndex, isFile ? null : source);
        if (imageSource.startsWith("blob:")) objectUrls.push(imageSource);
        part.texture = await new Promise((resolve, reject) => {
          this.p.loadImage(imageSource, resolve, () => reject(new Error(`Could not load GLB texture: ${imageSource}`)));
        });
      }
      // a newer load gets the final say; keep the current model until its replacement is ready.
      if (this.disposed || loadId !== this.loadId) {
        throw new Error(`GLB load cancelled: ${isFile ? source.name : source}`);
      }

      for (const part of prepared.parts) this.#updateGeometry(part, prepared);
      const bounds = this.#measureBounds(prepared.parts);
      this.#releaseScene();
      this.scene = prepared;
      this.parts = prepared.parts;
      this.rig = prepared.rig;
      this.bounds = bounds;
      this.error = null;
      return this;
    } catch (error) {
      if (!this.disposed && loadId === this.loadId) this.error = error;
      console.error("[TripoRiggedModel]", error);
      throw error;
    } finally {
      // the images are decoded now, so we can release their temporary blob urls.
      for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
    }
  }

  update(poses, elapsedMs = this.p.deltaTime) {
    this.#assertActive();
    if (!Array.isArray(poses)) {
      throw new TypeError("update() requires the ml5 poses array. Pass [] when no person is detected.");
    }
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
      throw new RangeError("update() requires a finite, nonnegative elapsed time in milliseconds.");
    }
    this.#setPose(poses[0] ?? null);
    // keep the old 60 fps feel, but use elapsed time instead of counting frames.
    const frameSteps = elapsedMs / (1000 / 60);
    const amount = elapsedMs === 0 ? 0 : 1 - Math.pow(1 - this.options.smoothing, frameSteps);
    this.#updateRig(amount);
    // no movement means no vertex work or gpu buffer upload.
    for (const part of this.parts) {
      const version = this.#geometryVersion(part);
      if (version !== part.worldVersion || part.modelScale !== this.options.modelScale) {
        this.#updateGeometry(part);
      }
    }
    this.#updateTrace(frameSteps);
    return this;
  }

  draw(...coordinates) {
    this.#assertActive();
    if (coordinates.length) this.position(...coordinates);
    const p = this.p;
    p.push();
    try {
      // place the centered model first, then fit its geometry inside that transform.
      p.translate(...this.#position, 0);
      p.rotateX(this.#rotation[0]);
      p.rotateY(this.#rotation[1]);
      p.rotateZ(this.#rotation[2]);
      p.scale(this.#displayScale);
      if (this.bounds) {
        // fit against the bind pose so the model doesn't resize as the person moves.
        const ratio = this.options.modelScale / this.bounds.modelScale;
        const [sx, sy, sz] = this.bounds.size.map((value) => value * ratio);
        const fit = Math.min(p.width * 0.8 / Math.max(sx, sz), p.height * 0.8 / sy);
        p.scale(fit);
        p.translate(...this.bounds.center.map((value) => -value * ratio));
      }
      p.ambientLight(160);
      p.directionalLight(255, 255, 255, -0.5, 1, -1);
      p.colorMode(p.RGB, 255);
      p.noStroke();
      p.textureMode(p.NORMAL);

      if (this.options.visible) {
        for (const part of this.parts) {
          const [r, g, b] = part.baseColor.map((value) => value * 255);
          p.fill(r, g, b, part.alpha * 255);
          if (part.texture) {
            p.tint(r, g, b, part.alpha * 255);
            p.texture(part.texture);
          }
          p.model(part.geometry);
        }
      }
      if (this.options.showSkeleton) this.#drawSkeleton();
      this.#drawTrace();
    } finally {
      p.pop();
    }
    return this;
  }

  position(x, y) {
    this.#assertActive();
    if (arguments.length !== 2 || ![x, y].every(Number.isFinite)) {
      throw new TypeError("position(x, y) requires 2 finite numbers.");
    }
    this.#position = [x, y];
    return this;
  }

  scale(value) {
    this.#assertActive();
    if (arguments.length !== 1 || !Number.isFinite(value)) {
      throw new TypeError("scale(value) requires 1 finite number.");
    }
    this.#displayScale = value;
    return this;
  }

  rotateX(angle) { return this.#setRotation(0, angle); }
  rotateY(angle) { return this.#setRotation(1, angle); }
  rotateZ(angle) { return this.#setRotation(2, angle); }

  rotate(x, y, z) {
    this.#assertActive();
    if (arguments.length !== 3) {
      console.warn("[TripoRiggedModel] rotate(x, y, z): please provide all 3 arguments.");
      return this;
    }
    if (![x, y, z].every(Number.isFinite)) {
      throw new TypeError("rotate(x, y, z) requires 3 finite numbers.");
    }
    this.#rotation = [x, y, z];
    return this;
  }

  setOptions(options) {
    for (const key of Object.keys(options)) {
      if (!Object.hasOwn(TripoRiggedModel.#defaults, key)) {
        throw new TypeError(`Unknown TripoRiggedModel option: ${key}`);
      }
    }
    const next = { ...this.options, ...options };
    for (const key of ["modelScale", "poseScale", "jointSize"]) {
      if (!Number.isFinite(next[key]) || next[key] <= 0) throw new RangeError(`${key} must be positive.`);
    }
    for (const key of ["smoothing", "minConfidence"]) {
      if (!Number.isFinite(next[key]) || next[key] < 0 || next[key] > 1) {
        throw new RangeError(`${key} must be between 0 and 1.`);
      }
    }
    for (const key of ["mirror", "modelMirror", "visible", "showSkeleton"]) {
      if (typeof next[key] !== "boolean") throw new TypeError(`${key} must be a boolean.`);
    }
    if (!Number.isInteger(next.traceLength) || next.traceLength < 0) {
      throw new RangeError("traceLength must be a nonnegative integer.");
    }
    if (!Number.isFinite(next.traceRotation)) throw new RangeError("traceRotation must be finite.");
    if (next.traceLandmark !== null && typeof next.traceLandmark !== "string") {
      throw new TypeError("traceLandmark must be a landmark name or null.");
    }
    if (next.traceLandmark !== this.options.traceLandmark) this.trace?.splice(0);
    this.options = next;
    return this;
  }

  setSkeleton(connections) {
    this.#assertActive();
    if (!Array.isArray(connections) || connections.some((pair) => (
      !Array.isArray(pair) || pair.length !== 2 || pair.some((i) => !Number.isInteger(i) || i < 0)
    ))) throw new TypeError("setSkeleton() requires ml5 getSkeleton() index pairs.");
    this.connections = connections.map((pair) => [...pair]);
    return this;
  }

  clearPose() {
    this.pose.clear();
    this.trace.length = 0;
    return this;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loadId++;
    this.#dropDocument.removeEventListener?.("dragover", this.#onDragOver);
    this.#dropDocument.removeEventListener?.("drop", this.#onDrop);
    TripoRiggedModel.#dropModels = TripoRiggedModel.#dropModels.filter((model) => model !== this);
    this.#releaseScene();
    this.clearPose();
  }

  #assertActive() {
    if (this.disposed) throw new Error("This TripoRiggedModel object has been disposed.");
  }

  #position = [0, 0];
  #rotation = [0, 0, 0];
  #displayScale = 1;
  #dropDocument;

  #setRotation(axis, angle) {
    this.#assertActive();
    if (!Number.isFinite(angle)) throw new TypeError("Rotation requires a finite angle.");
    this.#rotation[axis] = angle;
    return this;
  }

  #acceptsDrop(event) {
    return TripoRiggedModel.#dropModels.findLast((model) => (
      model.#dropDocument === this.#dropDocument
    )) === this && Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  #onDragOver = (event) => {
    if (!this.#acceptsDrop(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  #onDrop = async (event) => {
    if (!this.#acceptsDrop(event)) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      this.error = new Error("Please drop one .glb file at a time.");
      console.error("[TripoRiggedModel]", this.error);
      return;
    }
    try {
      await this.load(files[0]);
    } catch {
      // load already reports the error; don't leave an unhandled event promise.
    }
  };

  #releaseScene() {
    for (const part of this.parts) this.p.freeGeometry(part.geometry);
    this.scene = null;
    this.parts = [];
    this.rig = [];
    this.bounds = null;
  }

  #measureBounds(parts) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const part of parts) {
      for (const point of part.geometry.vertices) {
        for (const [index, value] of [point.x, point.y, point.z].entries()) {
          min[index] = Math.min(min[index], value);
          max[index] = Math.max(max[index], value);
        }
      }
    }
    return {
      center: min.map((value, i) => (value + max[i]) / 2),
      size: min.map((value, i) => Math.max(max[i] - value, 1)),
      modelScale: this.options.modelScale,
    };
  }

  // let's turn the detected pose into bone rotations.
  #setPose(pose) {
    if (pose == null) {
      this.clearPose();
      return;
    }
    if (!Array.isArray(pose.keypoints3D)) {
      throw new TypeError("A BlazePose result with keypoints3D is required.");
    }
    const next = new Map();
    // copy the landmarks so mirroring and smoothing never change the ml5 results.
    for (const [index, point] of pose.keypoints3D.entries()) {
      const confidence = point?.confidence ?? point?.score;
      if (!point || typeof point.name !== "string" ||
          ![point.x, point.y, point.z, confidence].every(Number.isFinite)) {
        throw new TypeError("Each 3D landmark requires a name, finite x/y/z and confidence (or score).");
      }
      next.set(point.name, { index, x: point.x, y: point.y, z: point.z, confidence });
    }
    this.pose = next;
  }

  #landmark(name) {
    const point = this.pose.get(name);
    if (!point || point.confidence < this.options.minConfidence) return null;
    return [point.x * (this.options.mirror ? -1 : 1), -point.y, -point.z];
  }

  #updateRig(amount) {
    if (!this.scene || amount === 0) return;
    const changed = new Set();
    // walk parents first, and touch each affected descendant only once.
    for (const node of this.scene.order) {
      const item = this.scene.rigByNode.get(node);
      let localChanged = false;
      if (item) {
        const names = item.landmarks.map((name) => {
          if (!this.options.modelMirror) return name;
          return name.startsWith("left_") ? `right_${name.slice(5)}` : `left_${name.slice(6)}`;
        });
        const points = names.map((name) => this.#landmark(name));
        let target = item.bindLocalQuaternion;
        if (points.every(Boolean)) {
          let direction = this.#subtract(points[1], points[0]);
          if (points.length === 4) {
            direction = this.#scale(this.#add(direction, this.#subtract(points[3], points[2])), 0.5);
          }
          if (this.#length(direction) > 1e-12) {
            const delta = this.#quaternionBetween(item.bindDirection, this.#normalize(direction));
            const desired = this.#normalizeQuaternion(this.#multiplyQuaternion(delta, item.bindWorldQuaternion));
            const parentRotation = item.bone.parent?.worldRotation ?? [0, 0, 0, 1];
            target = this.#normalizeQuaternion(this.#multiplyQuaternion(this.#inverseQuaternion(parentRotation), desired));
          }
        }
        const current = item.currentQuaternion;
        // q and -q are the same rotation; stay on the same side when settling.
        if (this.#dot(current, target) < 0) target = target.map((value) => -value);
        const next = this.#slerp(current, target, amount);
        // snap tiny component differences so smoothing can actually finish.
        if (next.every((value, i) => Math.abs(value - target[i]) < 5e-8)) {
          for (let i = 0; i < 4; i++) next[i] = target[i];
        }
        if (!next.every((value, i) => value === current[i])) {
          item.currentQuaternion = next;
          node.rotation = next.slice();
          node.matrix = null;
          localChanged = true;
        }
      }
      if (localChanged || changed.has(node.parent)) {
        this.#updateWorldNode(node);
        changed.add(node);
      }
    }
  }

  #geometryVersion(part) {
    return part.jointsData
      ? part.joints.reduce((sum, joint) => sum + joint.worldVersion, 0)
      : part.node.worldVersion;
  }

  #updateGeometry(part, scene = this.scene) {
    const { vertices, vertexNormals: normals, faces } = part.geometry;
    const { positions, jointsData, weightsData, normalsData } = part;
    const modelScale = this.options.modelScale;
    const [ox, oy, oz] = scene.offset;
    const matrices = part.joints.map((joint, index) => (
      // these are world-space skin matrices; don't apply the mesh node twice.
      this.#multiplyMatrix(joint.worldMatrix, part.inverseBinds[index])
    ));
    // keep this hot loop scalar: temporary arrays per vertex make garbage collection expensive.
    for (let index = 0; index < part.vertexCount; index++) {
      const x = positions[index * 3];
      const y = positions[index * 3 + 1];
      const z = positions[index * 3 + 2];
      let px = 0;
      let py = 0;
      let pz = 0;
      let a = 0; let b = 0; let c = 0;
      let d = 0; let e = 0; let f = 0;
      let g = 0; let h = 0; let k = 0;
      let matrix = part.node.worldMatrix;
      if (jointsData && weightsData) {
        let total = 0;
        for (let slot = 0; slot < 4; slot++) {
          const weight = weightsData[index * 4 + slot];
          if (!weight) continue;
          const jointIndex = jointsData[index * 4 + slot];
          const m = matrices[jointIndex];
          if (!m) throw new Error(`Mesh ${part.node.name} references missing joint ${jointIndex}.`);
          const w = m[3] * x + m[7] * y + m[11] * z + m[15];
          const factor = weight / (w && w !== 1 ? w : 1);
          px += (m[0] * x + m[4] * y + m[8] * z + m[12]) * factor;
          py += (m[1] * x + m[5] * y + m[9] * z + m[13]) * factor;
          pz += (m[2] * x + m[6] * y + m[10] * z + m[14]) * factor;
          if (normalsData) {
            a += m[0] * weight; b += m[4] * weight; c += m[8] * weight;
            d += m[1] * weight; e += m[5] * weight; f += m[9] * weight;
            g += m[2] * weight; h += m[6] * weight; k += m[10] * weight;
          }
          total += weight;
        }
        if (total > 0) {
          matrix = null;
          if (Math.abs(total - 1) > 1e-5) {
            px /= total;
            py /= total;
            pz /= total;
          }
        }
      }
      if (matrix) {
        const m = matrix;
        const w = m[3] * x + m[7] * y + m[11] * z + m[15];
        const divisor = w && w !== 1 ? w : 1;
        px = (m[0] * x + m[4] * y + m[8] * z + m[12]) / divisor;
        py = (m[1] * x + m[5] * y + m[9] * z + m[13]) / divisor;
        pz = (m[2] * x + m[6] * y + m[10] * z + m[14]) / divisor;
        a = m[0]; b = m[4]; c = m[8];
        d = m[1]; e = m[5]; f = m[9]; g = m[2]; h = m[6]; k = m[10];
      }
      vertices[index].set((px + ox) * modelScale, -(py + oy) * modelScale, (pz + oz) * modelScale);
      if (normalsData) {
        // inverse-transpose the blended transform so nonuniform scales keep the lighting right.
        const nx = normalsData[index * 3];
        const ny = normalsData[index * 3 + 1];
        const nz = normalsData[index * 3 + 2];
        const ca = e * k - f * h; const cb = f * g - d * k; const cc = d * h - e * g;
        const determinant = a * ca + b * cb + c * cc;
        const sign = determinant < 0 ? -1 : 1;
        const tx = (ca * nx + cb * ny + cc * nz) * sign;
        const ty = ((c * h - b * k) * nx + (a * k - c * g) * ny + (b * g - a * h) * nz) * sign;
        const tz = ((b * f - c * e) * nx + (c * d - a * f) * ny + (a * e - b * d) * nz) * sign;
        normals[index].set(tx, -ty, tz);
      } else {
        normals[index].set(0, 0, 0);
      }
    }
    // only rebuild triangle normals when the file didn't provide authored normals.
    if (!normalsData) for (const face of faces) {
      const a = vertices[face[0]];
      const b = vertices[face[1]];
      const c = vertices[face[2]];
      const abx = b.x - a.x; const aby = b.y - a.y; const abz = b.z - a.z;
      const acx = c.x - a.x; const acy = c.y - a.y; const acz = c.z - a.z;
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      for (const vertexIndex of face) {
        const normal = normals[vertexIndex];
        normal.x += nx;
        normal.y += ny;
        normal.z += nz;
      }
    }
    for (const normal of normals) {
      const magnitude = Math.sqrt(normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);
      if (magnitude > 1e-12) {
        normal.x /= magnitude;
        normal.y /= magnitude;
        normal.z /= magnitude;
      } else {
        normal.set(0, 0, 0);
      }
    }
    part.modelScale = modelScale;
    part.worldVersion = this.#geometryVersion(part);
    // tell p5 to upload the changed buffers without recreating the geometry.
    part.geometry.dirtyFlags.vertices = true;
    part.geometry.dirtyFlags.vertexNormals = true;
  }

  #drawSkeleton() {
    const p = this.p;
    const positions = new Map();
    for (const [name, point] of this.pose) {
      const position = this.#landmark(name);
      if (position) positions.set(point.index, this.#scale(position, this.options.poseScale));
    }
    p.fill(153, 0, 255);
    p.stroke(53, 255, 173);
    p.strokeWeight(2);
    for (const [a, b] of this.connections) {
      const start = positions.get(a);
      const end = positions.get(b);
      if (start && end) p.line(...start, ...end);
    }
    p.noStroke();
    p.fill(153, 0, 255);
    for (const point of positions.values()) {
      p.push();
      p.translate(...point);
      p.box(this.options.jointSize);
      p.pop();
    }
  }

  #updateTrace(frameSteps) {
    if (frameSteps === 0) return;
    if (!this.options.traceLandmark || this.options.traceLength === 0) {
      this.trace.length = 0;
      return;
    }
    const point = this.#landmark(this.options.traceLandmark);
    if (point) this.trace.push(this.#scale(point, this.options.poseScale));
    const cosine = Math.cos(this.options.traceRotation * frameSteps);
    const sine = Math.sin(this.options.traceRotation * frameSteps);
    for (const item of this.trace) {
      const [x, , z] = item;
      item[0] = x * cosine + z * sine;
      item[2] = -x * sine + z * cosine;
    }
    while (this.trace.length > this.options.traceLength) this.trace.shift();
  }

  #drawTrace() {
    if (this.trace.length < 2) return;
    const p = this.p;
    p.fill(238, 255, 255);
    p.noFill();
    p.stroke(238, 255, 255, 200);
    p.strokeWeight(3);
    p.beginShape();
    for (const point of this.trace) p.vertex(...point);
    p.endShape();
  }

  // let's unpack the glb and build the scene.
  #parseGLB(buffer) {
    const view = new DataView(buffer);
    if (view.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error("Invalid GLB header.");
    if (view.getUint32(4, true) !== 2) throw new Error("Only GLB version 2 is supported.");
    const declaredLength = view.getUint32(8, true);
    if (declaredLength !== view.byteLength) throw new Error("GLB declared length does not match the file.");
    let offset = 12;
    let gltf;
    let binary;
    while (offset + 8 <= declaredLength) {
      const chunkLength = view.getUint32(offset, true);
      const chunkType = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (chunkLength % 4 || start + chunkLength > declaredLength) throw new Error("Invalid GLB chunk length.");
      if (offset === 12 && chunkType !== 0x4e4f534a) throw new Error("GLB must start with its JSON chunk.");
      if (chunkType === 0x4e4f534a) {
        if (gltf) throw new Error("Duplicate GLB JSON chunk.");
        gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, chunkLength)));
      }
      if (chunkType === 0x004e4942) {
        if (binary) throw new Error("Duplicate GLB binary chunk.");
        binary = buffer.slice(start, start + chunkLength);
      }
      offset = start + chunkLength;
    }
    if (offset !== declaredLength) throw new Error("Incomplete GLB chunk header.");
    if (!gltf || !binary) throw new Error("GLB must contain JSON and binary chunks.");
    if (gltf.asset?.version !== "2.0" || (gltf.asset.minVersion && gltf.asset.minVersion !== "2.0")) {
      throw new Error("Only glTF asset version 2.0 is supported.");
    }
    if (gltf.extensionsRequired?.length) {
      throw new Error(`Unsupported required glTF extensions: ${gltf.extensionsRequired.join(", ")}`);
    }
    if (!Array.isArray(gltf.buffers) || gltf.buffers.length !== 1 || gltf.buffers[0].uri !== undefined) {
      throw new Error("Only a single embedded GLB buffer is supported.");
    }
    const length = gltf.buffers[0].byteLength;
    if (!Number.isSafeInteger(length) || length < 1 || length > binary.byteLength || binary.byteLength - length > 3) {
      throw new Error("Invalid GLB buffer byte length.");
    }
    binary = binary.slice(0, length);
    if (!Array.isArray(gltf.nodes) || !Array.isArray(gltf.meshes)) throw new Error("GLB has no drawable scene nodes.");
    return { gltf, binary };
  }

  #createScene(parsed, loadId) {
    const { gltf, binary } = parsed;
    const nodes = gltf.nodes.map((definition, index) => this.#makeNode(definition, index));
    for (const [index, definition] of gltf.nodes.entries()) {
      if (definition.children !== undefined && !Array.isArray(definition.children)) {
        throw new Error(`Invalid children list on GLB node ${index}.`);
      }
      for (const childIndex of definition.children ?? []) {
        const child = this.#entry(nodes, childIndex, "node");
        if (!child || child.parent) throw new Error("GLB contains an invalid node hierarchy.");
        child.parent = nodes[index];
        child.parent.children.push(child);
      }
    }
    // build a parent-first order without recursion, and reject cycles even in unused nodes.
    const order = [];
    const pending = nodes.filter((node) => !node.parent).reverse();
    while (pending.length) {
      const node = pending.pop();
      order.push(node);
      for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
    }
    if (order.length !== nodes.length) throw new Error("GLB node hierarchy contains a cycle.");
    const scene = this.#entry(gltf.scenes, gltf.scene ?? 0, "scene");
    if (!scene || !Array.isArray(scene.nodes)) throw new Error("GLB has no active scene.");
    const active = new Set();
    for (const root of scene.nodes) {
      const node = this.#entry(nodes, root, "scene root");
      if (node.parent || active.has(node)) throw new Error("GLB scene roots must be unique parentless nodes.");
      active.add(node);
    }
    for (const node of order) {
      if (active.has(node.parent)) active.add(node);
      this.#updateWorldNode(node);
    }
    const byName = new Map();
    for (const node of active) {
      if (node.name && !byName.has(node.name)) byName.set(node.name, node);
    }
    const hips = byName.get("mixamorigHips");
    const offset = hips ? this.#scale(this.#transformPoint(hips.worldMatrix, [0, 0, 0]), -1) : [0, 0, 0];
    const rig = [];
    for (const [name, endName, ...landmarks] of TripoRiggedModel.#boneMappings) {
      const bone = byName.get(name);
      const end = byName.get(endName);
      if (!bone || !end) continue;
      const direction = this.#normalize(this.#subtract(
        this.#transformPoint(end.worldMatrix, [0, 0, 0]),
        this.#transformPoint(bone.worldMatrix, [0, 0, 0])
      ));
      if (this.#length(direction) < 1e-8) continue;
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
      const mesh = this.#entry(gltf.meshes, node.mesh, "mesh");
      if (!Array.isArray(mesh.primitives) || !mesh.primitives.length) throw new Error("GLB mesh has no primitives.");
      if (mesh.weights?.length || mesh.primitives.some((primitive) => primitive.targets?.length)) {
        throw new Error("Morph targets are not supported by TripoRiggedModel.");
      }
      const skin = node.skin === undefined ? null : this.#entry(gltf.skins, node.skin, "skin");
      if (skin && (!Array.isArray(skin.joints) || !skin.joints.length)) throw new Error("GLB skin has no joints.");
      const joints = skin ? skin.joints.map((index) => this.#entry(nodes, index, "joint")) : [];
      if (new Set(joints).size !== joints.length) throw new Error("GLB skin has duplicate joints.");
      if (skin?.skeleton !== undefined) this.#entry(nodes, skin.skeleton, "skeleton");
      const inverseBindData = skin?.inverseBindMatrices === undefined
        ? null : this.#readAccessor(gltf, binary, skin.inverseBindMatrices, "MAT4", [5126], joints.length);
      const inverseBinds = joints.map((_, index) => (
        inverseBindData ? inverseBindData.slice(index * 16, index * 16 + 16) : this.#identityMatrix()
      ));
      for (const matrix of inverseBinds) this.#validateAffine(matrix, "inverse bind matrix");
      for (const primitive of mesh.primitives) {
        if (primitive.mode !== undefined && primitive.mode !== 4) {
          throw new Error("Only triangle-list GLB primitives are supported.");
        }
        const attributes = primitive.attributes ?? {};
        if (attributes.JOINTS_1 !== undefined || attributes.WEIGHTS_1 !== undefined) {
          throw new Error("More than four skin influences per vertex are not supported.");
        }
        if (attributes.POSITION === undefined) throw new Error(`Mesh ${node.name} has no position attribute.`);
        const positions = this.#readAccessor(gltf, binary, attributes.POSITION, "VEC3", [5126]);
        const vertexCount = positions.length / 3;
        const indices = primitive.indices === undefined
          ? Array.from({ length: vertexCount }, (_, index) => index)
          : this.#readAccessor(gltf, binary, primitive.indices, "SCALAR", [5121, 5123, 5125]);
        if (indices.length % 3) throw new Error(`Mesh ${node.name} has an incomplete triangle.`);
        if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= vertexCount)) {
          throw new Error(`Mesh ${node.name} has an out-of-range triangle index.`);
        }
        const jointsData = attributes.JOINTS_0 === undefined
          ? null : this.#readAccessor(gltf, binary, attributes.JOINTS_0, "VEC4", [5121, 5123], vertexCount);
        const weightsData = attributes.WEIGHTS_0 === undefined
          ? null : this.#readAccessor(gltf, binary, attributes.WEIGHTS_0, "VEC4", [5126, 5121, 5123], vertexCount, true);
        if (!!jointsData !== !!weightsData) throw new Error(`Mesh ${node.name} has incomplete skin attributes.`);
        if (skin && !jointsData) throw new Error(`Skinned mesh ${node.name} requires joint and weight attributes.`);
        if (jointsData && (!skin || jointsData.some((joint) => !Number.isInteger(joint) || joint >= joints.length))) {
          throw new Error(`Mesh ${node.name} has an invalid skin joint index.`);
        }
        if (weightsData) {
          for (let i = 0; i < vertexCount; i++) {
            const weights = weightsData.slice(i * 4, i * 4 + 4);
            if (weights.some((weight) => weight < 0) || weights.reduce((sum, w) => sum + w, 0) <= 0) {
              throw new Error(`Mesh ${node.name} has invalid skin weights.`);
            }
          }
        }
        const normalsData = attributes.NORMAL === undefined
          ? null : this.#readAccessor(gltf, binary, attributes.NORMAL, "VEC3", [5126], vertexCount);
        const uvs = attributes.TEXCOORD_0 === undefined
          ? null : this.#readAccessor(gltf, binary, attributes.TEXCOORD_0, "VEC2", [5126, 5121, 5123], vertexCount, true);
        const material = primitive.material === undefined ? {} : this.#entry(gltf.materials, primitive.material, "material");
        const pbr = material.pbrMetallicRoughness ?? {};
        const baseColor = pbr.baseColorFactor ?? [1, 1, 1, 1];
        this.#finiteVector(baseColor, 4, "base color");
        if (baseColor.some((v) => v < 0 || v > 1)) throw new Error("Base color values must be between 0 and 1.");
        if (pbr.baseColorTexture && (!uvs || (pbr.baseColorTexture.texCoord ?? 0) !== 0 ||
            pbr.baseColorTexture.extensions?.KHR_texture_transform)) {
          throw new Error("Base color textures require untransformed TEXCOORD_0.");
        }
        const geometry = new globalThis.p5.Geometry();
        geometry.gid = `tripo-${this.id}-${parts.length}-${loadId}`;
        geometry.vertexNormals = [];
        // glb and p5 image textures use the same v direction; don't flip it here.
        for (let index = 0; index < vertexCount; index++) {
          geometry.vertices.push(this.p.createVector(0, 0, 0));
          geometry.vertexNormals.push(this.p.createVector(0, 0, 0));
          geometry.uvs.push(uvs ? uvs[index * 2] : 0, uvs ? uvs[index * 2 + 1] : 0);
        }
        geometry.faces = [];
        // the p5 y flip reverses winding; a reflected rigid node reverses it again.
        const reflected = !skin && this.#determinant3(node.worldMatrix) < 0;
        for (let i = 0; i < indices.length; i += 3) {
          geometry.faces.push(reflected
            ? [indices[i], indices[i + 1], indices[i + 2]]
            : [indices[i], indices[i + 2], indices[i + 1]]);
        }
        parts.push({
          node, geometry, positions, normalsData, jointsData, weightsData, joints, inverseBinds,
          baseColor, alpha: material.alphaMode === "BLEND" ? baseColor[3] : 1,
          textureIndex: pbr.baseColorTexture?.index, texture: null, vertexCount,
        });
      }
    }
    if (!parts.length) throw new Error("The model contains no drawable meshes.");
    return { nodes, order, offset, rig, rigByNode: new Map(rig.map((item) => [item.bone, item])), parts };
  }

  #makeNode(definition, index) {
    if (!definition || typeof definition !== "object") throw new Error(`Invalid GLB node ${index}.`);
    const matrix = definition.matrix;
    if (matrix !== undefined) {
      this.#validateAffine(matrix, `node ${index} matrix`);
      if (["translation", "rotation", "scale"].some((key) => definition[key] !== undefined)) {
        throw new Error(`GLB node ${index} cannot combine a matrix with translation, rotation or scale.`);
      }
    }
    const matrixScale = matrix && [
      Math.hypot(matrix[0], matrix[1], matrix[2]),
      Math.hypot(matrix[4], matrix[5], matrix[6]),
      Math.hypot(matrix[8], matrix[9], matrix[10]),
    ];
    if (matrixScale) {
      // put the reflection into scale instead of losing it during quaternion extraction.
      if (this.#determinant3(matrix) < 0) matrixScale[0] *= -1;
      if (matrixScale.some((value) => value === 0)) throw new Error("Zero-scale node matrices are not supported.");
    }
    const translation = definition.translation ?? (matrix ? matrix.slice(12, 15) : [0, 0, 0]);
    const rotation = definition.rotation ?? (matrix ? this.#matrixQuaternion(matrix, matrixScale) : [0, 0, 0, 1]);
    const scale = definition.scale ?? matrixScale ?? [1, 1, 1];
    this.#finiteVector(translation, 3, `node ${index} translation`);
    this.#finiteVector(rotation, 4, `node ${index} rotation`);
    this.#finiteVector(scale, 3, `node ${index} scale`);
    if (scale.some((value) => value === 0) || this.#dot(rotation, rotation) < 1e-12) {
      throw new Error(`GLB node ${index} has a zero scale or invalid quaternion.`);
    }
    const normalizedRotation = this.#normalizeQuaternion(rotation);
    if (matrix) {
      const composed = this.#composeMatrix(translation, normalizedRotation, scale);
      if (matrix.some((value, i) => Math.abs(value - composed[i]) > 1e-5 * Math.max(1, Math.abs(value)))) {
        throw new Error(`GLB node ${index} contains unsupported shear.`);
      }
    }
    return {
      index, name: (definition.name ?? "").replace("mixamorig:", "mixamorig"),
      mesh: definition.mesh, skin: definition.skin,
      translation: [...translation], rotation: normalizedRotation, scale: [...scale], matrix: matrix ? [...matrix] : null,
      parent: null, children: [],
      worldMatrix: this.#identityMatrix(), worldRotation: [0, 0, 0, 1], worldVersion: 0,
    };
  }

  #updateWorldNode(node) {
    const local = node.matrix ?? this.#composeMatrix(node.translation, node.rotation, node.scale);
    node.worldMatrix = node.parent ? this.#multiplyMatrix(node.parent.worldMatrix, local) : local;
    node.worldRotation = this.#normalizeQuaternion(
      this.#multiplyQuaternion(node.parent?.worldRotation ?? [0, 0, 0, 1], node.rotation)
    );
    node.worldVersion++;
  }

  #entry(array, index, label) {
    if (!Array.isArray(array) || !Number.isInteger(index) || index < 0 || index >= array.length || !array[index]) {
      throw new Error(`Invalid GLB ${label} index: ${index}.`);
    }
    return array[index];
  }

  #finiteVector(value, size, label) {
    if (!Array.isArray(value) || value.length !== size || !value.every(Number.isFinite)) {
      throw new Error(`GLB ${label} requires ${size} finite values.`);
    }
  }

  #determinant3(m) {
    return m[0] * (m[5] * m[10] - m[9] * m[6])
      - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  }

  #validateAffine(matrix, label) {
    this.#finiteVector(matrix, 16, label);
    if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) {
      throw new Error(`GLB ${label} must be affine.`);
    }
  }

  #bufferView(gltf, binary, index) {
    const view = this.#entry(gltf.bufferViews, index, "buffer view");
    const start = view.byteOffset ?? 0;
    if (view.buffer !== 0 || !Number.isSafeInteger(start) || start < 0 ||
        !Number.isSafeInteger(view.byteLength) || view.byteLength < 1 || start + view.byteLength > binary.byteLength) {
      throw new Error("GLB buffer view is outside the embedded buffer.");
    }
    return view;
  }

  #readAccessor(gltf, binary, accessorIndex, type, componentTypes, count, allowNormalized = false) {
    const accessor = this.#entry(gltf.accessors, accessorIndex, "accessor");
    if (accessor.sparse) throw new Error("Sparse GLB accessors are not supported.");
    if (accessor.type !== type || !componentTypes.includes(accessor.componentType)) {
      throw new Error(`GLB accessor ${accessorIndex} requires ${type} with component type ${componentTypes.join("/")}.`);
    }
    if (!Number.isSafeInteger(accessor.count) || accessor.count < 1 || (count !== undefined && accessor.count !== count)) {
      throw new Error(`Invalid count in GLB accessor ${accessorIndex}.`);
    }
    if (accessor.normalized !== undefined && typeof accessor.normalized !== "boolean") {
      throw new Error(`Invalid normalized flag in GLB accessor ${accessorIndex}.`);
    }
    if (accessor.normalized && (!allowNormalized || ![5121, 5123].includes(accessor.componentType))) {
      throw new Error(`Invalid normalized component type in GLB accessor ${accessorIndex}.`);
    }
    if (allowNormalized && accessor.componentType !== 5126 && !accessor.normalized) {
      throw new Error("Integer GLB weights and texture coordinates must be normalized.");
    }
    const components = TripoRiggedModel.#components[accessor.type];
    const componentBytes = TripoRiggedModel.#componentBytes[accessor.componentType];
    if (!components || !componentBytes) throw new Error(`Unsupported GLB accessor type: ${accessor.type}.`);
    if (accessor.bufferView === undefined) throw new Error("GLB accessors without buffer views are not supported.");
    const bufferView = this.#bufferView(gltf, binary, accessor.bufferView);
    const stride = bufferView.byteStride ?? components * componentBytes;
    const offset = accessor.byteOffset ?? 0;
    const start = (bufferView.byteOffset ?? 0) + offset;
    if (!Number.isSafeInteger(stride) || stride < components * componentBytes || stride % componentBytes ||
        (bufferView.byteStride !== undefined && (stride > 252 || stride % 4))) {
      throw new Error("Invalid GLB accessor byte stride.");
    }
    // check the complete span before allocating or reading anything.
    if (!Number.isSafeInteger(offset) || offset < 0 || start % componentBytes ||
        offset + (accessor.count - 1) * stride + components * componentBytes > bufferView.byteLength) {
      throw new Error(`GLB accessor ${accessorIndex} exceeds its buffer view or is misaligned.`);
    }
    const result = new Array(accessor.count * components);
    const view = new DataView(binary);
    for (let row = 0; row < accessor.count; row++) {
      for (let column = 0; column < components; column++) {
        let value = this.#readComponent(view, start + row * stride + column * componentBytes, accessor.componentType);
        if (!Number.isFinite(value)) throw new Error(`Non-finite value in GLB accessor ${accessorIndex}.`);
        if (accessor.normalized) value = this.#normalizedValue(value, accessor.componentType);
        result[row * components + column] = value;
      }
    }
    return result;
  }

  #readComponent(view, offset, type) {
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

  #normalizedValue(value, type) {
    if (type === 5120) return Math.max(value / 127, -1);
    if (type === 5121) return value / 255;
    if (type === 5122) return Math.max(value / 32767, -1);
    if (type === 5123) return value / 65535;
    return value;
  }

  #imageSource(parsed, textureIndex, url) {
    const { gltf, binary } = parsed;
    const texture = this.#entry(gltf.textures, textureIndex, "texture");
    const image = this.#entry(gltf.images, texture.source, "image");
    if (image.uri) {
      if (image.uri.startsWith("data:")) return image.uri;
      if (url === null) throw new Error("Local GLB files must embed their textures; external images are not supported.");
      return new URL(image.uri, new URL(url, this.p.canvas.ownerDocument.baseURI)).href;
    }
    const view = this.#bufferView(gltf, binary, image.bufferView);
    if (!view || !image.mimeType) throw new Error("GLB texture image must have a buffer view and MIME type.");
    const bytes = binary.slice(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    return URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
  }

  // the small math helpers live down here to keep the public api easy to scan.
  #add(a, b) { return a.map((value, i) => value + b[i]); }
  #subtract(a, b) { return a.map((value, i) => value - b[i]); }
  #scale(a, scalar) { return a.map((value) => value * scalar); }
  #dot(a, b) { return a.reduce((sum, value, i) => sum + value * b[i], 0); }
  #length(a) { return Math.sqrt(this.#dot(a, a)); }

  #normalize(a) {
    const magnitude = this.#length(a);
    return magnitude > 1e-12 ? this.#scale(a, 1 / magnitude) : [0, 0, 0];
  }

  #multiplyQuaternion(a, b) {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  }

  #normalizeQuaternion(q) {
    const magnitude = Math.hypot(...q);
    return magnitude > 1e-12 ? q.map((value) => value / magnitude) : [0, 0, 0, 1];
  }

  #inverseQuaternion(q) {
    const n = this.#dot(q, q);
    return n > 1e-12 ? [-q[0] / n, -q[1] / n, -q[2] / n, q[3] / n] : [0, 0, 0, 1];
  }

  #quaternionBetween(from, to) {
    const a = this.#normalize(from);
    const b = this.#normalize(to);
    const cosine = this.#dot(a, b);
    if (cosine < -0.999999) {
      const axis = Math.abs(a[0]) < 0.9
        ? this.#normalize([0, -a[2], a[1]]) : this.#normalize([-a[1], a[0], 0]);
      return [...axis, 0];
    }
    const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    return this.#normalizeQuaternion([...cross, 1 + cosine]);
  }

  #slerp(a, b, amount) {
    let target = b;
    let cosine = this.#dot(a, target);
    if (cosine < 0) {
      target = target.map((value) => -value);
      cosine = -cosine;
    }
    if (cosine > 1 - 1e-12) {
      return this.#normalizeQuaternion(a.map((value, i) => value + amount * (target[i] - value)));
    }
    const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
    const denominator = Math.sin(angle);
    const left = Math.sin((1 - amount) * angle) / denominator;
    const right = Math.sin(amount * angle) / denominator;
    return this.#normalizeQuaternion(a.map((value, i) => left * value + right * target[i]));
  }

  #identityMatrix() {
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }

  #multiplyMatrix(a, b) {
    const out = new Array(16);
    for (let column = 0; column < 4; column++) {
      for (let row = 0; row < 4; row++) {
        out[column * 4 + row] = a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1]
          + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3];
      }
    }
    return out;
  }

  #composeMatrix(translation, rotation, size) {
    const [x, y, z, w] = this.#normalizeQuaternion(rotation);
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

  #transformPoint(matrix, point) {
    const [x, y, z] = point;
    const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    const divisor = w && w !== 1 ? w : 1;
    return [
      (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / divisor,
      (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / divisor,
      (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / divisor,
    ];
  }

  #matrixQuaternion(matrix, [sx, sy, sz]) {
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
    return this.#normalizeQuaternion(q);
  }

  static #nextId = 0;
  static #dropModels = [];
  static #components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  static #componentBytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
  static #defaults = {
    modelScale: 250, poseScale: 250, smoothing: 0.25, minConfidence: 0.3,
    mirror: false, modelMirror: false, visible: true, showSkeleton: false,
    jointSize: 6, traceLandmark: null, traceLength: 80, traceRotation: 0.01,
  };
  static #boneMappings = [
    ["mixamorigSpine", "mixamorigSpine1", "left_hip", "left_shoulder", "right_hip", "right_shoulder"],
    ["mixamorigLeftArm", "mixamorigLeftForeArm", "left_shoulder", "left_elbow"],
    ["mixamorigLeftForeArm", "mixamorigLeftHand", "left_elbow", "left_wrist"],
    ["mixamorigRightArm", "mixamorigRightForeArm", "right_shoulder", "right_elbow"],
    ["mixamorigRightForeArm", "mixamorigRightHand", "right_elbow", "right_wrist"],
    ["mixamorigLeftUpLeg", "mixamorigLeftLeg", "left_hip", "left_knee"],
    ["mixamorigLeftLeg", "mixamorigLeftFoot", "left_knee", "left_ankle"],
    ["mixamorigRightUpLeg", "mixamorigRightLeg", "right_hip", "right_knee"],
    ["mixamorigRightLeg", "mixamorigRightFoot", "right_knee", "right_ankle"],
  ];
}
