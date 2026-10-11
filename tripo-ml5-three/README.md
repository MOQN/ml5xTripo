# Tripo + ml5 + Three.js

Independent CDN-only example. No p5, local node_modules, parent application,
Express, ComfyUI, WebSocket or LLM integration. Moon/Yinan GLBs live in this
folder's `assets/`; all third-party browser JavaScript comes from pinned CDNs.

## Run

Serve this folder using VS Code Live Server or any static HTTP server.
Alternatively, `npm start` launches a pinned `npx` static server on
<http://localhost:8082>. No `npm install` is required. CDN/model downloads
require internet; webcam access requires localhost or HTTPS.

`index.html` pins Three.js/addons to 0.168.0 and ml5 to 1.3.1.
The mesh loads before requesting webcam access.

## One object in your scene

```js
import { TripoThree } from './TripoThree.js';

const avatar = new TripoThree({ showSkeleton: true });
scene.add(avatar.object);
await avatar.load('./assets/moon.glb');

// With a ready ml5 BlazePose detector:
avatar.setSkeleton(bodyPose.getSkeleton());
// For one detected pose (not the results array):
avatar.updatePose(poses[0] ?? null);

renderer.setAnimationLoop(() => {
  avatar.update();
  renderer.render(scene, camera);
});
```

Configure the same `three` / `three/addons/` import map as `index.html`.
The object creates no renderer, camera, canvas, lights, webcam or detector.
The demo owns these separately. Add multiple avatars to the same scene;
each instance owns its model/pose/debug resources.

### API

- `avatar.object`: a native `THREE.Group`. Set its position, rotation and
  uniform scale, or add it to another transformed group. Pose directions
  remain avatar-local and follow the group transform. Nonuniform scaling
  of the avatar or its ancestors is not supported for pose retargeting.
- `await avatar.load(url)`: replaces the model only after successful loading.
  Errors reject and preserve the current model. Returns `false` for a
  superseded/disposed successful load, `true` for an installed model.
- `avatar.updatePose(pose)`: copies one ml5 BlazePose `keypoints3D` result.
  `null` / `avatar.clearPose()` clears tracking, then `update()` blends
  affected bones back toward their bind rotations.
- `avatar.setSkeleton(bodyPose.getSkeleton())`: sets debug connections.
- `avatar.setOptions({...})`: changes the options below.
- `avatar.update()`: advances bone smoothing, joints, lines and trace.
  Call once per rendered frame.
- `avatar.dispose()`: detaches the group, disposes geometry, materials,
  textures and skeletons, and invalidates pending loads.

| Option | Default | Meaning |
| --- | --- | --- |
| `modelScale` | `250` | GLB units to scene units |
| `poseScale` | `250` | BlazePose meters to debug units |
| `smoothing` | `0.25` | Quaternion interpolation per update; 1 is immediate |
| `minConfidence` | `0.3` | Landmark threshold |
| `mirror` | `false` | Reflect input X |
| `modelMirror` | `false` | Swap left/right bone landmark assignments |
| `visible` | `true` | Show/hide mesh without reloading |
| `showSkeleton` | `false` | Show joints/connections |
| `jointSize` | `6` | Debug joint box size |
| `traceLandmark` | `null` | Landmark name, e.g. `left_wrist` |
| `traceLength` | `80` | Maximum trace points; 0 disables |
| `traceRotation` | `0.01` | Trace Y rotation per update, radians |

Uses native GPU skinning and authored GLTF materials, unlike the p5
version's CPU-deformed geometry. Authored bone transforms are retained at
load time, with normalized runtime rotation targets. Spine and eight limb
bones follow BlazePose. Hands/fingers inherit bone transforms; finger/head
tracking and playback of embedded animations are not implemented.
Static GLBs can render, but retargeting expects Mixamo bone names.
Coordinates are hip-centered, Y-up, and negative input Z becomes positive
scene Z, matching the original 3D pose view. The trace is a simple line.

The demo uses serialized public `bodyPose.detect()` calls, waits for
in-flight inference before releasing video, and reports camera/inference
errors. It reuses the detector on restart and ignores stopped-session results.

## Tests

`npm test` uses Node 22+ and the test-only CDN module loader, requiring
internet but no installed dependencies. Tests cover model replacement
races, real GLB bind transforms and bone directions, transformed parents,
debug geometry, confidence, tracing and resource disposal.
They do not certify real-person camera accuracy or asset skin-weight quality.
