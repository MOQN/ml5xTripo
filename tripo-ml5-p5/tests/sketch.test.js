import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../sketch.js", import.meta.url), "utf8");

function sketchDemo() {
  const calls = [];
  let callback;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const track = { stopped: false, stop() { this.stopped = true; } };
  const video = {
    elt: { srcObject: { getTracks: () => [track] } },
    size: (...args) => calls.push(["size", ...args]),
    hide: () => calls.push(["hide"]),
    remove: () => calls.push(["removeVideo"]),
  };
  const bodyPose = {
    ready,
    detectStart(source, handler) {
      assert.equal(source, video);
      callback = handler;
      calls.push(["detectStart"]);
    },
    detectStop: () => calls.push(["detectStop"]),
  };
  const context = {
    WEBGL: "webgl", VIDEO: "video",
    createCanvas: (...args) => calls.push(["canvas", ...args]),
    createCapture: (type) => { calls.push(["capture", type]); return video; },
    background: (value) => calls.push(["background", value]),
    frameRate: () => 60,
    console: { log() {} },
    ml5: { bodyPose: (name) => { calls.push(["bodyPose", name]); return bodyPose; } },
    TripoRiggedModel: class {
      static async load(...args) {
        calls.push(["model", ...args]);
        return new this();
      }
      update(poses) { calls.push(["update", poses]); }
      draw() { calls.push(["draw"]); }
      dispose() { calls.push(["dispose"]); }
    },
  };
  runInNewContext(source, context);
  return { context, calls, resolveReady, rejectReady, track, results: (poses) => callback(poses) };
}

test("HTML keeps pinned versions and loads a normal class script before the sketch", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /p5@2\.3\.4/);
  assert.match(html, /ml5@1\.3\.1/);
  assert.match(html, /src="TripoRiggedModel\.js"/);
  assert.match(html, /href="style\.css"/);
  assert.ok(html.indexOf("TripoRiggedModel.js") < html.indexOf("sketch.js"));
  assert.doesNotMatch(html + source, /type="module"|initializeTripoP5|window\.TripoP5|^\s*(import|export)\s/m);
  assert.doesNotMatch(source, /\btry\b|\bcatch\b|pagehide|addEventListener/);
});

test("sketch owns WEBGL, webcam and ml5 and awaits detector readiness before detectStart", async () => {
  const d = sketchDemo();
  const setup = d.context.setup();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(d.calls, [
    ["canvas", 800, 500, "webgl"], ["capture", "video"],
    ["size", 640, 480], ["hide"], ["bodyPose", "BlazePose"],
  ]);
  d.resolveReady();
  await setup;
  assert.deepEqual(d.calls.slice(-2), [["model", "assets/moon.glb"], ["detectStart"]]);
  const results = [{ keypoints3D: [] }];
  d.results(results);
  d.context.draw();
  assert.deepEqual(d.calls.slice(-3), [["background", 0], ["update", results], ["draw"]]);
  d.results([]);
  d.context.draw();
  assert.deepEqual(d.calls.at(-2), ["update", []]);
});

test("detector initialization failure rejects setup before model loading or tracking", async () => {
  const d = sketchDemo();
  const setup = d.context.setup();
  await new Promise((resolve) => setImmediate(resolve));
  d.rejectReady(new Error("Detector download failed"));
  await assert.rejects(setup, /Detector download failed/);
  assert.equal(d.calls.some(([name]) => name === "model"), false);
  assert.equal(d.calls.some(([name]) => name === "detectStart"), false);
});

test("model loading failure rejects setup before tracking starts", async () => {
  const d = sketchDemo();
  d.context.TripoRiggedModel.load = async () => { throw new Error("Model load failed"); };
  const setup = d.context.setup();
  d.resolveReady();
  await assert.rejects(setup, /Model load failed/);
  assert.equal(d.calls.some(([name]) => name === "detectStart"), false);
});
