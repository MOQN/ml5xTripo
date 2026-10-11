# Tripo + ml5 + p5

웹캠 포즈로 GLB 모델을 움직이는 학생용 예제입니다.
p5 **2.3.4**, ml5 **1.3.1**을 사용합니다.

## 실행

이 폴더를 VS Code Live Server 등 정적 HTTP 서버로 열어 주세요.
GLB 로딩에는 HTTP가 필요하고, 웹캠에는 `localhost` 또는 HTTPS가 필요합니다.
페이지를 열면 웹캠 권한을 요청합니다. ml5는 검출 모델을 추가로 다운로드합니다.

## 스케치의 흐름

```js
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
  model.draw();
}

function gotPoses(results) {
  poses = results;
}
```

`ml5.bodyPose()`는 ml5 1.3.1에서 검출기 객체를 바로 반환합니다.
`await bodyPose.ready`가 실제 모델 다운로드와 초기화를 기다리는 줄입니다.
준비가 끝난 다음 `detectStart()`를 호출합니다.

- **스케치**: WEBGL 캔버스와 웹캠을 만들고, ml5를 시작하고, 결과를 받습니다.
- **TripoRiggedModel**: GLB를 불러오고, 받은 포즈를 뼈에 적용하고, 모델을 그립니다.

라이브러리는 웹캠이나 ml5를 시작하지 않습니다. 별도 캔버스도 만들지 않습니다.
모든 모델은 스케치의 WEBGL 캔버스에 직접 그려집니다.
학생용 스케치에는 `try/catch`나 페이지 종료 이벤트를 넣지 않습니다.
초기화 실패는 그대로 전달되며 모델 로딩 오류는 라이브러리에서 콘솔에 보고합니다.
페이지를 닫거나 새로고침하면 브라우저가 해당 페이지의 자원을 정리합니다.
페이지를 열어 둔 채 기능만 중지하는 앱에서는 `bodyPose.detectStop()`,
웹캠 트랙의 `stop()`, `video.remove()`, `model.dispose()`를 직접 호출하세요.

다른 모델을 사용하려면 파일 경로만 바꾸세요.
`assets/moon.glb`, `assets/yinan.glb`가 포함되어 있습니다.
자신의 파일을 같은 폴더에 놓으면 `"model.glb"`처럼 쓸 수 있습니다.
또는 웹페이지 어디에나 `.glb` 파일 하나를 드래그 앤 드롭하세요.
클래스가 파일을 직접 읽어 현재 메시를 교체합니다. 서버에 업로드하지 않으며,
스케치에 이벤트 코드를 추가할 필요가 없습니다. 텍스처는 GLB 안에 포함되어야 합니다.
여러 객체가 있으면 가장 최근에 만든 객체 하나만 교체합니다.
그 객체를 `dispose()`하면 이전 객체가 드롭 대상이 됩니다.
교체 중에는 기존 모델이 계속 표시되고, 실패하면 기존 모델을 유지하며 콘솔과
`model.error`로 오류를 알립니다. 연속으로 드롭하면 마지막 로딩 요청이 우선합니다.

## 파일 구조

- `index.html`: p5, p5.sound, ml5, 라이브러리, 스케치를 순서대로 불러옵니다.
- `sketch.js`: 학생이 수정하는 캔버스·웹캠·ml5·그리기 코드입니다.
- `TripoRiggedModel.js`: 하나의 `class TripoRiggedModel`입니다.
- `style.css`: 기본 페이지 스타일입니다.
- `assets/`: GLB 모델 파일입니다.
- `tests/`: 라이브러리와 스케치의 자동 테스트입니다.

일반 `<script>`로 로드하므로 import나 초기화 브리지는 필요하지 않습니다.
클래스 위쪽에는 공개 API가, 아래쪽에는 `#`로 시작하는 내부 메서드와 설정이
있습니다. 내부 메서드는 포즈·스키닝, GLB 파싱, 수학 계산 순서로 묶었습니다.

## 객체 API

| 사용법 | 설명 |
| --- | --- |
| `new TripoRiggedModel(options)` | 기존 p5 글로벌 WEBGL 캔버스에서 사용할 빈 객체를 초기화합니다. 파일을 불러오지 않습니다. 옵션은 생략 가능합니다. |
| `await TripoRiggedModel.load(path, options)` | 객체를 생성하고 파일·텍스처를 로딩한 뒤 준비된 객체를 반환합니다. 학생용 간편 API입니다. |
| `model.update(poses, elapsedMs)` | ml5 결과 **배열**의 첫 사람을 적용하고 스키닝·보간·궤적을 갱신합니다. 시간은 생략하면 p5 `deltaTime`(밀리초)을 사용합니다. 매 프레임 호출하세요. |
| `model.draw()` | 갱신된 모델을 그립니다. 보간을 다시 진행하지 않습니다. |
| `model.draw(x, y)` | 위치를 저장하고 그립니다. 이후 `draw()`도 같은 위치에 그립니다. |
| `model.position(x, y)` | 모델 중심의 X·Y 위치를 설정합니다. 기본값은 `(0, 0)`입니다. |
| `model.scale(value)` | 자동 맞춤 크기에 곱할 표시 배율을 설정합니다. 기본값은 `1`입니다. `0`은 크기를 없애고, 음수는 반전합니다. |
| `model.rotateX(angle)`, `model.rotateY(angle)`, `model.rotateZ(angle)` | 해당 축의 회전값을 설정하고 다른 축은 유지합니다. 기본값은 `0`입니다. |
| `model.rotate(x, y, z)` | 세 축 회전값을 한 번에 설정합니다. 인수가 정확히 3개가 아니면 콘솔 안내만 표시하고 기존 회전값을 유지합니다. |
| `await model.load(pathOrFile)` | URL 또는 브라우저 `File`로 모델을 로딩하거나 교체합니다. static `load()`도 둘 다 받습니다. 성공하면 같은 객체(`this`)를 반환합니다. 실패하거나 더 최근 요청·dispose로 취소되면 reject됩니다. 기존 모델은 교체가 준비될 때까지 유지됩니다. |
| `model.setOptions(options)` | 모델·포즈 표시 옵션을 변경합니다. 변경 후 `update()`를 호출하세요. |
| `model.setSkeleton(bodyPose.getSkeleton())` | 선택적인 디버그 스켈레톤 연결 정보를 설정합니다. |
| `model.clearPose()` | 저장된 포즈와 궤적을 지웁니다. 이후 `update([])`로 기본 포즈를 적용할 수 있습니다. |
| `model.dispose()` | 모델의 GPU 버퍼와 드롭 이벤트를 해제하고 진행 중인 로딩을 무효화합니다. 스케치의 캔버스와 웹캠은 건드리지 않습니다. |
| `model.error` | 최근 모델 로딩 오류입니다. 로딩 오류는 콘솔에도 보고됩니다. 성공적인 로딩으로 초기화됩니다. |

`poses`가 빈 배열이면 영향을 받는 뼈가 기본 포즈로 부드럽게 돌아갑니다.
입력 배열과 랜드마크는 변경하지 않습니다.
모델 로딩이 끝나기 전에도 `update()`와 `draw()`를 호출할 수 있습니다.

### 위치, 크기, 회전

```js
model.position(100, 20);
model.scale(1.5);
model.rotate(0, 0.5, 0);
model.draw();

// same position, with drawing in one call
model.draw(100, 20);
```

모든 변환 메서드는 누적하지 않고 값을 설정합니다. 매 프레임 `model.scale(1.5)`를
호출해도 계속 커지지 않습니다. 회전 각도는 p5 `angleMode()`를 따르며 기본은
라디안입니다. 기본 WEBGL 좌표계에서는 캔버스 중앙이 `(0, 0)`입니다.
위치·배율·회전은 파일을 교체해도 유지되고, 메서드는 `this`를 반환해 연결할 수 있습니다.
모든 값은 유한한 숫자여야 합니다. 변환은 그리기에만 적용하므로 CPU 스키닝을
다시 계산하지 않으며, 디버그 스켈레톤과 궤적에도 같이 적용됩니다.

## 표시 옵션

```js
model = await TripoRiggedModel.load("assets/moon.glb", {
  smoothing: 0.25,
  mirror: true
});
```

생성과 로딩을 나눠 쓰고 싶다면 같은 기능을 두 단계로 사용할 수 있습니다.

```js
model = new TripoRiggedModel({ smoothing: 0.25 });
await model.load("assets/moon.glb");
```

static `load()`는 내부에서 위 두 단계를 실행합니다. 로딩 구현은 하나입니다.

| 옵션 | 기본값 | 의미 |
| --- | --- | --- |
| `modelScale` | `250` | 내부 GLB 좌표 배율 |
| `poseScale` | `250` | 디버그 포즈·궤적 좌표 배율 |
| `smoothing` | `0.25` | 60 FPS 기준 보간 비율. 실제 보간량은 경과 시간으로 보정. `0`은 회전 정지, `1`은 즉시 적용 |
| `minConfidence` | `0.3` | 포즈 신뢰도 기준 |
| `mirror` | `false` | 입력 포즈 X축 반전 |
| `modelMirror` | `false` | 좌우 뼈에 적용하는 랜드마크 교환 |
| `visible` | `true` | 모델 표시 여부 |
| `showSkeleton` | `false` | 디버그 관절·연결 표시 |
| `jointSize` | `6` | 디버그 관절 크기 |
| `traceLandmark` | `null` | 궤적 랜드마크 이름. `null`이면 비활성화 |
| `traceLength` | `80` | 최대 궤적 점 수 |
| `traceRotation` | `0.01` | 60 FPS 기준 궤적 Y축 회전(라디안). 실제 회전량은 경과 시간으로 보정 |

기존 `model.update(poses)` 사용법은 그대로입니다. 보간은
`1 - (1 - smoothing) ** (elapsedMs / (1000 / 60))`으로 계산합니다.
명시적인 시간은 0 이상의 유한한 값이어야 하며, `0`이면 회전과 궤적 진행을
멈춥니다. 긴 프레임도 실제 경과 시간만큼 진행하므로 탭을 다시 열면 목표 포즈에
빠르게 가까워질 수 있습니다. 궤적은 여전히 update당 한 점을 기록하므로
`traceLength`는 시간이 아니라 점 개수입니다.

## 렌더링 범위

최초 로딩 시 모델의 경계를 측정해 캔버스에 맞춰 가운데 정렬합니다.
`draw()`는 기본 조명을 적용하며, 모델은 다른 p5 3D 도형과 깊이 버퍼를
공유합니다. `push()`, `translate()`, `rotateY()`, `scale()`로 감싸서
배치할 수도 있습니다. 객체 메서드로는 `position()`, `rotate()`, `scale()`을 쓰세요.
자동 맞춤과 중심 정렬 바깥에 객체의 변환을 적용하므로 배율이 상쇄되지 않습니다.
클래스는 배경, 카메라, 렌더 루프를 관리하지 않고 그리기 상태를 복원합니다.

외부 3D 엔진 없이 GLB 2.0과 임베디드 기본 색상 텍스처를 파싱하고,
CPU 스키닝 결과를 `p5.Geometry`로 그립니다. Mixamo 이름의 척추·팔·다리
뼈를 BlazePose에 연결합니다. 손가락 개별 추적, GLB 애니메이션,
모프 타깃, 전체 PBR 재질은 지원하지 않습니다.

텍스처 UV는 GLB 값을 그대로 사용합니다. V축을 반전하면 이미지 아틀라스의
다른 부분이 얼굴이나 옷에 붙게 됩니다.

`update()`는 부모부터 자식 순서로 뼈를 처리하고, 변경된 뼈와 그 하위 노드만
한 번씩 갱신합니다. 메시가 참조하는 뼈의 변환 버전이나 모델 배율이 바뀔 때만
정점·법선을 다시 계산합니다. 보간이 수렴하면 버퍼 갱신도 멈춥니다.

GLB에 `NORMAL`이 있으면 원본 법선을 유지하면서 정점과 함께 변형합니다.
블렌딩된 스킨 변환의 inverse-transpose를 사용해 비균일 배율도 처리합니다.
법선이 없는 파일만 변형된 삼각형으로부터 법선을 재계산합니다.
기존의 무조건 재계산하던 방식과 음영이 다를 수 있으며, 이는 원본 모델의
부드러운 표면과 경계 정보를 보존하기 위한 의도적인 변경입니다.

스키닝은 `jointWorld * inverseBind`를 사용하고, 스킨 메시의 노드 변환을
다시 곱하지 않습니다. 일반 메시의 TRS와 TRS로 분해 가능한 행렬,
음수·비균일 배율을 지원합니다. 행렬의 음수 배율은 회전으로 잘못 흡수하지
않도록 보존합니다.

### GLB 검증과 제한

잘못된 파일은 콘솔에 오류를 보고하고 `load()`를 reject합니다.
교체 로딩이 실패해도 기존 모델은 유지합니다.

- 컨테이너·청크·버퍼 길이와 정렬, 중복 청크
- 노드 참조, 중복 부모·자식, 순환 계층, 잘못된 씬 루트
- accessor의 타입·개수·stride·버퍼 범위·유한한 값
- 삼각형 인덱스, 스킨 관절 인덱스·가중치·inverse bind 타입
- 행렬과 TRS의 동시 지정, 잘못된 쿼터니언·행렬

모든 glTF 기능을 지원하는 범용 로더는 아닙니다. 단일 임베디드 버퍼만
지원하며, 필수 확장, sparse accessor, buffer view 없는 accessor,
4개를 초과하는 스킨 영향, shear와 zero-scale 노드, base-color의 별도 UV 세트나
텍스처 변환은 명시적으로 거부합니다. 정규화된 정수 가중치·UV와
interleaved vertex attribute는 지원합니다.

복잡한 모델의 성능은 하드웨어에 따라 달라집니다. 버텍스 버퍼 갱신은
p5의 내부 `Geometry.dirtyFlags`를 사용하며, 글로벌 캔버스의 WEBGL 여부는
`p5.instance._renderer.isP3D`로 확인합니다. p5 버전을 바꿀 때 재검증이 필요합니다.

## 테스트

Node 22 이상에서:

```sh
node --test tests/*.test.js
```

단일 클래스 구조, GLB 로딩·교체, 결과 배열 적용, 스키닝, 표시 옵션,
생성·로딩 분리, 그리기 상태 복원, 캔버스 크기 변경, 스케치의 ml5 준비 순서를
검증합니다. 작은 GLB 픽스처로 FPS별 보간, 법선 변환, 계층 갱신 횟수,
음수 배율·행렬과 잘못된 파일도 검사합니다.
드롭 교체·실패·연속 요청·이벤트 해제와 변환 메서드의 유지·검증·적용 순서도 검사합니다.
실제 카메라 정확도와 하드웨어별 성능은 브라우저에서 확인하세요.
