let bodyPose;
let poses = [];

let tripoModel;

async function setup() {
  createCanvas(800, 500, WEBGL);

  let video = createCapture(VIDEO);
  video.size(640, 480);
  video.hide();

  bodyPose = await ml5.bodyPose("BlazePose");
  await bodyPose.ready;

  tripoModel = new TripoRiggedModel();

  bodyPose.detectStart(video, gotPoses);
}

function draw() {
  background(0);

  tripoModel.update(poses);
  tripoModel.scale(0.5);
  tripoModel.draw();
}

function gotPoses(results) {
  poses = results;
}
