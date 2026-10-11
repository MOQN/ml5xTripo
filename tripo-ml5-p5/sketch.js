let bodyPose;
let poses = [];

let model;

async function setup() {
  createCanvas(800, 500, WEBGL);

  let video = createCapture(VIDEO);
  video.size(640, 480);
  video.hide();

  bodyPose = await ml5.bodyPose("BlazePose");
  await bodyPose.ready;

  model = await TripoRiggedModel.load("assets/moon.glb");

  bodyPose.detectStart(video, gotPoses);
}

function draw() {
  background(0);

  model.update(poses);
  model.scale(0.5);
  model.draw();
}

function gotPoses(results) {
  poses = results;
}
