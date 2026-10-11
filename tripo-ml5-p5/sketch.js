let avatar;
let detector;
let detectorReady = false;
let stream;
let video;
let closed = false;
let selectionId = 0;
let cameraId = 0;
let detection = null;
let controlsInitialized = false;

const status = document.getElementById('status');
const cameraButton = document.getElementById('camera');

function report(error) {
  console.error('[TripoP5 demo]', error);
  status.textContent = error.message ?? String(error);
}

async function selectModel() {
  if (!avatar) return;
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

function initializeControls() {
  if (controlsInitialized) return;
  controlsInitialized = true;
  document.getElementById('model').addEventListener('change', selectModel);
  for (const [id, option] of [
    ['visible', 'visible'], ['skeleton', 'showSkeleton'],
    ['mirror', 'mirror'], ['model-mirror', 'modelMirror'],
  ]) {
    document.getElementById(id).addEventListener('change', (event) => {
      avatar?.setOptions({ [option]: event.target.checked });
    });
  }
  document.getElementById('trace').addEventListener('change', (event) => {
    avatar?.setOptions({ traceLandmark: event.target.value || null });
  });
}

function initializeAvatar() {
  if (avatar || !p5.instance || !window.TripoP5) return;
  avatar = new window.TripoP5(p5.instance);
  selectModel();
}

window.initializeTripoP5 = initializeAvatar;

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
  pixelDensity(Math.min(window.devicePixelRatio, 2));
  perspective(Math.PI / 3, width / height, 1, 10000);
  camera(0, 0, 700, 0, 0, 0, 0, 1, 0);
  initializeControls();
  initializeAvatar();
}

function draw() {
  background(24);
  if (!document.getElementById('controls').matches(':hover')) orbitControl();
  ambientLight(160);
  directionalLight(255, 255, 255, -0.5, 1, -1);
  avatar?.draw();
  push();
  translate(180, 130, 0);
  rotateY(frameCount * 0.01);
  noStroke();
  fill(53, 255, 173);
  box(40);
  pop();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  perspective(Math.PI / 3, width / height, 1, 10000);
}

function releaseCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video?.remove();
  video = null;
  avatar?.clearPose();
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
    } else console.error('[TripoP5 demo] In-flight detection failed during shutdown:', error);
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
    detector ??= ml5.bodyPose('BlazePose', {
      runtime: 'mediapipe', modelType: 'full', enableSmoothing: true,
    });
    await detector.ready;
    detectorReady = true;
    if (closed) {
      await stopCamera();
      return;
    }
    avatar?.setSkeleton(detector.getSkeleton());
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
  avatar?.dispose();
});
