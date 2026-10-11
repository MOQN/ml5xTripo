import test from "node:test";
import assert from "node:assert/strict";
import { fixture, pack } from "./glb-fixture.js";
import { glb, loadLibrary, response, Sketch } from "./library-helper.js";

function demo() {
  const listeners = new Map();
  const document = {
    baseURI: "http://localhost/",
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
  };
  const p = new Sketch();
  p.canvas.ownerDocument = document;
  const errors = [];
  const warnings = [];
  const Model = loadLibrary(p, {
    fetch: async () => response(pack(fixture())),
    console: {
      error: (...args) => errors.push(args),
      warn: (...args) => warnings.push(args),
    },
  });
  async function dispatch(type, files = [], types = ["Files"]) {
    const event = {
      dataTransfer: { files, types },
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    await Promise.all(Array.from(listeners.get(type) ?? [], (handler) => handler(event)));
    return event;
  }
  return { p, Model, errors, warnings, listeners, dispatch };
}

const localFile = (name = "model.glb") => new File([pack(fixture())], name);

test("draw and position share persistent setters; transforms wrap auto-fit in the right order", async () => {
  const { p, Model } = demo();
  const model = await Model.load("model.glb");
  const calls = [];
  for (const name of ["push", "pop", "translate", "rotateX", "rotateY", "rotateZ", "scale", "model"]) {
    const original = p[name].bind(p);
    p[name] = (...args) => { calls.push([name, ...args]); return original(...args); };
  }
  assert.equal(model.position(10, 20).scale(2).rotate(0.1, 0.2, 0.3), model);
  model.scale(2).rotateY(0.5).rotateY(0.5).rotateX(0.4).rotateZ(0.6);
  const part = model.parts[0];
  part.geometry.dirtyFlags = {};
  model.draw(30, 40);
  assert.deepEqual(calls.slice(0, 6), [
    ["push"], ["translate", 30, 40, 0], ["rotateX", 0.4],
    ["rotateY", 0.5], ["rotateZ", 0.6], ["scale", 2],
  ]);
  assert.equal(calls[6][0], "scale");
  assert.equal(calls[7][0], "translate");
  assert.deepEqual(part.geometry.dirtyFlags, {});
  calls.length = 0;
  model.draw();
  assert.deepEqual(calls[1], ["translate", 30, 40, 0]);
  await model.load(localFile());
  calls.length = 0;
  model.draw();
  assert.deepEqual(calls[1], ["translate", 30, 40, 0]);
  assert.deepEqual(calls[5], ["scale", 2]);
  const second = new Model();
  calls.length = 0;
  second.draw();
  assert.deepEqual(calls.slice(1, 6), [
    ["translate", 0, 0, 0], ["rotateX", 0], ["rotateY", 0], ["rotateZ", 0], ["scale", 1],
  ]);
  second.dispose();
  model.dispose();
});

test("invalid transforms preserve settings and rotate warns unless given exactly three arguments", () => {
  const { p, Model, warnings } = demo();
  const model = new Model();
  model.position(12, 34).scale(2).rotate(1, 2, 3);
  for (const args of [[], [1], [1, 2], [1, 2, 3, 4]]) {
    assert.equal(model.rotate(...args), model);
  }
  assert.equal(warnings.length, 4);
  assert.ok(warnings.every((args) => args[0].includes("all 3 arguments")));
  assert.throws(() => model.rotate(1, 2, NaN), /finite/);
  for (const method of ["rotateX", "rotateY", "rotateZ", "scale"]) {
    assert.throws(() => model[method](), /finite/);
    assert.throws(() => model[method](Infinity), /finite/);
  }
  assert.throws(() => model.position(1), /2 finite/);
  assert.throws(() => model.position("1", 2), /2 finite/);
  assert.throws(() => model.draw(1), /2 finite/);
  assert.throws(() => model.draw(1, 2, 3), /2 finite/);
  assert.equal(p.depth, 0);
  model.draw();
  assert.deepEqual(p.translations[0], [12, 34, 0]);
  assert.deepEqual(p.rotations, [["x", 1], ["y", 2], ["z", 3]]);
  assert.deepEqual(p.scales, [2]);
  model.dispose();
  for (const method of ["position", "scale", "rotateX", "rotateY", "rotateZ", "rotate"]) {
    assert.throws(() => model[method](1, 2, 3), /disposed/);
  }
});

test("page file drops replace only the newest instance and dispose restores the previous target", async () => {
  const { p, Model, dispatch, listeners } = demo();
  const first = await Model.load("first.glb");
  const second = await Model.load("second.glb");
  const firstScene = first.scene;
  const secondScene = second.scene;
  const drag = await dispatch("dragover");
  assert.equal(drag.defaultPrevented, true);
  assert.equal(drag.dataTransfer.dropEffect, "copy");
  assert.equal((await dispatch("drop", [localFile("new.GLB")])).defaultPrevented, true);
  assert.equal(first.scene, firstScene);
  assert.notEqual(second.scene, secondScene);
  assert.equal(p.freed.length, secondScene.parts.length);
  second.dispose();
  await dispatch("drop", [localFile()]);
  assert.notEqual(first.scene, firstScene);
  first.dispose();
  assert.equal(listeners.get("drop").size, 0);
  assert.equal(listeners.get("dragover").size, 0);
  assert.equal((await dispatch("dragover")).defaultPrevented, false);
});

test("invalid drops report errors, preserve the mesh, and leave text drags alone", async () => {
  const { Model, errors, dispatch } = demo();
  const model = await Model.load("model.glb");
  const scene = model.scene;
  assert.equal((await dispatch("dragover", [], ["text/plain"])).defaultPrevented, false);
  assert.equal((await dispatch("drop", [], ["text/plain"])).defaultPrevented, false);
  for (const files of [
    [], [localFile(), localFile()], [localFile("model.txt")],
    [new File(["invalid"], "bad.glb")],
  ]) {
    assert.equal((await dispatch("drop", files)).defaultPrevented, true);
    assert.equal(model.scene, scene);
    assert.ok(model.error);
  }
  assert.equal(errors.length, 4);
  await dispatch("drop", [localFile()]);
  assert.equal(model.error, null);
  assert.notEqual(model.scene, scene);
  model.dispose();
});

test("overlapping drops and disposal cancel stale local file loads", async () => {
  const { Model, dispatch } = demo();
  const model = await Model.load("model.glb");
  let finish;
  const slow = localFile();
  slow.arrayBuffer = () => new Promise((resolve) => { finish = resolve; });
  const pending = dispatch("drop", [slow]);
  await dispatch("drop", [localFile()]);
  const scene = model.scene;
  finish(await localFile().arrayBuffer());
  await pending;
  assert.equal(model.scene, scene);
  assert.equal(model.error, null);
  const cancelled = dispatch("drop", [slow]);
  model.dispose();
  finish(await localFile().arrayBuffer());
  await cancelled;
  assert.equal(model.scene, null);
});

test("failed static loads remove drop handlers and do not steal the previous target", async () => {
  const { Model, dispatch, listeners } = demo();
  const model = new Model();
  await assert.rejects(Model.load(new File(["bad"], "bad.glb")), /Invalid GLB/);
  assert.equal(listeners.get("drop").size, 1);
  await dispatch("drop", [localFile()]);
  assert.ok(model.scene);
  model.dispose();
});

test("local files load embedded textures without fetching the GLB and release image blob URLs", async () => {
  const p = new Sketch();
  const Model = loadLibrary(p, {
    fetch: () => { throw new Error("Local files must not be fetched."); },
  });
  const model = await Model.load(new File([await glb()], "moon.glb"));
  const textured = model.parts.filter((part) => part.texture);
  assert.ok(textured.length > 0);
  for (const part of textured) {
    assert.match(part.texture.source, /^blob:/);
    await assert.rejects(fetch(part.texture.source));
  }
  model.dispose();
});

test("local files reject external textures rather than resolving them against the page", async () => {
  const { Model } = demo();
  const f = fixture();
  f.gltf.bufferViews.push({ buffer: 0, byteOffset: 128, byteLength: 24 });
  f.gltf.accessors.push({ bufferView: f.gltf.bufferViews.length - 1, componentType: 5126, type: "VEC2", count: 3 });
  f.gltf.meshes[0].primitives[0].attributes.TEXCOORD_0 = f.gltf.accessors.length - 1;
  f.gltf.meshes[0].primitives[0].material = 0;
  f.gltf.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
  f.gltf.textures = [{ source: 0 }];
  f.gltf.images = [{ uri: "texture.png" }];
  await assert.rejects(Model.load(new File([pack(f)], "external.glb")), /must embed their textures/);
});
