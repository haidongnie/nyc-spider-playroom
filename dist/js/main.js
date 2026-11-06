import { createPowerPicker } from './power-picker.js';
import { createFlashTrail } from './flash-effects.js';
import { createVehicleRadio } from './vehicle-radio.js';
import { createHijack } from './hijack.js';
import { createMultiplayer } from './multiplayer.js';
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, metalness, roughness, vec2, smoothstep } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { createPostProcessing } from './post-processing.js';
import { ClusteredLighting } from 'three/addons/lighting/ClusteredLighting.js';
import { getLocationLabel, isTypingInField, ROADS, NYC_LANDMARKS, TELEPORT_LOCATIONS, streetZ } from './city-config.js';
import { buildCityGrid } from './city-grid.js';
import { buildBoroughs } from './boroughs.js';
import { buildLandmarks } from './landmarks.js';
import { buildCityBlocks } from './buildings.js';
import { buildStreetDetails } from './street-details.js';
import { createTrafficSystem, createHighwayTraffic } from './traffic.js';
import { createAirTraffic } from './skycar.js';
import { createAirTrafficLights } from './air-traffic-lights.js';
import { buildRoadPaint } from './road-paint.js';
import { ThirdPersonControllerManager } from './controllers.js';
import { TouchControls } from './touch-controls.js';
import { GamepadControls } from './gamepad-controls.js';
import { CameraSystem, CAMERA_PRESETS } from './cameras.js';
import { LightingSystem } from './lighting.js';
import { NYCMapSystem } from './nyc-map.js';
import { setupSceneCulling, updateSceneCulling } from './scene-culling.js';
import { CityAudioSystem } from './audio-system.js';

// Application setup, shader warm-up and frame loop.

async function initApp() {
  const container = document.getElementById('canvas-container');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingStatus = document.getElementById('loading-status');
  const loadingFill = document.getElementById('loading-progress');

  // One progress bar for the whole start-up. Each stage fills a share of it sized after its typical duration (the
  // "[init]" timings logged below, on an M1 MacBook Air; `data` is fetching the code and data before this runs, which
  // the stylesheet animates). The fill glides through a stage as a compositor transition, so it keeps moving while the
  // stage's synchronous work blocks the main thread, at the pace the earlier stages ran at on this machine.
  const STAGE_MS = {
    data: 1800, renderer: 50, lighting: 60, cityGrid: 1800, boroughs: 560, landmarks: 200, blocks: 2100,
    streetDetails: 2200, traffic: 860, roadPaint: 170, controllers: 50, culling: 730, ui: 50, postFX: 60,
    compile: 3900, warmup: 1950, gpu: 300
  };
  const stageNames = Object.keys(STAGE_MS);
  const totalStageMs = stageNames.reduce((sum, name) => sum + STAGE_MS[name], 0);
  const loadingStartedAt = performance.now();
  let loadingStage = { from: 0, to: STAGE_MS.data / totalStageMs };

  const setLoadingProgress = (p, seconds = 0.3) => {
    if (!loadingFill) return;
    loadingFill.style.animation = 'none';
    loadingFill.style.transition = `transform ${seconds}s ${seconds > 0.3 ? 'linear' : 'ease'}`;
    loadingFill.style.transform = `scaleX(${Math.min(1, Math.max(0, p))})`;
  };
  // Progress through the current stage, for stages that can measure it
  const setStageProgress = (f) => setLoadingProgress(loadingStage.from + (loadingStage.to - loadingStage.from) * f);

  const stageText = /^zh/i.test(navigator.language) ? {
    renderer:'正在启动图形引擎…', lighting:'正在布置光照…', cityGrid:'正在生成路网…',
    boroughs:'正在准备桥梁和周边城区…', landmarks:'正在准备地标…', blocks:'正在加载附近街区…',
    streetDetails:'正在布置附近街道…', traffic:'正在安排车辆和行人…', roadPaint:'正在绘制路面标线…',
    controllers:'正在准备角色和载具…', culling:'正在准备视野内的建筑…', ui:'正在准备地图和界面…',
    postFX:'正在准备光影…', compile:'正在编译街景材质…', warmup:'正在绘制出生点…', gpu:'正在显示第一帧…'
  } : null;
  function beginLoadingStage(message, name, glide = true) {
    if (loadingStatus) loadingStatus.textContent = stageText?.[name] || message;
    const index = stageNames.indexOf(name);
    const before = stageNames.slice(0, index).reduce((sum, n) => sum + STAGE_MS[n], 0);
    loadingStage = { from: before / totalStageMs, to: (before + STAGE_MS[name]) / totalStageMs };
    if (!glide) return setLoadingProgress(loadingStage.from);
    const ranMs = before - STAGE_MS.data;
    const pace = ranMs >= 1000 ? Math.min(4, Math.max(0.5, (performance.now() - loadingStartedAt) / ranMs)) : 1;
    setLoadingProgress(loadingStage.to, (STAGE_MS[name] * pace) / 1000);
  }

  async function showLoadingStage(message, name, glide) {
    beginLoadingStage(message, name, glide);
    if (document.hidden) return;
    // Let the label paint before synchronous work. The timeout also lets hidden tabs keep loading.
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 100);
      requestAnimationFrame(() => {
        clearTimeout(timeout);
        setTimeout(resolve, 0);
      });
    });
  }

  await showLoadingStage('Initializing graphics...', 'renderer');

  // 1. Initialize Three.js WebGPURenderer with 32-bit float reversedDepthBuffer.
  // Firefox WebGL2 incurs a heavy renderbufferStorageMultisample + blitFramebuffer stall
  // on multisampled floating-point MRT post-processing render targets, so disable MSAA on Firefox.
  const isFirefox = typeof navigator !== 'undefined' && /Firefox\//.test(navigator.userAgent);
  const renderer = new THREE.WebGPURenderer({
    antialias: !isFirefox,
    powerPreference: 'high-performance',
    reversedDepthBuffer: true
  });
  renderer.setPixelRatio(1.0);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.lighting = new ClusteredLighting(256, 32, 28, 48);
  container.appendChild(renderer.domElement);

  // Start-up phase timings (logged once as "[init] ...") to keep load-time regressions traceable
  let initTimings = [];
  let initMark = performance.now();
  const markInit = (label) => {
    const now = performance.now();
    initTimings.push(`${label} ${Math.round(now - initMark)}ms`);
    initMark = now;
  };

  await renderer.init();
  markInit('renderer');

  // 2. Scene, atmosphere and lighting
  await showLoadingStage('Creating sky and environment lighting...', 'lighting');
  const scene = new THREE.Scene();
  const lightingSystem = new LightingSystem(scene, renderer);
  markInit('lighting');

  // 3. Build Manhattan Geography, Iconic Landmarks, Blocks, Street Details & Traffic
  await showLoadingStage('Building streets, parks and waterfronts...', 'cityGrid');
  const cityGrid = buildCityGrid(scene);
  markInit('cityGrid');
  await showLoadingStage('Building bridges and surrounding boroughs...', 'boroughs');
  const boroughs = buildBoroughs(scene, { sidewalks: cityGrid.sidewalks });
  markInit('boroughs');
  await showLoadingStage('Building landmarks...', 'landmarks');
  const { colliders: landmarkColliders } = buildLandmarks(scene);
  markInit('landmarks');
  await showLoadingStage('Generating building footprints and facades...', 'blocks');
  const cityBlocks = buildCityBlocks(scene, landmarkColliders);
  let savedPlayer=null;
  try {savedPlayer=JSON.parse(localStorage.getItem('nyc-player-state'));} catch {}
  const prior=(savedPlayer?.version===1 || savedPlayer?.version===2) ? savedPlayer.entities?.[savedPlayer.activeMode] : null;
  const spawn=prior && [prior.x,prior.z].every(Number.isFinite) ? prior : {x:-11.6,z:streetZ(37)+12};
  await cityBlocks.stream.ensureAt(spawn.x,spawn.z);
  markInit('blocks');
  const fixedColliders=[...landmarkColliders,...boroughs.colliders,...(cityGrid.colliders||[])];
  const allColliders = [...fixedColliders,...cityBlocks.colliders];
  // Road topology and ambient flight planning are shared between room members,
  // independently of the player's current district or saved location.
  const navigationColliders=[...fixedColliders,...cityBlocks.navigationColliders];

  await showLoadingStage('Placing trees, streetlights and street furniture...', 'streetDetails');
  const streetDetails = buildStreetDetails(scene, allColliders);
  markInit('streetDetails');
  await showLoadingStage('Creating traffic and pedestrian routes...', 'traffic');
  // Buildings turned along non-grid streets have oriented colliders whose world bounds reach past their lots: they stay
  // inside the property line anyway, so the road network (lanes & sidewalks) doesn't need them.
  // Elevated building sections that clear even a bus don't obstruct ground traffic.
  const trafficSystem = createTrafficSystem(scene, cityGrid.sidewalks, [
    ...cityGrid.footprints,
    ...streetDetails.footprints,
    ...navigationColliders.filter((c) => !c.obb && (c.minY ?? 0) < 3.5)
  ], streetDetails.signalIntersections);
  markInit('traffic');
  const highwayTraffic = createHighwayTraffic(scene, cityGrid.highwayLanes);
  const airTraffic = createAirTraffic(scene, { roadNetwork: trafficSystem.network, colliders: navigationColliders });
  const airLights = createAirTrafficLights(scene, airTraffic.group);
  await showLoadingStage('Adding road markings...', 'roadPaint');
  buildRoadPaint(scene, trafficSystem.network, cityGrid.roadPaint);
  markInit('roadPaint');

  // 4. Initialize player vehicles and the camera system
  await showLoadingStage('Preparing player, vehicles and controls...', 'controllers');
  const controllerManager = new ThirdPersonControllerManager(scene, allColliders);
  controllerManager.ensureDistrictAt=cityBlocks.stream.ensureAt;
  let hijack, savedStreetCar=null;
  // Reuse teleport placement so saved players return at rest, close to their last positions.
  try {
    const saved = savedPlayer;
    if (saved?.version === 1 || saved?.version === 2) {
      savedStreetCar=saved.hijack;
      for (const mode of Object.keys(controllerManager.entities)) {
        const p = saved.entities?.[mode];
        if (!p || ![p.x, p.y, p.z, p.heading].every(Number.isFinite)) continue;
        controllerManager.setMode(mode, {dismount:false});
        controllerManager.teleportActiveTo(p.x, p.z, p.heading, p.y);
      }
      controllerManager.setMode(saved.version === 2 && Object.hasOwn(controllerManager.entities, saved.activeMode) ? saved.activeMode : 'person', {dismount:false});
      controllerManager.setPower(saved.selectedPower);
      controllerManager.setSpiderSuit(saved.version === 2 && saved.spiderSuited === true, {immediate:true});
    }
  } catch { /* Missing or unavailable storage does not prevent playing. */ }

  function savePlayerState() {
    try {
      const entities = Object.fromEntries(Object.entries(controllerManager.entities)
        .filter(([mode, entity]) => mode !== 'skycar' || entity.launched)
        .map(([mode, entity]) => [mode, {
          x: entity.position.x, y: entity.position.y, z: entity.position.z, heading: entity.heading
        }]));
      localStorage.setItem('nyc-player-state', JSON.stringify({ version: 2, activeMode: controllerManager.activeMode, spiderSuited: controllerManager.spiderSuited, selectedPower: controllerManager.selectedPower, hijack:hijack?.save(), entities }));
    } catch { /* Storage may be disabled or full. */ }
  }

  const cameraSystem = new CameraSystem(renderer.domElement, controllerManager);
  const touchControls = new TouchControls(controllerManager);
  const soundButton = document.getElementById('btn-sound');
  const audioSystem = new CityAudioSystem({ controllerManager, trafficSystem, highwayTraffic, airTraffic, streetDetails }, {
    onStateChange: updateSoundButton
  });
  const radio = createVehicleRadio(audioSystem);
  function updateSoundButton() {
    radio.sync();
    if (!soundButton) return;
    soundButton.disabled = !audioSystem.supported;
    soundButton.setAttribute('aria-pressed', String(audioSystem.enabled));
    soundButton.setAttribute('aria-label', audioSystem.enabled ? 'Mute sound' : 'Enable sound');
    soundButton.title = audioSystem.supported ? `${audioSystem.enabled ? 'Mute' : 'Enable'} sound [N]` : 'Web Audio is unavailable';
    soundButton.querySelector('use').setAttribute('href', audioSystem.enabled ? '#i-sound' : '#i-sound-off');
  }
  soundButton?.addEventListener('click', () => audioSystem.setEnabled(!audioSystem.enabled));
  updateSoundButton();
  // pagehide also covers navigation away on mobile; preserve the context across back-forward cache restores.
  window.addEventListener('pagehide', (event) => {
    savePlayerState();
    if (!event.persisted) audioSystem.dispose();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePlayerState(); });
  markInit('controllers');

  // Island-wide static geometry: chunk & distance-cull the small props, shadow stand-ins for the big casters
  // (scene-culling.js)
  await showLoadingStage('Preparing scene visibility and shadows...', 'culling');
  const cullingRoots = ['ManhattanCityGrid', 'ManhattanCityBlocks', 'ManhattanStreetDetails', 'ManhattanLandmarks', 'Boroughs', 'RoadMarkings']
    .map((name) => scene.getObjectByName(name))
    .filter(Boolean);
  setupSceneCulling(scene, cullingRoots, lightingSystem.sunLight.shadow);

  // Initialize static world matrices once, including the chunks and shadow proxies created above.
  // Crowd, tree and building-detail animation changes instance/pose buffers, not Object3D transforms.
  const dynamicRoots = [
    trafficSystem.group,
    highwayTraffic.group,
    airTraffic.group,
    scene.getObjectByName('StoreClusteredLights'),
    scene.getObjectByName('StreetClusteredLights'),
    ...Object.values(controllerManager.entities).map((entity) => entity.mesh)
  ];
  scene.updateMatrixWorld(true);
  scene.matrixWorldAutoUpdate = false;
  markInit('culling');

  // 5. TSL RenderPipeline with Half-Res Screen Space Reflections (SSRNode), Bloom & Filmic Toning
  //    Fade out distant and matte surfaces so SSR spends its rays on visible glossy reflections.
  await showLoadingStage('Setting up visual effects, map and interface...', 'ui');
  const scenePass = pass(scene, cameraSystem.camera);
  // The multisampled colour attachments (output, normal, metalRough) only need resolving, never storing: discarding
  // them spares the GPU writing 3 x 4 samples per pixel to memory every frame (transient, memoryless attachments where
  // the browser supports them). The multisampled depth stays stored: SSR reads it.
  scenePass.renderTarget.storeMultisampledColorBuffer = false;
  const ssrFade = smoothstep(360.0, 180.0, positionView.z.negate());
  const maxSSRRoughness = 0.75;
  const sceneMRT = mrt({
    output: output,
    normal: normalView,
    metalRough: vec2(roughness.lessThan(maxSSRRoughness).select(metalness.mul(ssrFade), 0), roughness)
  });
  sceneMRT.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
  sceneMRT.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
  scenePass.setMRT(sceneMRT);

  const scenePassColor = scenePass.getTextureNode('output');
  const scenePassDepth = scenePass.getTextureNode('depth');
  const scenePassNormal = scenePass.getTextureNode('normal');
  const scenePassMetalRough = scenePass.getTextureNode('metalRough');

  const ssrPass = ssr(scenePassColor, scenePassDepth, scenePassNormal, {
    metalnessNode: scenePassMetalRough.r,
    roughnessNode: scenePassMetalRough.g,
    camera: cameraSystem.camera
  });
  ssrPass.resolutionScale = 0.5;
  ssrPass.blurQuality = 1;
  ssrPass.maxDistance.value = 42;
  ssrPass.thickness.value = 0.85;
  // Fewer coarse steps, then refine detected hits to keep reflection edges precise.
  ssrPass.quality.value = 0.25;
  ssrPass.binaryRefine = true;
  ssrPass.intensity.value = 0.50;
  ssrPass.screenEdgeFadeBlack = true;

  // Roughness mip blur must not spread reflections back onto matte or nonreflective surfaces.
  const reflectionMask = scenePassMetalRough.r.greaterThan(0).select(smoothstep(maxSSRRoughness, 0.55, scenePassMetalRough.g), 0);
  const reflections = ssrPass.mul(reflectionMask);
  const colorGrade = createPostProcessing(renderer, scenePassColor, reflections, {
    camera: cameraSystem.camera, scene, controllerManager, airTraffic
  });
  const renderPipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);
  const styleButton = document.getElementById('btn-visual-style');
  const styleName = document.getElementById('visual-style-name');
  let artStyle = 'realistic';

  function selectArtStyle(value, save = true) {
    artStyle = value === 'anime' ? 'anime' : 'realistic';
    lightingSystem.setArtStyle(artStyle);
    colorGrade.setArtStyle(artStyle, renderPipeline);
    document.body.dataset.artStyle = artStyle;
    const anime = artStyle === 'anime';
    styleName.textContent = anime ? 'Anime' : 'Realistic';
    styleButton.setAttribute('aria-pressed', String(anime));
    styleButton.setAttribute('aria-label', 'Anime art style');
    styleButton.title = anime ? 'Switch to Realistic style [J]' : 'Switch to Anime style [J]';
    if (save) {
      try { localStorage.setItem('nyc-art-style', artStyle); } catch { /* Use the selection for this visit. */ }
    }
  }
  styleButton.addEventListener('click', () => selectArtStyle(artStyle === 'realistic' ? 'anime' : 'realistic'));

  // 6. Wire UI Controls (Strictly using safe DOM APIs: textContent, classList, addEventListener)
  const modeButtons = document.querySelectorAll('[data-mode]');
  const cameraButtons = document.querySelectorAll('[data-camera]');
  const timeButtons = document.querySelectorAll('[data-time]');
  const teleportButtons = document.querySelectorAll('[data-teleport]');
  const hudToggleBtn = document.getElementById('btn-toggle-hud');
  const modeSwitch = document.getElementById('mode-switch');
  touchControls.onAvailabilityChange = placeModeIndicator;

  const elFps = document.getElementById('hud-fps');
  const elMode = document.getElementById('hud-active-mode');
  const elCamera = document.getElementById('hud-active-camera');
  const elSpeed = document.getElementById('hud-speed');
  const elSpeedMeter = document.getElementById('hud-speed-meter');
  const elAltitude = document.getElementById('hud-altitude');
  const elLocation = document.getElementById('hud-location');
  const elControlsHint = document.getElementById('hud-controls-hint');
  const gamepadControls = new GamepadControls(controllerManager, cameraSystem, {
    onCycleMode: (step) => {
      const modes = ['person', 'car', 'cyclist', 'helicopter', 'skycar'];
      selectMode(modes[(modes.indexOf(controllerManager.activeMode) + step + modes.length) % modes.length]);
    },
    onCycleCamera: cycleCamera,
    onToggleMap: () => mapSystem.toggleFullMap(!mapSystem.isFullMapOpen),
    onCloseMap: () => mapSystem.toggleFullMap(false)
  });

  // Keyboard guide for each mode: [keys, action]
  const controlHints = {
    person: [[['W', 'S'], 'Run / Turn back'], [['A', 'D'], 'Turn'], [['Space'], 'Jump'], [['E'], 'Take nearby car']],
    car: [[['W', 'S'], 'Drive / Reverse'], [['A', 'D'], 'Steer'], [['B'], 'Horn'], [['E'], 'Exit when slow']],
    cyclist: [[['W', 'S'], 'Pedal / Brake'], [['A', 'D'], 'Lean & Turn']],
    helicopter: [[['W', 'S'], 'Pitch'], [['A', 'D'], 'Yaw'], [['Space'], 'Ascend'], [['C'], 'Descend']],
    skycar: [[['W', 'S'], 'Throttle / Brake'], [['A', 'D'], 'Steer'], [['Space'], 'Ascend'], [['C'], 'Descend']]
  };
  // Top speeds in mph set the full scale of the speed meter.
  const topSpeedMph = { person: 18, car: 81, cyclist: 43, helicopter: 116, skycar: 179 };

  const chineseHints = /^zh(?:-|$)/i.test(navigator.language) ? {
    'Run / Turn back':'向前跑 / 回头跑', Turn:'转向', Jump:'跳跃', 'Transform':'变身', 'Take nearby car':'靠近车门劫车',
    'Hold to swing':'按住射丝摆荡', 'Drive / Reverse':'前进 / 倒车', Steer:'转向', Horn:'鸣笛',
    'Exit when slow':'减速后下车', 'Pedal / Brake':'骑行 / 刹车', 'Lean & Turn':'倾身转向',
    Pitch:'俯仰', Yaw:'转向', Ascend:'上升', Descend:'下降', 'Throttle / Brake':'加速 / 减速',
    'Mouse look':'点击街景控制视角', 'Free cursor':'释放鼠标', 'Look':'环顾'
  } : null;
  function renderControlHints(mode) {
    if (!elControlsHint) return;
    const hints = [...(controlHints[mode] || [])];
    if (mode === 'person' && controllerManager.spiderSuited && controllerManager.selectedPower === 'spider') hints.push([['R'], 'Hold to swing']);
    hints.push([['Q'], 'Transform']);
    const mouseHint = {click: [['Click'], 'Mouse look'], locked: [['Esc'], 'Free cursor'], soft: [['Esc'], 'Free cursor'], drag: [['Drag'], 'Look']};
    if (mouseHint[cameraSystem.mouseLookMode]) hints.push(mouseHint[cameraSystem.mouseLookMode]);
    const items = hints.map(([keys, action]) => {
      const item = document.createElement('span');
      item.className = 'hint';
      for (const key of keys) {
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        item.appendChild(kbd);
      }
      const label = document.createElement('span');
      label.className = 'hint-label';
      label.textContent = chineseHints?.[action] || action;
      item.appendChild(label);
      return item;
    });
    elControlsHint.replaceChildren(...items);
  }

  window.addEventListener('mouse-look-change', () => renderControlHints(controllerManager.activeMode));

  // The taxi-yellow pill under the selected mode glides from button to button
  function placeModeIndicator() {
    const active = modeSwitch ? modeSwitch.querySelector('.mode-btn.active') : null;
    if (!active) return;
    modeSwitch.style.setProperty('--ind-x', `${active.offsetLeft}px`);
    modeSwitch.style.setProperty('--ind-w', `${active.offsetWidth}px`);
  }

  function selectMode(mode, options) {
    controllerManager.setMode(mode, options);
    hijack?.switched(mode);
    radio.setMode(controllerManager.activeMode);
    touchControls.setMode(controllerManager.activeMode);
    gamepadControls.reset();
    modeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });
    document.body.dataset.mode = mode;
    placeModeIndicator();
    const ent = controllerManager.getActiveEntity();
    if (elMode) elMode.textContent = ent.label;
    renderControlHints(mode);

    // If currently on a static scenic camera, switch to 3rd-Person Chase so user sees their selected character/vehicle
    const currentCam = cameraSystem.getActivePreset();
    if (currentCam.category !== 'follow') {
      selectCamera('chase', false);
    }
  }

  const portrait = document.getElementById('hero-portrait');
  function syncHeroPortrait() {
    const suited = controllerManager.spiderSuited;
    portrait.setAttribute('aria-pressed',String(suited));
    powerPicker.sync();
    const active = controllerManager.getActiveEntity();
    if (elMode) elMode.textContent = active.label;
    touchControls.updateActions(controllerManager.activeMode);
    renderControlHints(controllerManager.activeMode);
  }
  function togglePower() {
    controllerManager.setSpiderSuit(!controllerManager.spiderSuited);
    syncHeroPortrait();
    savePlayerState();
  }
  const powerPicker = createPowerPicker(portrait, controllerManager, {
    onToggle: togglePower,
    onChoose(power) {
      controllerManager.setPower(power);
      controllerManager.setSpiderSuit(true);
      syncHeroPortrait();
      savePlayerState();
    }
  });
  const flashTrail = createFlashTrail(scene);
  controllerManager.setSpiderSuit(controllerManager.spiderSuited, {immediate:true});
  syncHeroPortrait();

  function selectCamera(camId, snap = false) {
    cameraSystem.setCameraPreset(camId, snap);
    cameraButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-camera') === camId);
    });
    const preset = cameraSystem.getActivePreset();
    if (elCamera) elCamera.textContent = preset.name;
  }

  // Steps through CAMERA_PRESETS (V / Shift+V, and the arrows either side of the camera name)
  function cycleCamera(step) {
    const n = CAMERA_PRESETS.length;
    const idx = CAMERA_PRESETS.findIndex((p) => p.id === cameraSystem.activePresetId);
    selectCamera(CAMERA_PRESETS[(idx + step + n) % n].id, true);
  }

  function selectTime(timeId) {
    lightingSystem.applyPreset(timeId);
    colorGrade.applyPreset(lightingSystem.activePresetId);
    timeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-time') === timeId);
    });
  }

  // Popovers (native [popover]: light dismiss & Esc for free) open against the control that toggles them: data-anchor
  // names the element they sit above / below, data-align the one whose right edge they line up with
  const popovers = document.querySelectorAll('.popover[popover]');
  const supportsPopover = typeof HTMLElement.prototype.togglePopover === 'function';
  function closePopovers() {
    if (!supportsPopover) return;
    popovers.forEach((pop) => {
      if (pop.matches(':popover-open')) pop.hidePopover();
    });
  }
  popovers.forEach((pop) => {
    const invoker = document.querySelector(`[popovertarget="${pop.id}"]`);
    pop.addEventListener('beforetoggle', (e) => {
      const open = e.newState === 'open';
      if (invoker) invoker.classList.toggle('is-open', open);
      if (!open) return;
      const anchor = document.getElementById(pop.dataset.anchor) || invoker;
      const align = document.getElementById(pop.dataset.align) || invoker;
      if (!anchor || !align) return;
      const r = anchor.getBoundingClientRect();
      const spaceAbove = Math.max(0, r.top - 20);
      const spaceBelow = Math.max(0, window.innerHeight - r.bottom - 20);
      let above = pop.dataset.side === 'above';
      // The camera control moves to the top on touch screens; open toward the available space.
      if ((above ? spaceAbove : spaceBelow) < 160) above = spaceAbove > spaceBelow;
      pop.style.right = `${Math.max(8, window.innerWidth - align.getBoundingClientRect().right)}px`;
      if (above) {
        pop.style.top = 'auto';
        pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
        pop.style.maxHeight = `${spaceAbove}px`;
      } else {
        pop.style.bottom = 'auto';
        pop.style.top = `${r.bottom + 8}px`;
        pop.style.maxHeight = `${spaceBelow}px`;
      }
    });
  });

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectMode(btn.getAttribute('data-mode'));
    });
  });

  cameraButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectCamera(btn.getAttribute('data-camera'), true);
      closePopovers();
    });
  });

  const camPrevBtn = document.getElementById('cam-prev');
  const camNextBtn = document.getElementById('cam-next');
  if (camPrevBtn) camPrevBtn.addEventListener('click', () => cycleCamera(-1));
  if (camNextBtn) camNextBtn.addEventListener('click', () => cycleCamera(1));

  timeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectTime(btn.getAttribute('data-time'));
    });
  });

  // A mouse click mustn't leave the focus on a HUD button, or Space (jump / ascend) and Enter would press it again
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (btn && e.detail > 0) btn.blur();
  });

  // Where you are: the place's name over its street corner, drawn as a pair of NYC street-name signs
  const roadNames = new Set(ROADS.map((r) => r.name));
  const placeNames = new Set(NYC_LANDMARKS.map((l) => l.name));
  let locationText = '';
  function renderLocation(label) {
    if (!elLocation || label === locationText) return;
    locationText = label;
    let place = '';
    let streets = label;
    const split = label.indexOf(' · ');
    if (split >= 0) {
      place = label.slice(0, split);
      streets = label.slice(split + 3);
    } else if (placeNames.has(label) || (!label.includes(' & ') && !roadNames.has(label))) {
      place = label;
      streets = '';
    }
    const nodes = [];
    if (place) {
      const el = document.createElement('div');
      el.className = 'location-place';
      el.textContent = place;
      nodes.push(el);
    }
    if (streets) {
      const row = document.createElement('div');
      row.className = 'location-signs';
      if (streets.startsWith('near ')) {
        streets = streets.slice(5);
        const near = document.createElement('span');
        near.className = 'location-near';
        near.textContent = 'near';
        row.appendChild(near);
      }
      for (const name of streets.split(' & ')) {
        const sign = document.createElement('span');
        sign.className = 'street-sign';
        sign.textContent = name;
        row.appendChild(sign);
      }
      nodes.push(row);
    }
    elLocation.replaceChildren(...nodes);
  }

  let teleportRequest=0;
  async function teleportTo(x, z, heading = Math.PI) {
    const request=++teleportRequest;
    try {await cityBlocks.stream.ensureAt(x,z);} catch (error) {
      console.warn('[district] Teleport destination unavailable',error); return;
    }
    if(request!==teleportRequest)return;
    const destination = controllerManager.teleportActiveTo(x, z, heading);
    touchControls.reset();
    gamepadControls.reset();
    cameraSystem.resetForTeleport();
    selectCamera('chase', true);
    mapSystem.waypoint = {
      x: destination.x,
      z: destination.z,
      name: getLocationLabel(destination.x, destination.z)
    };
    return destination;
  }

  const mapSystem = new NYCMapSystem({
    controllerManager,
    cameraSystem,
    allBlocks: cityBlocks.allBlocks,
    onToggle: (open) => {
      controllerManager.resetInput();
      touchControls.setEnabled(!open);
      gamepadControls.setEnabled(!open);
      const mapHint = document.getElementById('fullmap-hover-info');
      if (open && touchControls.available && mapHint) {
        mapHint.textContent = 'Tap to teleport · Drag to pan · Use + / − to zoom';
      }
    },
    onTeleport: teleportTo
  });

  teleportButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-teleport');
      const loc = TELEPORT_LOCATIONS[key];
      if (loc) {
        teleportTo(loc.x, loc.z, loc.heading);
      }
      closePopovers();
    });
  });

  const openMapBtn = document.getElementById('btn-open-map');
  if (openMapBtn) openMapBtn.addEventListener('click', () => mapSystem.toggleFullMap(true));

  if (hudToggleBtn) {
    hudToggleBtn.addEventListener('click', () => {
      document.body.classList.toggle('hud-minimized');
      const isMin = document.body.classList.contains('hud-minimized');
      hudToggleBtn.setAttribute('aria-pressed', String(isMin));
      hudToggleBtn.setAttribute('aria-label', isMin ? 'Show HUD' : 'Hide HUD');
      hudToggleBtn.title = isMin ? 'Show the HUD [H]' : 'Clean view: hide the HUD [H]';
      if (isMin) closePopovers();
    });
  }

  // Global keyboard shortcuts for modes (1-4), cameras (V / 5-0), and HUD (H)
  window.addEventListener('keydown', (e) => {
    if (isTypingInField(e)) return;
    switch (e.code) {
      case 'KeyQ':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !e.target?.isContentEditable &&
          !mapSystem.isFullMapOpen && !document.querySelector('dialog[open]')) { e.preventDefault(); togglePower(); }
        break;
      case 'KeyE':
        if(!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && hijack?.act()) e.preventDefault();
        break;
      case 'Digit1':
        selectMode('person');
        break;
      case 'Digit2':
        selectMode('car');
        break;
      case 'Digit3':
        selectMode('cyclist');
        break;
      case 'Digit4':
        selectMode('helicopter');
        break;
      case 'KeyF':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) selectMode('skycar');
        break;
      case 'Digit5':
        selectCamera('chase', true);
        break;
      case 'Digit6':
        selectCamera('action', true);
        break;
      case 'Digit7':
        selectCamera('pov', true);
        break;
      case 'Digit8':
        selectCamera('fifthAve', true);
        break;
      case 'Digit9':
        selectCamera('timesSquare', true);
        break;
      case 'Digit0':
        selectCamera('chryslerGCT', true);
        break;
      case 'KeyV':
        cycleCamera(e.shiftKey ? -1 : 1);
        break;
      case 'KeyH':
        if (hudToggleBtn) hudToggleBtn.click();
        break;
      case 'KeyJ':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) styleButton.click();
        break;
      case 'KeyN':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) audioSystem.setEnabled(!audioSystem.enabled);
        break;
      case 'KeyB':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !mapSystem.isFullMapOpen) audioSystem.honk(controllerManager.getActiveEntity());
        break;
    }
  });

  window.addEventListener('resize', () => {
    cameraSystem.onResize(window.innerWidth, window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
    placeModeIndicator();
    if (mapSystem.isFullMapOpen) {
      mapSystem.resizeFullCanvas();
      mapSystem.renderFullMap();
    }
  });

  hijack=createHijack({controllerManager,trafficSystem,selectMode,
    isBlocked:()=>document.hidden||mapSystem.isFullMapOpen||Boolean(document.querySelector('dialog[open]')),
    afterChange:()=>{cameraSystem.resetForTeleport();savePlayerState();}
  });

  hijack.restore(savedStreetCar);
  // Initialize the UI and chase camera around the restored player, or the civilian character on a first visit.
  selectMode(controllerManager.activeMode);
  selectCamera('chase', true);
  selectTime('golden');
  let savedStyle;
  try { savedStyle = localStorage.getItem('nyc-art-style'); } catch { /* Storage is optional. */ }
  selectArtStyle(savedStyle, false);
  // the web fonts change the buttons' widths once they arrive
  if (document.fonts) document.fonts.ready.then(placeModeIndicator);
  markInit('ui');

  // Prepare only the materials the starting camera will draw. The renderer
  // compiles newly visible geometry normally when a player turns or travels.
  async function precompileStartingView() {
    await showLoadingStage('Preparing reflections and bloom...', 'postFX');
    cameraSystem.update(0, 0);
    lightingSystem.update(cameraSystem.currentPos);
    updateSceneCulling(cameraSystem.currentPos);

    // This pass configures the MRT formats, reversed depth and MSAA samples
    // before scene compilation, so the first street frame can reuse its pipelines.
    scene.visible = false;
    try {
      renderPipeline.render();
    } finally {
      scene.visible = true;
    }
    markInit('postFX');

    const camera = cameraSystem.camera;
    camera.updateMatrixWorld(true);
    const projection = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(projection, camera.coordinateSystem, camera.reversedDepth);
    const seen = new Set();
    const objects = [];
    scene.traverseVisible((object) => {
      if ((!object.isMesh && !object.isLine && !object.isPoints && !object.isSprite) ||
          object.userData.shadowProxy || !object.layers.test(camera.layers)) return;
      if (object.frustumCulled && !(object.isSprite ? frustum.intersectsSprite(object) : frustum.intersectsObject(object))) return;
      // Static chunks share a shader with the other chunks of their source.
      // Ordinary meshes can share a material; instances may have distinct attributes.
      const key = object.userData.sharesPipelineWith ||
        (object.isInstancedMesh || object.isSkinnedMesh || Array.isArray(object.material) ? object : object.material);
      if (seen.has(key)) return;
      seen.add(key);
      objects.push(object);
    });

    await showLoadingStage('Compiling the starting view...', 'compile', false);
    renderer.setRenderTarget(scenePass.renderTarget);
    renderer.setMRT(sceneMRT);
    let next = 0, completed = 0;
    async function worker() {
      while (next < objects.length) {
        const object = objects[next++];
        // Let each compile start in its own browser task while other pipeline
        // creation promises are in flight.
        if (globalThis.scheduler?.yield) await globalThis.scheduler.yield();
        else await new Promise(resolve => setTimeout(resolve, 0));
        try {
          await renderer.compileAsync(object, camera, scene);
        } catch (error) {
          console.warn('[compile]', error); // The normal render will compile this material.
        }
        setStageProgress(++completed / objects.length);
      }
    }
    try {
      await Promise.all(Array.from({length: Math.min(16, objects.length)}, worker));
    } finally {
      renderer.setMRT(null);
      renderer.setRenderTarget(null);
    }
  }

  await precompileStartingView();
  markInit('compile');
  await showLoadingStage('Drawing your first street view...', 'warmup');

  const multiplayer = createMultiplayer({
    scene, controllerManager, trafficSystem, highwayTraffic, airTraffic, hijack, selectMode,
    onRendezvous: () => {
      touchControls.reset();
      gamepadControls.reset();
      cameraSystem.resetForTeleport();
      selectCamera('chase', true);
    },
    getDay: () => lightingSystem.activePresetId, changeDay: selectTime
  });

  // 6. Animation Loop
  let lastTime = performance.now();
  let elapsed = 0;
  let frameCount = 0;
  let fpsTimer = 0;
  let nextPlayerSave = 0;
  let firstFrameSubmitted = false;

  if (elFps) elFps.textContent = '60';

  renderer.setAnimationLoop((now) => {
    const rawDt = (now - lastTime) * 0.001;
    lastTime = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    elapsed += dt;

    // Update 3rd-person controllers, camera, signals, traffic & vehicle collisions, building LODs, and dynamic shadow focus
    const cityClock = multiplayer.before(dt,elapsed);
    gamepadControls.update(dt);
    hijack.update();
    controllerManager.update(dt, elapsed, cameraSystem);
    cameraSystem.update(dt, elapsed);
    const runner = controllerManager.entities.person;
    const sprinting = controllerManager.activeMode === 'person' && controllerManager.spiderSuited &&
      controllerManager.selectedPower === 'flash' && Math.abs(runner.speed) > 3;
    flashTrail.update(dt, runner.position, runner.heading, sprinting, runner.avatar.root);
    controllerManager.entities.person.avatar.root.visible = cameraSystem.activePresetId !== 'pov';
    streetDetails.signalClock.value = cityClock;
    trafficSystem.update(
      dt,
      cityClock,
      cameraSystem.currentPos,
      controllerManager.getActiveEntity(),
      controllerManager.activeMode,
      cameraSystem.camera
    );
    highwayTraffic.update(dt, cameraSystem.camera, controllerManager.getActiveEntity(), controllerManager.activeMode);
    multiplayer.updateAir(dt, controllerManager.getActiveEntity(), cameraSystem.camera);
    airLights.update(dt, cameraSystem.camera);
    if (!document.hidden && now >= nextPlayerSave) {
      savePlayerState();
      nextPlayerSave = now + 5000;
    }
    if (boroughs.update) boroughs.update(elapsed); // Roosevelt Island Tramway cabins
    if (!loadingOverlay || loadingOverlay.classList.contains('hidden')) {
      cityBlocks.stream.update(cameraSystem.currentPos.x,cameraSystem.currentPos.z,controllerManager.getActiveEntity().position);
    }
    cityBlocks.update(cameraSystem.currentPos.x, cameraSystem.currentPos.z);
    if (cityBlocks.updateLights) cityBlocks.updateLights(cameraSystem.camera);
    if (streetDetails.update) streetDetails.update(cameraSystem.camera);
    lightingSystem.update(cameraSystem.currentPos);
    mapSystem.update();
    audioSystem.update(dt, elapsed, cameraSystem.camera, lightingSystem.activePresetId === 'midnight');
    updateSceneCulling(cameraSystem.camera.position);
    // Traffic collisions can move the player after controller updates; finalize moving hierarchies here.
    for (const root of dynamicRoots) root.updateMatrixWorld();
    multiplayer.after(dt, cameraSystem.camera, now);
    if (artStyle === 'anime') colorGrade.updateArtStyle();

    // Render frame via TSL RenderPipeline (SSR + Bloom)
    renderPipeline.render();
    if (!firstFrameSubmitted) {
      firstFrameSubmitted = true;
      markInit('firstFrame');
      // Keep the loading screen until the GPU has drawn this real street view,
      // including its cascaded shadows and post-processing.
      const device = renderer.backend.device;
      beginLoadingStage('Waiting for graphics to finish the first frame...', 'gpu');
      Promise.resolve(device && device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => {
        markInit('gpu');
        console.log(`[init] ${initTimings.join(', ')}`);
        initTimings = null;
        setLoadingProgress(1);
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
        audioSystem.ready = true;
        window.dispatchEvent(new Event('nyc-playable'));
        multiplayer.startInvite();
      });
    }

    // Telemetry uses wall time, not the clamped simulation step, so slow frames and high-refresh displays report
    // their actual frame rate (updates DOM every 250ms).
    frameCount++;
    fpsTimer += Math.max(0, rawDt);
    if (fpsTimer >= 0.25) {
      const currentFps = Math.round(frameCount / fpsTimer);
      frameCount = 0;
      fpsTimer = 0;

      const activeEnt = controllerManager.getActiveEntity();
      const mode = controllerManager.activeMode;
      const mph = Math.round(Math.abs(activeEnt.speed) * 2.237);
      const altFt = Math.max(0, Math.round(activeEnt.position.y * 3.281));

      if (elFps) {
        elFps.textContent = String(currentFps);
        elFps.className = currentFps >= 50 ? 'fps-ok' : currentFps >= 30 ? 'fps-warn' : 'fps-bad';
      }
      if (elSpeed) elSpeed.textContent = String(mph);
      if (elSpeedMeter) elSpeedMeter.style.transform = `scaleX(${Math.min(1, mph / (mode === 'person' && controllerManager.spiderSuited && controllerManager.selectedPower === 'flash' ? 184 : (topSpeedMph[mode] || 80)))})`;
      if (elAltitude) elAltitude.textContent = altFt.toLocaleString('en-US');
      // The street corner of the player on the follow cameras, of the camera itself on the scenic ones
      const where = cameraSystem.getActivePreset().category === 'follow' ? activeEnt.position : cameraSystem.currentPos;
      renderLocation(getLocationLabel(where.x, where.z));
    }
  });
}

initApp().catch(error => {
  console.error('[init]', error);
  window.dispatchEvent(new Event('nyc-load-error'));
});
