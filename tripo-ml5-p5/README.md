# Tripo + ml5 + p5

A standalone prototype extracted from the existing 3D pose view. No Express,
ComfyUI, WebSocket, LLM, sound, or files served from `public/` are required.
Moon and Yinan are local copies in `assets/`.

## Run

```sh
cd tripo-ml5-p5
npx --yes http-server@14.1.1 -p 8081
```

No `npm install` is required. Use `npm start` (a pinned `npx` static server),
or serve this folder with any static server such as VS Code Live Server.
Open <http://localhost:8081> when using `npm start`. A static HTTP server is required for
GLB loading and the small ES module bridge that loads the p5 helper; this is not
an integration with the parent application's server. Webcam access requires
localhost or HTTPS. p5 1.11.11 and ml5 1.3.1 are CDN dependencies; ml5 also
downloads its detector assets. The sketch itself uses p5's standard global
`setup()`, `draw()` and `windowResized()` callbacks.
The mesh loads without starting or granting access to the webcam.
The demo serializes public `bodyPose.detect()` calls. Stopping waits for
the current inference to finish, ignores its result, then releases the
video; restarting cannot apply a result from the previous camera session.
Inference failures are reported in the status panel and release the camera.

## One object in your sketch

```js
let avatar;

function setup() {
  createCanvas(800, 600, WEBGL);
  avatar = new window.TripoP5(p5.instance, { showSkeleton: true });
  avatar.load('./assets/moon.glb').catch(console.error);
  // With an existing ml5 BlazePose detector:
  // avatar.setSkeleton(bodyPose.getSkeleton());
  // bodyPose.detectStart(video, (poses) => avatar.updatePose(poses[0] ?? null));
}

function draw() {
  background(24);
  orbitControl();
  ambientLight(160);
  avatar?.draw();
}
```

`tripo-loader.js` imports the helper and exposes it as `window.TripoP5`; the
sketch remains an ordinary global-mode p5 script. Pass the p5 instance from
`p5.instance`. The object owns no canvas, camera, render loop, webcam or pose
detector. You control p5 transforms, lights and drawing order.

### API

- `await avatar.load(url)` loads a GLB 2.0 binary. Returns `true` when installed,
  or `false` when superseded/disposed during loading. Failures reject.
  The previous mesh remains available until its replacement is ready.
- `avatar.updatePose(pose)` takes **one** ml5 BlazePose result, not the
  results array. Inputs are copied, never mutated. Pass `null` or call
  `clearPose()` when tracking is lost.
- `avatar.setSkeleton(bodyPose.getSkeleton())` sets landmark index pairs.
- `avatar.setOptions({...})` changes any of the options below.
- `avatar.draw()` advances smoothing and draws native p5 geometry, optional
  skeleton and trace. Call once per p5 frame.
- `avatar.dispose()` releases the p5 mesh buffers and invalidates pending loads.

| Option | Default | Meaning |
| --- | --- | --- |
| `modelScale` | `250` | GLB world units to p5 units |
| `poseScale` | `250` | BlazePose meters to debug skeleton/trace units |
| `smoothing` | `0.25` | Quaternion interpolation per draw; 1 is immediate |
| `minConfidence` | `0.3` | Landmark threshold |
| `mirror` | `false` | Reflect input X without modifying ml5 data |
| `modelMirror` | `false` | Swap left/right landmark-to-bone assignments |
| `visible` | `true` | Mesh visibility; no reload when toggled |
| `showSkeleton` | `false` | Draw confidence-filtered joints and connections |
| `jointSize` | `6` | Debug joint box size |
| `traceLandmark` | `null` | Landmark name, e.g. `left_wrist`; null disables |
| `traceLength` | `80` | Maximum trail points; 0 disables |
| `traceRotation` | `0.01` | Trail rotation around Y per frame, in radians |

### Rendering and compatibility

The GLB 2.0 container, accessors, node transforms, embedded base-color images
and skinning are parsed directly in `TripoP5.js`; no external 3D renderer or
model loader is used. Deformed vertices become `p5.Geometry` and are drawn with
`p.model()`, sharing depth, transforms and lights with p5 shapes.
Coordinates are hip-centered; Y is converted to p5's downward-positive axis.
The authored Moon/Yinan bind transforms are retained at load time; runtime
rotation targets are normalized for reliable quaternion interpolation. Spine and eight limb
bones follow BlazePose; hands/fingers inherit rotations, not articulation.
Missing/low-confidence landmarks blend affected bones back to bind pose.
Embedded GLB animations are not played.

This first version targets **p5 1.11.x** and Mixamo-named rigs. Static meshes
can also be drawn, but custom bone naming needs a future mapping API.
It renders base color, opacity and base-color texture through p5 lighting,
not GLTF's full PBR pipeline (normal/metallic/roughness maps, material
extensions, morph targets, texture wrapping outside 0..1 are not supported).
Normals are recomputed from deformed geometry. The trace is a line, not the original shader ribbon. Bone skinning is computed
on the CPU each draw. Vertex/normal buffers are updated using p5 1.11's internal
`p5.Geometry.dirtyFlags` mechanism, avoiding buffer deletion/recreation
on every frame; `freeGeometry()` is used for model disposal. This is a
version-specific integration, not a stable cross-version p5 API. CPU
skinning/upload costs still depend on model complexity. This is not GPU
skinning; profile your target hardware.

The Node test files use ES modules; run them in a Node ES module project
context. They cover native GLB parsing, skinned vertex deformation, confidence,
mirroring, model loading, cleanup, p5 geometry, camera permission/inference
failures, and in-flight stop/restart ordering. Automated tests do not certify
camera accuracy, asset skin weights, or full GLTF material fidelity.
