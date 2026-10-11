import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as THREE from 'three';

const source = (await readFile(new URL('../sketch.js', import.meta.url), 'utf8'))
  .replace("import * as THREE from 'three';", '')
  .replace("import { OrbitControls } from 'three/addons/controls/OrbitControls.js';", '')
  .replace("import { TripoThree } from './TripoThree.js';", '');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function demo() {
  const nodes = new Map();
  const errors = [];
  const tracks = [];
  const inferences = [];
  let avatar;
  let factoryCalls = 0;
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: id === 'model' ? 'moon' : '',
      textContent: '', disabled: false,
      handlers: {},
      addEventListener(event, handler) { this.handlers[event] = handler; },
    });
    return nodes.get(id);
  };
  const detector = {
    ready: Promise.resolve(),
    getSkeleton: () => [[0, 1]],
    detect(video) {
      const pending = deferred();
      inferences.push({ ...pending, video });
      return pending.promise;
    },
  };
  const navigator = {
    mediaDevices: {
      async getUserMedia() {
        const track = { readyState: 'live', stop() { this.readyState = 'ended'; } };
        tracks.push(track);
        return { getTracks: () => [track] };
      },
    },
  };
  const document = {
    getElementById: node,
    createElement: () => ({ play: async () => {}, remove() { this.removed = true; } }),
    body: { appendChild() {} },
  };
  const window = { devicePixelRatio: 1, setTimeout, addEventListener() {} };
  class Avatar {
    constructor() { avatar = this; this.poses = []; this.object = new THREE.Group(); }
    async load() { return true; }
    setOptions() {}
    setSkeleton() {}
    clearPose() { this.poses.length = 0; }
    updatePose(pose) { this.poses.push(pose); }
    update() {}
    dispose() {}
  }
  class Renderer {
    domElement = {};
    setPixelRatio() {}
    setSize() {}
    setAnimationLoop() {}
    dispose() {}
  }
  runInNewContext(source, {
    document, navigator, window, TripoThree: Avatar,
    THREE: { ...THREE, WebGLRenderer: Renderer },
    OrbitControls: class { dispose() {} },
    innerWidth: 640, innerHeight: 480, devicePixelRatio: 1,
    // Without p5, ml5's factory resolves asynchronously.
    ml5: { bodyPose: async () => { factoryCalls++; return detector; } },
    console: { error: (...args) => errors.push(args) }, setTimeout,
  });
  await new Promise((resolve) => setImmediate(resolve));
  return {
    node, detector, navigator, tracks, inferences, errors, avatar,
    factoryCalls: () => factoryCalls,
    click: () => node('camera').handlers.click(),
  };
}

test('camera stop drains in-flight inference; restart ignores old results and reuses detector', async () => {
  const d = await demo();
  await d.click();
  assert.match(d.node('status').textContent, /Tracking/);
  assert.equal(d.inferences.length, 1);
  const first = d.inferences[0];
  const stopping = d.click();
  assert.equal(d.node('camera').disabled, true);
  assert.equal(d.tracks[0].readyState, 'live');
  first.resolve([{ keypoints3D: [{ name: 'old_session' }] }]);
  await stopping;
  assert.equal(d.avatar.poses.length, 0);
  assert.equal(d.tracks[0].readyState, 'ended');
  assert.equal(first.video.removed, true);
  await d.click();
  assert.equal(d.factoryCalls(), 1);
  assert.equal(d.inferences.length, 2);
  d.node('model').value = 'yinan';
  await d.node('model').handlers.change();
  assert.equal(d.node('status').textContent, 'yinan ready. Tracking.');
  const second = d.inferences[1];
  const stoppedAgain = d.click();
  second.resolve([]);
  await stoppedAgain;
  assert.equal(d.tracks[1].readyState, 'ended');
  assert.equal(d.avatar.poses.length, 0);
  assert.equal(d.errors.length, 0);
});

test('camera permission and inference failures are reported and release media', async () => {
  const d = await demo();
  const capture = d.navigator.mediaDevices.getUserMedia;
  d.navigator.mediaDevices.getUserMedia = async () => { throw new Error('Permission denied'); };
  await d.click();
  assert.equal(d.node('status').textContent, 'Permission denied');
  assert.equal(d.node('camera').disabled, false);
  d.navigator.mediaDevices.getUserMedia = capture;
  await d.click();
  d.inferences[0].reject(new Error('Detector failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(d.node('status').textContent, 'Detector failed');
  assert.equal(d.node('camera').textContent, 'Start webcam + ml5');
  assert.equal(d.tracks[0].readyState, 'ended');
  assert.equal(d.inferences[0].video.removed, true);
  assert.equal(d.errors.length, 2);
});
