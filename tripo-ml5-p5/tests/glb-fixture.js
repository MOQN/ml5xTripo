import { loadLibrary, response, Sketch } from "./library-helper.js";

export const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function fixture({ normals = true, skin = false } = {}) {
  const binary = Buffer.alloc(256);
  const gltf = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: binary.length }],
    bufferViews: [], accessors: [],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: {}, indices: 0 }] }],
    scenes: [{ nodes: [0] }], scene: 0,
  };
  let cursor = 0;
  const add = (data, type, componentType, components) => {
    cursor = Math.ceil(cursor / 4) * 4;
    const bytes = componentType === 5126 ? 4 : 2;
    const offset = cursor;
    data.forEach((value) => {
      if (componentType === 5126) binary.writeFloatLE(value, cursor);
      else binary.writeUInt16LE(value, cursor);
      cursor += bytes;
    });
    gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: cursor - offset });
    gltf.accessors.push({ bufferView: gltf.bufferViews.length - 1, componentType, type, count: data.length / components });
    return gltf.accessors.length - 1;
  };
  const primitive = gltf.meshes[0].primitives[0];
  primitive.indices = add([0, 1, 2], "SCALAR", 5123, 1);
  primitive.attributes.POSITION = add([0, 0, 0, 1, 0, 0, 0, 1, 0], "VEC3", 5126, 3);
  if (normals) primitive.attributes.NORMAL = add([0, 0, 1, 0, 0, 1, 0, 0, 1], "VEC3", 5126, 3);
  if (skin) {
    primitive.attributes.JOINTS_0 = add(new Array(12).fill(0), "VEC4", 5123, 4);
    primitive.attributes.WEIGHTS_0 = add([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], "VEC4", 5126, 4);
    gltf.nodes[0].skin = 0;
    gltf.nodes[0].translation = [10, 0, 0];
    gltf.nodes.push({ name: "joint", translation: [2, 0, 0] });
    gltf.scenes[0].nodes.push(1);
    gltf.skins = [{ joints: [1] }];
  }
  return { gltf, binary };
}

export function pack({ gltf, binary }) {
  const text = Buffer.from(JSON.stringify(gltf));
  const json = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32);
  text.copy(json);
  const bin = Buffer.alloc(Math.ceil(binary.length / 4) * 4);
  binary.copy(bin);
  const result = Buffer.alloc(28 + json.length + bin.length);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(json.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  json.copy(result, 20);
  result.writeUInt32LE(bin.length, 20 + json.length);
  result.writeUInt32LE(0x004e4942, 24 + json.length);
  bin.copy(result, 28 + json.length);
  return result;
}

export function writeAttribute(f, semantic, values) {
  const accessor = f.gltf.accessors[f.gltf.meshes[0].primitives[0].attributes[semantic]];
  const view = f.gltf.bufferViews[accessor.bufferView];
  values.forEach((value, i) => f.binary.writeFloatLE(value, view.byteOffset + i * 4));
}

export async function loadFixture(f, options = {}) {
  const p = new Sketch();
  const errors = [];
  const Model = loadLibrary(p, {
    fetch: async () => response(pack(f)),
    console: { error: (...args) => errors.push(args) },
  });
  const model = await Model.load("fixture.glb", options);
  return { model, p, errors };
}
