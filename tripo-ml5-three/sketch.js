import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TripoThree } from './TripoThree.js';

const status = document.getElementById('status');
const cameraButton = document.getElementById('camera');
let avatar;
let detector;
let detectorReady = false;
let stream;
let video;
let closed = false;
let selectionId = 0;
let cameraId = 0;
let detection = null;

function report(error) {
  console.error('[TripoThree demo]', error);
  status.textContent = error.message ?? String(error);
}

async function selectModel() {
  const id = ++selectionId;
  const name = document.getElementById('model').value;
  status.textContent = `Loading ${name}...`;
  try {
    const loaded = await avatar.load(`./assets/${name}.glb`);
    if (loaded && id === selectionId) {
      status.textContent = stream && detectorReady
        ? `${name} ready. Tracking.`
        : `${name} ready. Start webcam to drive the mesh.`;
    }
  } catch (error) {
    if (id === selectionId && !closed) report(error);
  }
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x181818);
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 1, 10000);
camera.position.set(0, 0, 700);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
keyLight.position.set(-1, 2, 3);
scene.add(keyLight);
const floor = new THREE.GridHelper(1000, 20, 0x444444, 0x222222);
floor.position.y = -250;
scene.add(floor);
const cube = new THREE.Mesh(
  new THREE.BoxGeometry(40, 40, 40), new THREE.MeshStandardMaterial({ color: 0x35ffad }),
);
cube.position.set(180, -130, 0);
scene.add(cube);
avatar = new TripoThree();
scene.add(avatar.object);
selectModel();
document.getElementById('model').addEventListener('change', selectModel);
for (const [id, option] of [
  ['visible', 'visible'], ['skeleton', 'showSkeleton'],
  ['mirror', 'mirror'], ['model-mirror', 'modelMirror'],
]) {
  document.getElementById(id).addEventListener('change', (event) => {
    avatar.setOptions({ [option]: event.target.checked });
  });
}
document.getElementById('trace').addEventListener('change', (event) => {
  avatar.setOptions({ traceLandmark: event.target.value || null });
});
renderer.setAnimationLoop((time) => {
  avatar.update();
  cube.rotation.y = time * 0.0006;
  controls.update();
  renderer.render(scene, camera);
});
window.addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function releaseCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video?.remove();
  video = null;
  avatar.clearPose();
  cameraButton.textContent = 'Start webcam + ml5';
}

async function stopCamera() {
  cameraId++;
  await detection;
  detection = null;
  releaseCamera();
}

async function detectPoses(source, id) {
  try {
    while (!closed && id === cameraId) {
      const results = await detector.detect(source);
      if (closed || id !== cameraId) return;
      avatar.updatePose(results[0] ?? null);
      await new Promise((resolve) => window.setTimeout(resolve, 16));
    }
  } catch (error) {
    if (!closed && id === cameraId) {
      cameraId++;
      releaseCamera();
      report(error);
    } else console.error('[TripoThree demo] In-flight detection failed during shutdown:', error);
  }
}

cameraButton.addEventListener('click', async () => {
  cameraButton.disabled = true;
  try {
    if (stream) {
      await stopCamera();
      status.textContent = 'Webcam stopped. Mesh returning to bind pose.';
      return;
    }
    status.textContent = 'Requesting webcam...';
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480 }, audio: false,
    });
    if (closed) {
      await stopCamera();
      return;
    }
    video = document.createElement('video');
    video.id = 'preview';
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    document.body.appendChild(video);
    await video.play();
    status.textContent = 'Loading ml5 BlazePose...';
    detector ??= await ml5.bodyPose('BlazePose', {
      runtime: 'mediapipe', modelType: 'full', enableSmoothing: true,
    });
    await detector.ready;
    detectorReady = true;
    if (closed) {
      await stopCamera();
      return;
    }
    avatar.setSkeleton(detector.getSkeleton());
    const id = ++cameraId;
    cameraButton.textContent = 'Stop webcam';
    status.textContent = 'Tracking. No detected person resets the rig toward its bind pose.';
    detection = detectPoses(video, id);
  } catch (error) {
    await stopCamera();
    if (!detectorReady) detector = null;
    if (!closed) report(error);
  } finally {
    cameraButton.disabled = false;
  }
});

window.addEventListener('pagehide', () => {
  closed = true;
  stopCamera().catch(report);
  renderer.setAnimationLoop(null);
  avatar.dispose();
  controls.dispose();
  floor.geometry.dispose();
  floor.material.dispose();
  cube.geometry.dispose();
  cube.material.dispose();
  renderer.dispose();
});
