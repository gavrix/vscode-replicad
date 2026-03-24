import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const vscode = acquireVsCodeApi();
installLoggingBridge();

const title = document.getElementById('title');
const status = document.getElementById('status');
const activity = document.getElementById('activity');
const overlayError = document.getElementById('overlayError');
const viewer = document.getElementById('viewer');
const svgHost = document.getElementById('svgHost');
const emptyState = document.getElementById('emptyState');
const gizmoHost = document.getElementById('gizmoHost');
const sectionPanel = document.getElementById('sectionPanel');
const sectionToggle = document.getElementById('sectionToggle');
const sectionCollapse = document.getElementById('sectionCollapse');
const sectionSlider = document.getElementById('sectionSlider');
const sectionAxisButtons = Array.from(document.querySelectorAll('[data-section-axis]'));

let latestRequestId = 0;
let meshGroup = null;
let currentBounds = null;

const sectionState = {
  enabled: false,
  expanded: false,
  axis: 'z',
  plane: new THREE.Plane(new THREE.Vector3(0, 0, -1), 0),
  sliderValue: 0,
  range: { min: -50, max: 50 },
  center: 0,
  surfaceMaterials: [],
  capMaterials: [],
  capMeshes: [],
};

console.info('booting preview webview');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
renderer.localClippingEnabled = true;
renderer.setPixelRatio(window.devicePixelRatio || 1);
viewer.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.background.convertSRGBToLinear();

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
camera.up.set(0, 0, 1);
camera.position.set(120, 120, 120);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);
controls.update();

scene.add(new THREE.AmbientLight(0xffffff, 1.5));
const dirLight = new THREE.DirectionalLight(0xffffff, 2.2);
dirLight.position.set(60, 120, 80);
scene.add(dirLight);
const grid = new THREE.GridHelper(200, 20, 0x555555, 0x333333);
grid.rotation.x = Math.PI / 2;
scene.add(grid);
scene.add(new THREE.AxesHelper(50));

const gizmoRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
gizmoRenderer.setPixelRatio(window.devicePixelRatio || 1);
gizmoHost.appendChild(gizmoRenderer.domElement);
const gizmoScene = new THREE.Scene();
const sectionHatchTexture = createSectionHatchTexture();
const gizmoCamera = new THREE.OrthographicCamera(-1.4, 1.4, 1.4, -1.4, 0.1, 10);
gizmoCamera.position.set(0, 0, 3);
const gizmoRoot = new THREE.Group();
gizmoScene.add(gizmoRoot);
gizmoScene.add(new THREE.AmbientLight(0xffffff, 1.8));
const gizmoLight = new THREE.DirectionalLight(0xffffff, 1.6);
gizmoLight.position.set(2, 2, 3);
gizmoScene.add(gizmoLight);
createAxisWidget(gizmoRoot);

sectionToggle.addEventListener('click', () => {
  sectionState.expanded = true;
  sectionState.enabled = true;
  updateSectionUi();
  applySectionState();
});

sectionCollapse.addEventListener('click', () => {
  sectionState.expanded = false;
  sectionState.enabled = false;
  updateSectionUi();
  applySectionState();
});

sectionAxisButtons.forEach((button) => {
  button.addEventListener('click', () => {
    sectionState.axis = button.dataset.sectionAxis || 'z';
    resetSectionSliderToCenter();
    updateSectionRange();
    updateSectionUi();
    applySectionState();
  });
});

sectionSlider.addEventListener('input', () => {
  sectionState.sliderValue = Number(sectionSlider.value);
  applySectionState();
});

const resizeObserver = new ResizeObserver(() => resizeRenderer());
resizeObserver.observe(viewer);
resizeObserver.observe(gizmoHost);
resizeRenderer();
updateSectionUi();
animate();

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'loading') {
    handleLoading(message);
    return;
  }

  if (message.type === 'document') {
    handleDocument(message);
    return;
  }

  if (message.type === 'clear') {
    console.info('clearing preview', message.reason);
    title.textContent = 'No file attached';
    status.textContent = message.reason;
    hideActivity();
    hideOverlayError();
    clearScene();
    showEmpty('Preview detached from the previous document.');
  }
});

window.addEventListener('error', (event) => {
  vscode.postMessage({
    type: 'error',
    message: event.message,
    stack: event.error?.stack,
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  vscode.postMessage({
    type: 'error',
    message: reason?.message || String(reason),
    stack: reason?.stack,
  });
});

vscode.postMessage({ type: 'ready', state: vscode.getState() });

function handleLoading(message) {
  latestRequestId = message.requestId;
  title.textContent = message.fileName;
  status.textContent = 'Building…';
  showActivity();
  hideOverlayError();
}

function handleDocument(message) {
  latestRequestId = message.requestId;
  console.info('handleDocument', { requestId: message.requestId, payload: message.payload?.kind });
  title.textContent = message.fileName;
  showActivity();
  hideOverlayError();
  vscode.setState({ uri: message.uri, version: message.version });

  renderPayload(message.payload);

  if (message.requestId === latestRequestId) {
    hideActivity();
    status.textContent = message.payload.kind === 'error' ? 'Error' : `Rendered · req ${message.requestId}`;
  }
}

function renderPayload(payload) {
  if (!payload) {
    clearScene();
    showEmpty('No payload.');
    return;
  }

  switch (payload.kind) {
    case 'empty':
      clearScene();
      hideOverlayError();
      showEmpty(payload.message);
      return;
    case 'error':
      clearScene();
      showOverlayError(payload.stack || payload.message);
      showEmpty('Build failed.');
      return;
    case 'svg':
      hideOverlayError();
      renderSvg(payload.entries);
      return;
    case 'mesh':
      hideOverlayError();
      renderMeshes(payload.entries);
      return;
    default:
      clearScene();
      showEmpty('Unknown payload.');
  }
}

function renderSvg(entries) {
  clearScene();
  const first = entries[0];
  const viewBox = Array.isArray(first.viewBox) ? first.viewBox.join(' ') : String(first.viewBox);
  const pathMarkup = entries
    .flatMap((entry) => entry.paths.map((path) => `<path d="${path}" fill="none" stroke="${entry.color || '#4da3ff'}" stroke-width="1.5" />`))
    .join('');

  svgHost.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${pathMarkup}</svg>`;
  svgHost.classList.remove('hidden');
  viewer.classList.add('hidden');
  gizmoHost.classList.add('hidden');
  sectionPanel.classList.add('hidden');
  sectionToggle.classList.add('hidden');
  emptyState.classList.add('hidden');
}

function renderMeshes(entries) {
  svgHost.classList.add('hidden');
  viewer.classList.remove('hidden');
  gizmoHost.classList.remove('hidden');
  emptyState.classList.add('hidden');
  clearScene();

  meshGroup = new THREE.Group();
  sectionState.surfaceMaterials = [];
  sectionState.capMaterials = [];
  sectionState.capMeshes = [];

  entries.forEach((entry, index) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(entry.vertices, 3));
    geometry.setIndex(entry.triangles);

    if (Array.isArray(entry.normals) && entry.normals.length === entry.vertices.length) {
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(entry.normals, 3));
    } else {
      geometry.computeVertexNormals();
    }

    const color = new THREE.Color(entry.color || defaultColor(index));
    const opacity = typeof entry.opacity === 'number' ? entry.opacity : 1;
    const sectioned = createSectionedMesh(geometry, color, opacity, index * 10);
    meshGroup.add(sectioned.group);
    sectionState.surfaceMaterials.push(sectioned.surfaceMaterial);
    sectionState.capMaterials.push(sectioned.capMaterial);
    sectionState.capMeshes.push(sectioned.capMesh);
  });

  scene.add(meshGroup);
  frameObject(meshGroup);
  updateSectionRange();
  updateSectionUi();
  applySectionState();
}

function createSectionedMesh(geometry, color, opacity, renderBase) {
  const group = new THREE.Group();

  const surfaceMaterial = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.08,
    roughness: 0.7,
    transparent: opacity < 1,
    opacity,
    side: THREE.DoubleSide,
  });

  const visibleMesh = new THREE.Mesh(geometry, surfaceMaterial);
  visibleMesh.renderOrder = renderBase + 6;
  group.add(visibleMesh);

  const stencilBack = createStencilMesh(geometry, THREE.BackSide, THREE.IncrementWrapStencilOp);
  stencilBack.renderOrder = renderBase + 1;
  group.add(stencilBack);

  const stencilFront = createStencilMesh(geometry, THREE.FrontSide, THREE.DecrementWrapStencilOp);
  stencilFront.renderOrder = renderBase + 2;
  group.add(stencilFront);

  const capMaterial = new THREE.MeshStandardMaterial({
    color: 0xe8ddc7,
    metalness: 0.02,
    roughness: 0.92,
    side: THREE.DoubleSide,
    map: sectionHatchTexture,
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  });
  const capMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), capMaterial);
  capMesh.renderOrder = renderBase + 3;
  capMesh.onAfterRender = (currentRenderer) => currentRenderer.clearStencil();
  group.add(capMesh);

  return { group, surfaceMaterial, capMaterial, capMesh };
}

function createStencilMesh(geometry, side, stencilOp) {
  const material = new THREE.MeshBasicMaterial({
    side,
    clippingPlanes: [sectionState.plane],
    depthTest: false,
    depthWrite: false,
    colorWrite: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: stencilOp,
    stencilZFail: stencilOp,
    stencilZPass: stencilOp,
  });

  return new THREE.Mesh(geometry, material);
}

function clearScene() {
  currentBounds = null;
  sectionState.surfaceMaterials = [];
  sectionState.capMaterials = [];
  sectionState.capMeshes = [];

  if (!meshGroup) return;
  scene.remove(meshGroup);
  meshGroup.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    if (child.material) {
      if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose());
      else child.material.dispose();
    }
  });
  meshGroup = null;
}

function showEmpty(text) {
  emptyState.textContent = text;
  emptyState.classList.remove('hidden');
  svgHost.classList.add('hidden');
  gizmoHost.classList.add('hidden');
  sectionPanel.classList.add('hidden');
  sectionToggle.classList.add('hidden');
}

function showOverlayError(text) {
  overlayError.textContent = text;
  overlayError.classList.remove('hidden');
}

function hideOverlayError() {
  overlayError.textContent = '';
  overlayError.classList.add('hidden');
}

function showActivity() {
  activity.classList.remove('hidden');
}

function hideActivity() {
  activity.classList.add('hidden');
}

function frameObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  currentBounds = box.clone();
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z) || 10;

  controls.target.copy(center);
  camera.near = Math.max(0.1, maxSize / 100);
  camera.far = Math.max(1000, maxSize * 50);
  camera.position.copy(center.clone().add(new THREE.Vector3(maxSize * 1.6, maxSize * 1.4, maxSize * 1.6)));
  camera.updateProjectionMatrix();
  controls.update();
}

function resizeRenderer() {
  const width = Math.max(1, viewer.clientWidth);
  const height = Math.max(1, viewer.clientHeight);
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  const gizmoWidth = Math.max(1, gizmoHost.clientWidth);
  const gizmoHeight = Math.max(1, gizmoHost.clientHeight);
  gizmoRenderer.setSize(gizmoWidth, gizmoHeight, false);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  syncGizmo();
  renderer.render(scene, camera);
  if (!gizmoHost.classList.contains('hidden')) {
    gizmoRenderer.render(gizmoScene, gizmoCamera);
  }
}

function syncGizmo() {
  gizmoRoot.quaternion.copy(camera.quaternion).invert();
}

function updateSectionRange() {
  if (!currentBounds) {
    sectionState.range = { min: -50, max: 50 };
    sectionState.center = 0;
    sectionSlider.min = '-50';
    sectionSlider.max = '50';
    sectionSlider.step = '0.1';
    sectionSlider.value = '0';
    sectionState.sliderValue = 0;
    return;
  }

  const min = currentBounds.min[sectionState.axis];
  const max = currentBounds.max[sectionState.axis];
  const safeMin = Number.isFinite(min) ? min : -50;
  const safeMax = Number.isFinite(max) ? max : 50;
  const center = (safeMin + safeMax) / 2;
  const halfSpan = Math.max(((safeMax - safeMin) / 2) * 1.2, 0.01);
  sectionState.center = center;
  sectionState.range = { min: -halfSpan, max: halfSpan };
  sectionSlider.min = (-halfSpan).toFixed(2);
  sectionSlider.max = halfSpan.toFixed(2);
  sectionSlider.step = Math.max((halfSpan * 2) / 400, 0.01).toFixed(3);
  sectionState.sliderValue = clamp(sectionState.sliderValue, -halfSpan, halfSpan);
  sectionSlider.value = String(sectionState.sliderValue);
}

function resetSectionSliderToCenter() {
  if (!currentBounds) {
    sectionState.sliderValue = 0;
    return;
  }
  sectionState.sliderValue = 0;
  sectionSlider.value = '0';
}

function updateSectionUi() {
  const canSection = !!meshGroup;
  sectionToggle.classList.toggle('hidden', !canSection || sectionState.expanded);
  sectionPanel.classList.toggle('hidden', !canSection || !sectionState.expanded);
  sectionToggle.classList.toggle('active', sectionState.enabled);
  sectionAxisButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.sectionAxis === sectionState.axis);
    button.disabled = !canSection;
  });
  sectionSlider.disabled = !sectionState.enabled;
}

function applySectionState() {
  const clippingPlanes = sectionState.enabled ? [updateSectionPlane()] : [];

  sectionState.surfaceMaterials.forEach((material) => {
    material.clippingPlanes = clippingPlanes;
    material.needsUpdate = true;
  });

  sectionState.capMaterials.forEach((material) => {
    material.clippingPlanes = [];
    material.needsUpdate = true;
  });

  sectionState.capMeshes.forEach((mesh) => {
    mesh.visible = sectionState.enabled;
  });

  if (!meshGroup || !sectionState.enabled) {
    return;
  }

  const maxSize = Math.max(
    currentBounds?.max.x - currentBounds?.min.x || 1,
    currentBounds?.max.y - currentBounds?.min.y || 1,
    currentBounds?.max.z - currentBounds?.min.z || 1
  );
  const planeSize = maxSize * 2.4;
  const planePoint = new THREE.Vector3();
  sectionState.plane.coplanarPoint(planePoint);
  const planeLookTarget = planePoint.clone().sub(sectionState.plane.normal);

  sectionState.capMeshes.forEach((mesh) => {
    mesh.geometry.dispose();
    mesh.geometry = new THREE.PlaneGeometry(planeSize, planeSize);
    mesh.position.copy(planePoint);
    mesh.lookAt(planeLookTarget);
  });
}

function updateSectionPlane() {
  const normal = baseNormalForAxis(sectionState.axis);
  const offset = sectionState.center + sectionState.sliderValue;
  const point = new THREE.Vector3();
  point[sectionState.axis] = offset;
  sectionState.plane.setFromNormalAndCoplanarPoint(normal, point);
  return sectionState.plane;
}

function baseNormalForAxis(axis) {
  switch (axis) {
    case 'x':
      return new THREE.Vector3(-1, 0, 0);
    case 'y':
      return new THREE.Vector3(0, -1, 0);
    case 'z':
    default:
      return new THREE.Vector3(0, 0, -1);
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createSectionHatchTexture() {
  const size = 64;
  const spacing = 16;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#e8ddc7';
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = '#6f6658';
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.7;

  for (let offset = -size; offset <= size; offset += spacing) {
    ctx.beginPath();
    ctx.moveTo(offset, size);
    ctx.lineTo(offset + size, 0);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(10, 10);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createAxisWidget(root) {
  root.add(createAxis(new THREE.Vector3(1, 0, 0), '#ff5f56', 'X'));
  root.add(createAxis(new THREE.Vector3(0, 1, 0), '#27c93f', 'Y'));
  root.add(createAxis(new THREE.Vector3(0, 0, 1), '#4da3ff', 'Z'));

  const origin = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 20, 20),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x222222 })
  );
  root.add(origin);
}

function createAxis(direction, color, label) {
  const group = new THREE.Group();
  const dir = direction.clone().normalize();
  const axisLength = 0.9;
  const shaftLength = 0.62;
  const shaftRadius = 0.035;
  const arrowLength = 0.22;
  const arrowRadius = 0.09;

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 20),
    new THREE.MeshStandardMaterial({ color })
  );
  shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  shaft.position.copy(dir.clone().multiplyScalar(shaftLength / 2));
  group.add(shaft);

  const head = new THREE.Mesh(
    new THREE.ConeGeometry(arrowRadius, arrowLength, 24),
    new THREE.MeshStandardMaterial({ color })
  );
  head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  head.position.copy(dir.clone().multiplyScalar(shaftLength + arrowLength / 2));
  group.add(head);

  const sprite = makeTextSprite(label, color);
  sprite.position.copy(dir.clone().multiplyScalar(axisLength + 0.18));
  group.add(sprite);

  return group;
}

function makeTextSprite(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(64, 64, 36, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 44px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 64, 67);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(0.58, 0.58, 0.58);
  return sprite;
}

function defaultColor(index) {
  return ['#4da3ff', '#ff8c69', '#87d37c', '#d9a7ff'][index % 4];
}

function installLoggingBridge() {
  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  const send = (level, args) => {
    const message = args.map(stringify).join(' ');
    vscode.postMessage({ type: 'log', level, message });
  };

  console.log = (...args) => {
    original.log(...args);
    send('info', args);
  };
  console.info = (...args) => {
    original.info(...args);
    send('info', args);
  };
  console.warn = (...args) => {
    original.warn(...args);
    send('warn', args);
  };
  console.error = (...args) => {
    original.error(...args);
    send('error', args);
  };
  console.debug = (...args) => {
    original.debug(...args);
    send('debug', args);
  };
}

function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
