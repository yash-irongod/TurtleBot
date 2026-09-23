import * as THREE from 'three'
import type { LidarPoint, OccupancyGrid, Position2D } from '../../types/robot'

export interface SceneEnvironment {
  root: THREE.Group
  goalBeacon: THREE.Group
  frontierBeacon: THREE.Group
  routeRibbon: THREE.Object3D
  particles: THREE.Points
  lidarPointsCloud: THREE.Points
  setGoalPosition: (pos: Position2D | null) => void
  setFrontierTarget: (pos: Position2D | null) => void
  setRoutePath: (path: Position2D[]) => void
  updateMapGrid: (grid: OccupancyGrid) => void
  updateLidarPoints: (points: LidarPoint[], robotPos: Position2D, headingDeg: number) => void
  update: (dtSec: number, robotPos: Position2D, linearVel: number, cameraPos?: THREE.Vector3) => void
  dispose: () => void
}

/**
 * Creates the cinematic "Planet Titan" alien sky dome:
 * - Deep galactic violet/indigo zenith with distant cosmic stars
 * - Vibrant magenta transition into radiant sunset orange, crimson, and golden horizon
 * - 360° layered volumetric clouds and distant rising industrial smoke plumes
 * - Radiant setting sun on the horizon with anamorphic flare and golden corona
 * - NO dark celestial bodies/terminator shadows (completely eliminates black circle artifacts)
 */
function createTitanSkyDome(): { mesh: THREE.Mesh; texture: THREE.CanvasTexture; photoTexture: THREE.Texture } {
  const width = 2048
  const height = 1024
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!

  // 1. Vertical Cosmic Sunset Dusk Gradient (Titan Avengers reference)
  const skyGrad = ctx.createLinearGradient(0, 0, 0, height)
  skyGrad.addColorStop(0.0, '#06010f') // Deep cosmic zenith space
  skyGrad.addColorStop(0.22, '#150424') // Deep galactic indigo
  skyGrad.addColorStop(0.40, '#2e083d') // Electric royal purple
  skyGrad.addColorStop(0.55, '#5c1048') // Vibrant magenta
  skyGrad.addColorStop(0.68, '#8c1844') // Dusk crimson
  skyGrad.addColorStop(0.80, '#c63810') // Fiery sunset orange
  skyGrad.addColorStop(0.90, '#e56408') // Blazing amber
  skyGrad.addColorStop(1.0, '#ffaa2b') // Radiant golden horizon
  ctx.fillStyle = skyGrad
  ctx.fillRect(0, 0, width, height)

  // 2. Distant Cosmic Stars in the upper deep-sky only (zenith)
  ctx.fillStyle = '#ffffff'
  for (let i = 0; i < 240; i++) {
    const sx = Math.random() * width
    const sy = Math.random() * (height * 0.38)
    const sr = Math.random() * 1.4 + 0.3
    const sa = Math.random() * 0.85 + 0.15
    ctx.globalAlpha = sa
    ctx.beginPath()
    ctx.arc(sx, sy, sr, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1.0

  // 3. 360° Layered Volumetric Sunset Clouds (Concept Art Reference)
  const drawCloudBank = (
    baseY: number,
    colorBase: string,
    colorRim: string,
    numPuffs: number,
    scaleY: number,
  ) => {
    ctx.save()
    for (let i = 0; i < numPuffs; i++) {
      const cx = (i / numPuffs) * width + Math.sin(i * 1.8) * 80
      const cy = baseY + Math.sin(i * 2.5 + 1.2) * 35
      const radX = 90 + Math.abs(Math.sin(i * 3.1)) * 140
      const radY = radX * scaleY

      const cloudGrad = ctx.createRadialGradient(cx, cy - radY * 0.2, radX * 0.15, cx, cy, radX)
      cloudGrad.addColorStop(0, colorRim)
      cloudGrad.addColorStop(0.45, colorBase)
      cloudGrad.addColorStop(1, 'rgba(0,0,0,0)')

      ctx.fillStyle = cloudGrad
      ctx.beginPath()
      ctx.ellipse(cx % width, cy, radX, radY, 0, 0, Math.PI * 2)
      ctx.fill()
      if (cx + radX > width) {
        ctx.beginPath()
        ctx.ellipse((cx % width) - width, cy, radX, radY, 0, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.restore()
  }

  // Upper stratus purple cloud shelves
  drawCloudBank(height * 0.48, 'rgba(92, 16, 72, 0.45)', 'rgba(216, 70, 140, 0.35)', 16, 0.35)
  // Mid magenta/crimson clouds
  drawCloudBank(height * 0.62, 'rgba(140, 24, 68, 0.55)', 'rgba(244, 90, 40, 0.45)', 20, 0.42)
  // Low sunset amber clouds with glowing golden crowns
  drawCloudBank(height * 0.76, 'rgba(198, 56, 16, 0.65)', 'rgba(255, 180, 50, 0.60)', 24, 0.45)

  // 4. Distant Rising Industrial Smoke Plumes (Disaster Wasteland Detail)
  const smokeSpots = [
    { x: width * 0.18, y: height * 0.88, h: 220, tilt: 45 },
    { x: width * 0.42, y: height * 0.86, h: 260, tilt: -35 },
    { x: width * 0.78, y: height * 0.87, h: 200, tilt: 50 },
    { x: width * 0.92, y: height * 0.89, h: 240, tilt: -40 },
  ]
  smokeSpots.forEach(({ x, y, h, tilt }) => {
    ctx.save()
    const smokeGrad = ctx.createLinearGradient(x, y, x + tilt, y - h)
    smokeGrad.addColorStop(0, 'rgba(30, 8, 35, 0.75)')
    smokeGrad.addColorStop(0.5, 'rgba(80, 20, 50, 0.45)')
    smokeGrad.addColorStop(1, 'rgba(150, 40, 40, 0)')
    ctx.fillStyle = smokeGrad

    ctx.beginPath()
    ctx.moveTo(x - 18, y)
    ctx.quadraticCurveTo(x - 10 + tilt * 0.4, y - h * 0.5, x - 55 + tilt, y - h)
    ctx.quadraticCurveTo(x + 55 + tilt, y - h, x + 20 + tilt * 0.4, y - h * 0.5)
    ctx.lineTo(x + 18, y)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  })

  // 5. Setting Sun on Horizon (Vibrant warm solar core, corona, and flare)
  const sunX = width * 0.65
  const sunY = height * 0.82

  const corona = ctx.createRadialGradient(sunX, sunY, 15, sunX, sunY, 340)
  corona.addColorStop(0, 'rgba(255, 255, 240, 0.98)')
  corona.addColorStop(0.12, 'rgba(254, 220, 160, 0.88)')
  corona.addColorStop(0.32, 'rgba(251, 146, 36, 0.65)')
  corona.addColorStop(0.60, 'rgba(225, 29, 72, 0.28)')
  corona.addColorStop(1, 'rgba(159, 18, 57, 0)')
  ctx.fillStyle = corona
  ctx.beginPath()
  ctx.arc(sunX, sunY, 340, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(sunX, sunY, 26, 0, Math.PI * 2)
  ctx.fill()

  const flare = ctx.createLinearGradient(sunX - 520, sunY, sunX + 520, sunY)
  flare.addColorStop(0, 'rgba(255, 237, 213, 0)')
  flare.addColorStop(0.4, 'rgba(255, 247, 237, 0.75)')
  flare.addColorStop(0.5, 'rgba(255, 255, 255, 1.0)')
  flare.addColorStop(0.6, 'rgba(255, 247, 237, 0.75)')
  flare.addColorStop(1, 'rgba(255, 237, 213, 0)')
  ctx.fillStyle = flare
  ctx.fillRect(sunX - 520, sunY - 3, 1040, 6)

  // 6. Atmospheric dusk ground mist band along horizon
  const mist = ctx.createLinearGradient(0, height - 120, 0, height)
  mist.addColorStop(0, 'rgba(251, 146, 60, 0.25)')
  mist.addColorStop(0.5, 'rgba(194, 65, 12, 0.60)')
  mist.addColorStop(1, 'rgba(28, 7, 26, 0.98)')
  ctx.fillStyle = mist
  ctx.fillRect(0, height - 120, width, 120)

  const skyTex = new THREE.CanvasTexture(canvas)
  skyTex.wrapS = THREE.RepeatWrapping
  skyTex.wrapT = THREE.ClampToEdgeWrapping

  const skyGeo = new THREE.SphereGeometry(600, 48, 28)
  const skyMat = new THREE.MeshBasicMaterial({
    map: skyTex,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false, // CRITICAL: Fog must NEVER blacken or clip the sky dome!
  })

  // Load the uploaded disaster sky photo texture seamlessly
  const loader = new THREE.TextureLoader()
  const photoSkyTex = loader.load(
    '/textures/disaster_sky.jpg',
    (tex) => {
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      tex.colorSpace = THREE.SRGBColorSpace
      skyMat.map = tex
      skyMat.needsUpdate = true
    },
    undefined,
    () => {
      // Fallback to high-res procedural canvas gradient already set on skyMat.map
    },
  )

  const skyMesh = new THREE.Mesh(skyGeo, skyMat)

  return { mesh: skyMesh, texture: skyTex, photoTexture: photoSkyTex }
}

/**
 * Creates the rugged, volcanic Titan planetary terrain textures:
 * - Basalt rock crust with warm bronze, purplish-charcoal, and volcanic soil tones
 * - Matte rock roughness (0.86-0.92) to eliminate bright specular glare beneath the robot
 * - Subtle scattered damp depressions that catch the warm sunset specular glints without washing out
 */
function createTitanTerrainTextures(): { diffuse: THREE.CanvasTexture; roughness: THREE.CanvasTexture } {
  const size = 512
  const diffCanvas = document.createElement('canvas')
  diffCanvas.width = size
  diffCanvas.height = size
  const diffCtx = diffCanvas.getContext('2d')!

  const roughCanvas = document.createElement('canvas')
  roughCanvas.width = size
  roughCanvas.height = size
  const roughCtx = roughCanvas.getContext('2d')!

  // Base Titan volcanic crust: warm charcoal bronze with violet undertones
  diffCtx.fillStyle = '#1c131a'
  diffCtx.fillRect(0, 0, size, size)

  roughCtx.fillStyle = '#dfdfdf' // High matte base roughness (~0.88)
  roughCtx.fillRect(0, 0, size, size)

  const imgData = diffCtx.getImageData(0, 0, size, size)
  const roughData = roughCtx.getImageData(0, 0, size, size)
  const pixels = imgData.data
  const rPixels = roughData.data

  for (let i = 0; i < pixels.length; i += 4) {
    const x = (i / 4) % size
    const y = Math.floor(i / 4 / size)

    // Multi-tier procedural rock noise
    const n1 = (Math.sin(x * 0.04) * Math.cos(y * 0.04) + Math.sin(x * 0.09 + y * 0.07)) * 10
    const n2 = (Math.random() - 0.5) * 14

    // Volcanic soil color variation (bronze-purple basalt)
    const baseR = Math.max(16, Math.min(65, 30 + n1 + n2 * 0.6))
    const baseG = Math.max(12, Math.min(48, 20 + n1 * 0.7 + n2 * 0.5))
    const baseB = Math.max(14, Math.min(52, 25 + n1 * 0.9 + n2 * 0.4))

    pixels[i] = baseR
    pixels[i + 1] = baseG
    pixels[i + 2] = baseB

    // Subtle damp depressions (no harsh mirror reflection)
    const puddle = Math.sin(x * 0.032) * Math.cos(y * 0.032) + Math.sin(x * 0.015) * 0.5
    const rVal = puddle > 0.65 ? 135 : Math.min(255, 224 + Math.round(n2 * 2))
    rPixels[i] = rVal
    rPixels[i + 1] = rVal
    rPixels[i + 2] = rVal
  }

  diffCtx.putImageData(imgData, 0, 0)
  roughCtx.putImageData(roughData, 0, 0)

  const diffTex = new THREE.CanvasTexture(diffCanvas)
  diffTex.wrapS = THREE.RepeatWrapping
  diffTex.wrapT = THREE.RepeatWrapping
  diffTex.repeat.set(24, 24)

  const roughTex = new THREE.CanvasTexture(roughCanvas)
  roughTex.wrapS = THREE.RepeatWrapping
  roughTex.wrapT = THREE.RepeatWrapping
  roughTex.repeat.set(24, 24)

  return { diffuse: diffTex, roughness: roughTex }
}

/**
 * Creates the 3D undulating rocky volcanic planetary terrain:
 * - Flat central corridor around (0,0) for reliable ground contact
 * - Rolling volcanic ridges, craters, and crags expanding outward
 * - Matte PBR material completely free of harsh ground glare
 */
function createUndulatingTitanTerrain(): THREE.Mesh {
  const { diffuse, roughness } = createTitanTerrainTextures()
  const terrainGeo = new THREE.PlaneGeometry(120, 120, 96, 96)
  terrainGeo.rotateX(-Math.PI / 2)

  const pos = terrainGeo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const r = Math.hypot(x, z)

    // Keep central navigation arena flat (r < 4.5m)
    if (r < 4.2) {
      pos.setY(i, 0)
      continue
    }

    const blend = Math.min(1, (r - 4.2) / 6.0)

    // Multi-tier natural rolling terrain displacement
    const wave1 = Math.sin(x * 0.1) * Math.cos(z * 0.1) * 0.7
    const wave2 = Math.sin(x * 0.22 + 1.2) * Math.sin(z * 0.2 + 0.8) * 0.4
    const wave3 = (Math.sin(x * 0.045 - 0.7) + Math.cos(z * 0.05 + 1.3)) * 1.5

    // Distant crater depression on one flank
    const craterDist = Math.hypot(x - 24, z + 20)
    const craterDip = craterDist < 16 ? -Math.cos((craterDist / 16) * Math.PI * 0.5) * 1.6 : 0

    // Elevated basalt ridge in the distance
    const ridgeDist = Math.abs(x * 0.8 + z * 0.6 - 28)
    const ridge = ridgeDist < 12 ? Math.cos((ridgeDist / 12) * Math.PI * 0.5) * 1.8 : 0

    const y = (wave1 + wave2 + wave3 + craterDip + ridge) * blend
    pos.setY(i, y)
  }

  terrainGeo.computeVertexNormals()

  const floorMat = new THREE.MeshStandardMaterial({
    map: diffuse,
    roughnessMap: roughness,
    roughness: 0.88,
    metalness: 0.12,
  })

  const mesh = new THREE.Mesh(terrainGeo, floorMat)
  mesh.name = 'Undulating_Titan_Terrain'
  mesh.receiveShadow = true
  return mesh
}

/**
 * Creates the Giant Shattered Alien Warp Ring Structure (Avengers Planet Titan Reference):
 * - Colossal circular ring (radius 18m) emerging at an angle from the distant terrain
 * - Outer segmented alloy armor hull with inner glowing violet warp conduit
 * - Radial structural teeth and fractured endpoints with floating debris chunks
 */
function createShatteredAlienRing(): THREE.Group {
  const group = new THREE.Group()
  group.name = 'Shattered_Alien_Warp_Ring'
  group.position.set(36, 6, -38)
  group.rotation.set(0.32, -0.42, 0.45)

  // Outer segmented metallic alloy hull
  const outerHullGeo = new THREE.TorusGeometry(18, 1.35, 16, 64, Math.PI * 1.55)
  const alloyMat = new THREE.MeshStandardMaterial({
    color: 0x251c2e,
    metalness: 0.85,
    roughness: 0.32,
  })
  const outerHull = new THREE.Mesh(outerHullGeo, alloyMat)
  group.add(outerHull)

  // Inner glowing violet warp conduit ring
  const conduitGeo = new THREE.TorusGeometry(17.1, 0.28, 8, 48, Math.PI * 1.5)
  const conduitMat = new THREE.MeshBasicMaterial({
    color: 0xa855f7,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
  })
  const conduit = new THREE.Mesh(conduitGeo, conduitMat)
  group.add(conduit)

  // Inward radial structural teeth / girders
  const toothGeo = new THREE.BoxGeometry(0.5, 0.35, 2.6)
  const toothMat = new THREE.MeshStandardMaterial({
    color: 0x191220,
    metalness: 0.9,
    roughness: 0.25,
  })

  const toothCount = 20
  for (let i = 0; i < toothCount; i++) {
    const angle = (i / toothCount) * Math.PI * 1.5
    const tooth = new THREE.Mesh(toothGeo, toothMat)
    tooth.position.set(Math.cos(angle) * 16.5, Math.sin(angle) * 16.5, 0)
    tooth.rotation.z = angle + Math.PI / 2
    group.add(tooth)
  }

  // Floating shattered debris chunks hovering near the fractured endpoints
  const debrisGeo = new THREE.DodecahedronGeometry(0.85, 0)
  for (let d = 0; d < 7; d++) {
    const debris = new THREE.Mesh(debrisGeo, alloyMat)
    debris.position.set(
      Math.cos(Math.PI * 1.55) * 18 + (Math.random() - 0.5) * 4,
      Math.sin(Math.PI * 1.55) * 18 + (Math.random() - 0.5) * 4,
      (Math.random() - 0.5) * 4,
    )
    debris.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0)
    debris.scale.setScalar(Math.random() * 0.7 + 0.5)
    group.add(debris)
  }

  return group
}

/**
 * Creates the Ruined Colossal Viaduct / Highway Bridge on the distant horizon:
 * - Colossal weathered support pillars
 * - Sheared double-deck roadway with dangling rebar and rusted metal trusses
 */
function createRuinedViaductBridge(): THREE.Group {
  const group = new THREE.Group()
  group.name = 'Ruined_Viaduct_Bridge'
  group.position.set(-36, 0, -20)
  group.rotation.y = 0.52

  const concreteMat = new THREE.MeshStandardMaterial({
    color: 0x221a28,
    roughness: 0.85,
    metalness: 0.2,
  })

  const pillarGeo = new THREE.BoxGeometry(2.4, 11, 3.4)
  const pillarZ = [-14, 0, 14, 28]
  pillarZ.forEach((pz) => {
    const pillar = new THREE.Mesh(pillarGeo, concreteMat)
    pillar.position.set(0, 5.5, pz)
    group.add(pillar)
  })

  // Overhead roadbed deck
  const deckGeo = new THREE.BoxGeometry(6.5, 1.2, 44)
  const deck = new THREE.Mesh(deckGeo, concreteMat)
  deck.position.set(0, 11.2, 7)
  group.add(deck)

  // Sheared fracture jagged end
  const fractureGeo = new THREE.BoxGeometry(6.4, 1.1, 3.5)
  const fracture = new THREE.Mesh(fractureGeo, concreteMat)
  fracture.position.set(0, 10.7, -16)
  fracture.rotation.x = -0.35
  group.add(fracture)

  // Dangling rusted rebar wires
  const rebarGeo = new THREE.BufferGeometry()
  const rebarVerts = new Float32Array([
    -1.5, 10.5, -17, -1.8, 6.0, -17.5,
    0.0, 10.5, -17.2, 0.2, 5.2, -18.0,
    1.5, 10.5, -17, 1.2, 6.8, -17.4,
  ])
  rebarGeo.setAttribute('position', new THREE.BufferAttribute(rebarVerts, 3))
  const rebarMat = new THREE.LineBasicMaterial({ color: 0x854d0e })
  const rebar = new THREE.LineSegments(rebarGeo, rebarMat)
  group.add(rebar)

  return group
}

/**
 * Creates distant alien refinery communication towers and spires with pulsing beacons
 */
function createIndustrialSpires(): THREE.Group {
  const group = new THREE.Group()
  group.name = 'Distant_Industrial_Spires'

  const towerMat = new THREE.MeshStandardMaterial({
    color: 0x160e1d,
    metalness: 0.8,
    roughness: 0.4,
  })

  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff1744 })
  const beaconGeo = new THREE.SphereGeometry(0.35, 8, 8)

  const towers = [
    { x: 18, z: -44, h: 26 },
    { x: -22, z: -48, h: 22 },
    { x: -4, z: -52, h: 30 },
    { x: -46, z: -38, h: 20 },
  ]

  towers.forEach(({ x, z, h }) => {
    const spireGeo = new THREE.CylinderGeometry(0.2, 1.2, h, 4)
    const spire = new THREE.Mesh(spireGeo, towerMat)
    spire.position.set(x, h / 2, z)
    group.add(spire)

    // Red warning beacon at peak
    const beacon = new THREE.Mesh(beaconGeo, beaconMat)
    beacon.position.set(x, h + 0.3, z)
    group.add(beacon)
  })

  return group
}

/**
 * Creates the Skeletal Industrial Warehouse / Factory Framework with torn banner ("A SAFER TOMORROW")
 * Directly matching the concept art reference.
 */
function createSkeletalFactoryFrame(): THREE.Group {
  const group = new THREE.Group()
  group.name = 'Skeletal_Factory_Framework'
  group.position.set(28, 0, 30)
  group.rotation.y = -0.65

  const steelMat = new THREE.MeshStandardMaterial({
    color: 0x1f1724,
    metalness: 0.85,
    roughness: 0.45,
  })

  // Vertical structural columns (6 steel pillars)
  const colGeo = new THREE.BoxGeometry(0.4, 12, 0.4)
  const colPositions = [
    [-6, 6, -4],
    [-6, 6, 4],
    [6, 6, -4],
    [6, 6, 4],
    [0, 6, -4],
    [0, 6, 4],
  ]
  colPositions.forEach(([cx, cy, cz]) => {
    const col = new THREE.Mesh(colGeo, steelMat)
    col.position.set(cx, cy, cz)
    group.add(col)
  })

  // Horizontal roof tie girders
  const girderLongGeo = new THREE.BoxGeometry(12.4, 0.35, 0.35)
  const girderShortGeo = new THREE.BoxGeometry(0.35, 0.35, 8.4)

  const g1 = new THREE.Mesh(girderLongGeo, steelMat)
  g1.position.set(0, 11.9, -4)
  group.add(g1)
  const g2 = new THREE.Mesh(girderLongGeo, steelMat)
  g2.position.set(0, 11.9, 4)
  group.add(g2)

  const g3 = new THREE.Mesh(girderShortGeo, steelMat)
  g3.position.set(-6, 11.9, 0)
  group.add(g3)
  const g4 = new THREE.Mesh(girderShortGeo, steelMat)
  g4.position.set(6, 11.9, 0)
  group.add(g4)
  const g5 = new THREE.Mesh(girderShortGeo, steelMat)
  g5.position.set(0, 11.9, 0)
  group.add(g5)

  // Roof A-frame truss struts
  const trussGeo = new THREE.BoxGeometry(0.25, 0.25, 5.2)
  const t1 = new THREE.Mesh(trussGeo, steelMat)
  t1.position.set(0, 13.2, -2)
  t1.rotation.x = 0.55
  group.add(t1)
  const t2 = new THREE.Mesh(trussGeo, steelMat)
  t2.position.set(0, 13.2, 2)
  t2.rotation.x = -0.55
  group.add(t2)

  // Torn canvas banner hanging between two pillars ("A SAFER TOMORROW")
  const canvasElem = document.createElement('canvas')
  canvasElem.width = 512
  canvasElem.height = 128
  const bCtx = canvasElem.getContext('2d')!
  bCtx.fillStyle = '#b8a698'
  bCtx.fillRect(0, 0, 512, 128)

  bCtx.fillStyle = 'rgba(40, 20, 30, 0.35)'
  bCtx.fillRect(0, 80, 512, 48)

  bCtx.font = 'bold 38px monospace'
  bCtx.fillStyle = '#1e1122'
  bCtx.textAlign = 'center'
  bCtx.textBaseline = 'middle'
  bCtx.fillText('A SAFER TOMORROW', 256, 54)

  bCtx.font = '14px monospace'
  bCtx.fillStyle = '#78350f'
  bCtx.fillText('CIVIL DISASTER RELIEF SECTOR 4', 256, 92)

  const bannerTex = new THREE.CanvasTexture(canvasElem)
  const bannerMat = new THREE.MeshStandardMaterial({
    map: bannerTex,
    roughness: 0.9,
    side: THREE.DoubleSide,
  })

  const bannerGeo = new THREE.PlaneGeometry(5.6, 1.4, 8, 4)
  const bPos = bannerGeo.attributes.position
  for (let i = 0; i < bPos.count; i++) {
    const vx = bPos.getX(i)
    const sag = Math.sin((vx / 2.8 + 1) * Math.PI * 0.5) * 0.22
    bPos.setZ(i, sag)
  }
  bannerGeo.computeVertexNormals()

  const banner = new THREE.Mesh(bannerGeo, bannerMat)
  banner.position.set(-3, 8.5, -4.05)
  banner.rotation.z = -0.06
  group.add(banner)

  return group
}

/**
 * Creates the collapsed electrical lattice transmission pylon lying across the distant ridgeline
 */
function createCollapsedTransmissionPylon(): THREE.Group {
  const group = new THREE.Group()
  group.name = 'Collapsed_Transmission_Pylon'
  group.position.set(-27, 0.5, 32)
  group.rotation.set(0.12, 0.85, 1.45)

  const rustedMat = new THREE.MeshStandardMaterial({
    color: 0x3d271d,
    metalness: 0.75,
    roughness: 0.65,
  })

  const railLength = 16
  const railGeo = new THREE.BoxGeometry(0.12, railLength, 0.12)

  ;[
    [-1.2, 0, -1.2],
    [1.2, 0, -1.2],
    [-1.2, 0, 1.2],
    [1.2, 0, 1.2],
  ].forEach(([rx, _, rz]) => {
    const rail = new THREE.Mesh(railGeo, rustedMat)
    rail.position.set(rx * 0.7, railLength / 2, rz * 0.7)
    group.add(rail)
  })

  const strutGeo = new THREE.BoxGeometry(0.08, 0.08, 2.0)
  for (let step = 1; step < 8; step++) {
    const sy = step * 2.0
    const s1 = new THREE.Mesh(strutGeo, rustedMat)
    s1.position.set(0, sy, 0)
    s1.rotation.y = Math.PI / 4
    group.add(s1)

    const s2 = new THREE.Mesh(strutGeo, rustedMat)
    s2.position.set(0, sy, 0)
    s2.rotation.y = -Math.PI / 4
    group.add(s2)
  }

  return group
}

/**
 * Creates a low-poly distant mountain ridge encircling the 360° horizon
 */
function createDistantMountainRing(): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(64, 68, 18, 36, 1, true)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    if (y > 0) {
      const theta = Math.atan2(pos.getZ(i), pos.getX(i))
      const jagged = Math.sin(theta * 7) * 4.5 + Math.cos(theta * 13) * 2.8 + Math.sin(theta * 23) * 1.5
      pos.setY(i, y + jagged)
    }
  }
  geo.computeVertexNormals()

  const mat = new THREE.MeshBasicMaterial({
    color: 0x16071d,
    side: THREE.BackSide,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.y = 2.5
  mesh.name = 'Distant_Mountain_Silhouettes'
  return mesh
}

/**
 * Creates hovering distant quadcopter scout drones with blinking LEDs (Concept Art Detail)
 */
function createScoutDrones(): { group: THREE.Group; update: (time: number) => void } {
  const group = new THREE.Group()
  group.name = 'Scout_Drones'

  const droneMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.9, roughness: 0.2 })
  const rotorMat = new THREE.MeshBasicMaterial({
    color: 0x00f0ff,
    transparent: true,
    opacity: 0.45,
    blending: THREE.AdditiveBlending,
  })

  interface DroneInstance {
    mesh: THREE.Group
    baseY: number
    freq: number
  }
  const drones: DroneInstance[] = []

  const spawnDrone = (x: number, y: number, z: number, freq: number) => {
    const dGroup = new THREE.Group()
    dGroup.position.set(x, y, z)

    // Body chassis
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.2, 0.8), droneMat)
    dGroup.add(body)

    // Rotors
    ;[
      [-0.5, 0.12, -0.5],
      [0.5, 0.12, -0.5],
      [-0.5, 0.12, 0.5],
      [0.5, 0.12, 0.5],
    ].forEach(([rx, ry, rz]) => {
      const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.02, 12), rotorMat)
      rotor.position.set(rx, ry, rz)
      dGroup.add(rotor)
    })

    // Forward cyan sensor light
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), new THREE.MeshBasicMaterial({ color: 0x00f0ff }))
    led.position.set(0, -0.05, -0.42)
    dGroup.add(led)

    group.add(dGroup)
    drones.push({ mesh: dGroup, baseY: y, freq })
  }

  spawnDrone(14, 15, -28, 1.8)
  spawnDrone(-18, 13, -22, 1.4)

  const update = (time: number) => {
    drones.forEach(({ mesh, baseY, freq }) => {
      mesh.position.y = baseY + Math.sin(time * freq) * 0.35
      mesh.rotation.y += 0.005
    })
  }

  return { group, update }
}

/**
 * Creates the glowing holographic Warning Waypoint Triangle (`⚠️` hazard marker)
 * requested by the user to replace the old yellow diamond target (Matching uploaded reference photo).
 */
function createHolographicWarningTriangle(): THREE.Group {
  const group = new THREE.Group()
  group.name = 'Holographic_Warning_Triangle_Marker'

  // 1. Triangular Outer Frame
  const shape = new THREE.Shape()
  const r = 0.22 // Circumradius
  const h = r * 1.5

  // Outer equilateral triangle points (pointing up)
  const p1 = { x: 0, y: h * 0.66 }
  const p2 = { x: -r * 1.05, y: -h * 0.34 }
  const p3 = { x: r * 1.05, y: -h * 0.34 }

  shape.moveTo(p1.x, p1.y)
  shape.lineTo(p2.x, p2.y)
  shape.lineTo(p3.x, p3.y)
  shape.closePath()

  // Inner triangular cutout for a hollow neon frame
  const hole = new THREE.Path()
  const inset = 0.042
  hole.moveTo(p1.x, p1.y - inset * 1.6)
  hole.lineTo(p2.x + inset * 1.25, p2.y + inset)
  hole.lineTo(p3.x - inset * 1.25, p3.y + inset)
  hole.closePath()
  shape.holes.push(hole)

  const extrudeSettings: THREE.ExtrudeGeometryOptions = {
    depth: 0.012,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.004,
    bevelSegments: 2,
  }
  const triangleGeo = new THREE.ExtrudeGeometry(shape, extrudeSettings)
  triangleGeo.center()

  const neonRedMat = new THREE.MeshBasicMaterial({
    color: 0xff1744, // Glowing neon crimson
    transparent: true,
    opacity: 0.95,
  })
  const triangleMesh = new THREE.Mesh(triangleGeo, neonRedMat)
  group.add(triangleMesh)

  // Inner translucent warning fill shield
  const innerFillGeo = new THREE.BufferGeometry()
  const vertices = new Float32Array([
    p1.x, p1.y - inset * 1.6, 0,
    p2.x + inset * 1.25, p2.y + inset, 0,
    p3.x - inset * 1.25, p3.y + inset, 0,
  ])
  innerFillGeo.setAttribute('position', new THREE.BufferAttribute(vertices, 3))
  const innerFillMat = new THREE.MeshBasicMaterial({
    color: 0xff1744,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const innerFill = new THREE.Mesh(innerFillGeo, innerFillMat)
  innerFill.position.z = 0.006
  group.add(innerFill)

  // 2. Exclamation Mark ("!")
  // Vertical bar
  const barGeo = new THREE.BoxGeometry(0.018, 0.09, 0.016)
  const barMesh = new THREE.Mesh(barGeo, neonRedMat)
  barMesh.position.set(0, 0.018, 0)
  group.add(barMesh)

  // Centered dot
  const dotGeo = new THREE.BoxGeometry(0.018, 0.018, 0.016)
  const dotMesh = new THREE.Mesh(dotGeo, neonRedMat)
  dotMesh.position.set(0, -0.052, 0)
  group.add(dotMesh)

  // Glowing halo aura around the triangle
  const haloGeo = new THREE.PlaneGeometry(0.58, 0.58)
  const haloCanvas = document.createElement('canvas')
  haloCanvas.width = 128
  haloCanvas.height = 128
  const hCtx = haloCanvas.getContext('2d')!
  const hGrad = hCtx.createRadialGradient(64, 64, 4, 64, 64, 62)
  hGrad.addColorStop(0, 'rgba(255, 23, 68, 0.85)')
  hGrad.addColorStop(0.35, 'rgba(255, 23, 68, 0.45)')
  hGrad.addColorStop(0.75, 'rgba(225, 29, 72, 0.12)')
  hGrad.addColorStop(1, 'rgba(225, 29, 72, 0)')
  hCtx.fillStyle = hGrad
  hCtx.fillRect(0, 0, 128, 128)

  const haloTex = new THREE.CanvasTexture(haloCanvas)
  const haloMat = new THREE.MeshBasicMaterial({
    map: haloTex,
    transparent: true,
    opacity: 0.65,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const halo = new THREE.Mesh(haloGeo, haloMat)
  halo.position.z = -0.005
  group.add(halo)

  return group
}

/**
 * Manages the procedural 3D disaster-zone debris obstacles (Matching uploaded concept art reference):
 * - Concrete Jersey highway barriers with red/white hazard warning chevrons
 * - Overturned corrugated industrial shipping containers (rust red, teal, olive, caution amber)
 * - Clusters of 55-gallon steel fuel/oil drums (some upright, some knocked over in the dirt)
 * - Concrete drainage culvert pipes (hollow cylinders)
 * - Construction traffic safety cones (safety orange with white reflective vinyl bands)
 * - Shattered reinforced concrete foundation slabs with protruding rusted rebar wires
 * - Portable halogen worklight towers casting warm amber illumination onto the terrain
 */
function createDisasterObstacleManager(): {
  group: THREE.Group
  buildObstacles: (grid: OccupancyGrid) => void
  dispose: () => void
} {
  const group = new THREE.Group()
  group.name = 'Disaster_Wasteland_Obstacles_3D'

  // Textures & Materials
  // 1. Concrete Jersey Barrier Texture (Weathered concrete with 45° red & white hazard chevrons)
  const barrierCanvas = document.createElement('canvas')
  barrierCanvas.width = 256
  barrierCanvas.height = 128
  const bCtx = barrierCanvas.getContext('2d')!
  bCtx.fillStyle = '#3a343d'
  bCtx.fillRect(0, 0, 256, 128)

  for (let i = 0; i < 350; i++) {
    bCtx.fillStyle = Math.random() > 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.06)'
    bCtx.fillRect(Math.random() * 256, Math.random() * 128, 2, 2)
  }

  bCtx.save()
  bCtx.beginPath()
  bCtx.rect(0, 32, 256, 64)
  bCtx.clip()
  const stripeW = 24
  for (let x = -60; x < 320; x += stripeW * 2) {
    bCtx.fillStyle = '#dc2626'
    bCtx.beginPath()
    bCtx.moveTo(x, 96)
    bCtx.lineTo(x + 28, 32)
    bCtx.lineTo(x + 28 + stripeW, 32)
    bCtx.lineTo(x + stripeW, 96)
    bCtx.closePath()
    bCtx.fill()

    bCtx.fillStyle = '#f3f4f6'
    bCtx.beginPath()
    bCtx.moveTo(x + stripeW, 96)
    bCtx.lineTo(x + 28 + stripeW, 32)
    bCtx.lineTo(x + 28 + stripeW * 2, 32)
    bCtx.lineTo(x + stripeW * 2, 96)
    bCtx.closePath()
    bCtx.fill()
  }
  bCtx.restore()

  const barrierTex = new THREE.CanvasTexture(barrierCanvas)
  const barrierMat = new THREE.MeshStandardMaterial({
    map: barrierTex,
    roughness: 0.82,
    metalness: 0.12,
  })

  // 2. Corrugated Container Textures & Materials (4 distinct disaster-zone colors)
  const containerColors = [
    { base: '#882222', dark: '#501212', label: 'HAZMAT // 04' },
    { base: '#0e7490', dark: '#083344', label: 'SECTOR RESCUE' },
    { base: '#3f6212', dark: '#1a2e05', label: 'SUPPLY UNIT' },
    { base: '#b45309', dark: '#451a03', label: 'CAUTION // HIGH VOLTAGE' },
  ]
  const containerMats = containerColors.map((cc) => {
    const cCanvas = document.createElement('canvas')
    cCanvas.width = 256
    cCanvas.height = 256
    const ctx = cCanvas.getContext('2d')!
    ctx.fillStyle = cc.base
    ctx.fillRect(0, 0, 256, 256)

    for (let x = 0; x < 256; x += 12) {
      ctx.fillStyle = cc.dark
      ctx.fillRect(x, 0, 4, 256)
      ctx.fillStyle = 'rgba(255,255,255,0.12)'
      ctx.fillRect(x + 4, 0, 3, 256)
    }

    ctx.fillStyle = cc.dark
    ctx.fillRect(0, 0, 256, 14)
    ctx.fillRect(0, 242, 256, 14)
    ctx.fillRect(0, 0, 14, 256)
    ctx.fillRect(242, 0, 14, 256)

    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 12px monospace'
    ctx.fillText(cc.label, 24, 40)
    ctx.font = '10px monospace'
    ctx.fillText('MAX WT 24,000 KG', 24, 58)

    const tex = new THREE.CanvasTexture(cCanvas)
    return new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.65,
      metalness: 0.45,
    })
  })

  // 3. 55-Gallon Steel Oil / Fuel Drum Materials
  const drumYellowMat = new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.55, metalness: 0.65 })
  const drumRedMat = new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.55, metalness: 0.65 })
  const drumBlueMat = new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.55, metalness: 0.65 })
  const drumLidMat = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.75, metalness: 0.5 })

  // 4. Concrete Culvert Pipe Material
  const culvertMat = new THREE.MeshStandardMaterial({ color: 0x47424a, roughness: 0.88, metalness: 0.1 })

  // 5. Traffic Safety Cone Materials
  const coneOrangeMat = new THREE.MeshStandardMaterial({ color: 0xff5500, roughness: 0.5, metalness: 0.05 })
  const coneWhiteMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.3, metalness: 0.1 })
  const coneRubberMat = new THREE.MeshStandardMaterial({ color: 0x1c1917, roughness: 0.9, metalness: 0.1 })

  // 6. Concrete Rebar Slab Material
  const concreteRubbleMat = new THREE.MeshStandardMaterial({ color: 0x38323a, roughness: 0.88, metalness: 0.15 })
  const rebarMat = new THREE.LineBasicMaterial({ color: 0x92400e })

  // 7. Halogen Worklight Tower Materials
  const worklightChassisMat = new THREE.MeshStandardMaterial({ color: 0xeab308, roughness: 0.55, metalness: 0.5 })
  const worklightMastMat = new THREE.MeshStandardMaterial({ color: 0x52525b, metalness: 0.85, roughness: 0.3 })
  const halogenLensMat = new THREE.MeshBasicMaterial({ color: 0xffb703 })

  // Shared Geometries
  const barrierBaseGeo = new THREE.BoxGeometry(0.72, 0.44, 0.26)
  const containerGeo = new THREE.BoxGeometry(1.25, 0.54, 0.54)
  const drumGeo = new THREE.CylinderGeometry(0.14, 0.14, 0.42, 14)
  const drumHoopGeo = new THREE.TorusGeometry(0.142, 0.008, 6, 14)
  const culvertGeo = new THREE.CylinderGeometry(0.26, 0.26, 0.75, 16, 1, true)
  const culvertInnerGeo = new THREE.CylinderGeometry(0.20, 0.20, 0.76, 16, 1, true)
  const coneBaseGeo = new THREE.BoxGeometry(0.22, 0.02, 0.22)
  const coneBodyGeo = new THREE.CylinderGeometry(0.02, 0.10, 0.38, 12)
  const coneBandGeo = new THREE.CylinderGeometry(0.045, 0.075, 0.10, 12)
  const slabGeo = new THREE.BoxGeometry(0.56, 0.24, 0.44)

  // These geometries are unique to individual dynamically generated map obstacles.
  // Shared obstacle geometries/materials above must survive map rebuilds; these must not.
  const dynamicMapGeometries = new Set<THREE.BufferGeometry>()

  const disposeDynamicMapGeometries = () => {
    dynamicMapGeometries.forEach((geometry) => geometry.dispose())
    dynamicMapGeometries.clear()
  }

  // Reusable Builder Functions
  const addJerseyBarrier = (x: number, z: number, angle: number, tilt: number) => {
    const mesh = new THREE.Mesh(barrierBaseGeo, barrierMat)
    mesh.position.set(x, 0.22, z)
    mesh.rotation.y = angle
    mesh.rotation.x = tilt
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
  }

  const addCargoContainer = (x: number, z: number, angle: number, colorIdx: number, tilt: number) => {
    const mat = containerMats[colorIdx % containerMats.length]
    const mesh = new THREE.Mesh(containerGeo, mat)
    mesh.position.set(x, 0.27, z)
    mesh.rotation.y = angle
    mesh.rotation.x = tilt
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
  }

  const addDrumCluster = (x: number, z: number, angle: number, colorIdx: number) => {
    const cluster = new THREE.Group()
    cluster.position.set(x, 0, z)
    cluster.rotation.y = angle

    const mat = colorIdx % 3 === 0 ? drumYellowMat : colorIdx % 3 === 1 ? drumRedMat : drumBlueMat

    const d1 = new THREE.Mesh(drumGeo, mat)
    d1.position.set(0, 0.21, 0)
    d1.castShadow = true
    cluster.add(d1)
    const h1 = new THREE.Mesh(drumHoopGeo, drumLidMat)
    h1.rotation.x = Math.PI / 2
    h1.position.set(0, 0.12, 0)
    d1.add(h1)

    const d2 = new THREE.Mesh(drumGeo, mat)
    d2.position.set(0.24, 0.21, 0.06)
    d2.rotation.z = 0.06
    d2.castShadow = true
    cluster.add(d2)

    const d3 = new THREE.Mesh(drumGeo, mat)
    d3.position.set(-0.16, 0.14, 0.18)
    d3.rotation.x = Math.PI / 2
    d3.rotation.z = 0.35
    d3.castShadow = true
    cluster.add(d3)

    group.add(cluster)
  }

  const addCulvertPipe = (x: number, z: number, angle: number) => {
    const pipeGroup = new THREE.Group()
    pipeGroup.position.set(x, 0.25, z)
    pipeGroup.rotation.y = angle
    pipeGroup.rotation.z = Math.PI / 2

    const outer = new THREE.Mesh(culvertGeo, culvertMat)
    outer.castShadow = true
    pipeGroup.add(outer)
    const inner = new THREE.Mesh(culvertInnerGeo, culvertMat)
    pipeGroup.add(inner)

    group.add(pipeGroup)
  }

  const addSafetyCones = (x: number, z: number) => {
    ;[
      [x - 0.15, z],
      [x + 0.15, z + 0.1],
    ].forEach(([cx, cz]) => {
      const cGroup = new THREE.Group()
      cGroup.position.set(cx, 0, cz)

      const base = new THREE.Mesh(coneBaseGeo, coneRubberMat)
      base.position.y = 0.01
      cGroup.add(base)

      const body = new THREE.Mesh(coneBodyGeo, coneOrangeMat)
      body.position.y = 0.19
      cGroup.add(body)

      const band = new THREE.Mesh(coneBandGeo, coneWhiteMat)
      band.position.y = 0.18
      cGroup.add(band)

      cGroup.castShadow = true
      group.add(cGroup)
    })
  }

  const addShatteredRebarSlab = (x: number, z: number, angle: number) => {
    const slabGroup = new THREE.Group()
    slabGroup.position.set(x, 0.12, z)
    slabGroup.rotation.y = angle

    const slab = new THREE.Mesh(slabGeo, concreteRubbleMat)
    slab.castShadow = true
    slabGroup.add(slab)

    const rebarGeo = new THREE.BufferGeometry()
    dynamicMapGeometries.add(rebarGeo)
    const rVerts = new Float32Array([
      0.28, 0.08, -0.15,  0.55, 0.38, -0.18,
      0.28, 0.02, 0.05,   0.62, 0.22, 0.12,
      0.28, -0.05, 0.16,  0.48, 0.42, 0.22,
      -0.28, 0.06, -0.1,  -0.52, 0.32, -0.15,
    ])
    rebarGeo.setAttribute('position', new THREE.BufferAttribute(rVerts, 3))
    const rebarLines = new THREE.LineSegments(rebarGeo, rebarMat)
    slabGroup.add(rebarLines)

    group.add(slabGroup)
  }

  const addWorklightTower = (x: number, z: number, angle: number) => {
    const tower = new THREE.Group()
    tower.position.set(x, 0, z)
    tower.rotation.y = angle

    const cartGeo = new THREE.BoxGeometry(0.28, 0.18, 0.22)
    dynamicMapGeometries.add(cartGeo)
    const cart = new THREE.Mesh(cartGeo, worklightChassisMat)
    cart.position.y = 0.09
    tower.add(cart)

    const mastGeo = new THREE.CylinderGeometry(0.015, 0.02, 0.85, 8)
    dynamicMapGeometries.add(mastGeo)
    const mast = new THREE.Mesh(mastGeo, worklightMastMat)
    mast.position.y = 0.52
    tower.add(mast)

    const barGeo = new THREE.BoxGeometry(0.32, 0.04, 0.06)
    dynamicMapGeometries.add(barGeo)
    const bar = new THREE.Mesh(barGeo, worklightMastMat)
    bar.position.y = 0.94
    tower.add(bar)

    ;[-0.12, 0.12].forEach((lx) => {
      const lampGeo = new THREE.CylinderGeometry(0.05, 0.04, 0.08, 10)
      dynamicMapGeometries.add(lampGeo)
      const lamp = new THREE.Mesh(lampGeo, worklightChassisMat)
      lamp.position.set(lx, 0.92, 0.04)
      lamp.rotation.x = 0.45
      tower.add(lamp)

      const lensGeo = new THREE.CircleGeometry(0.045, 10)
      dynamicMapGeometries.add(lensGeo)
      const lens = new THREE.Mesh(lensGeo, halogenLensMat)
      lens.position.set(lx, 0.91, 0.08)
      lens.rotation.x = 0.45
      tower.add(lens)
    })

    const light = new THREE.PointLight(0xffaa22, 1.4, 4.0, 1.8)
    light.position.set(0, 0.85, 0.5)
    tower.add(light)

    group.add(tower)
  }

  const buildObstacles = (targetGrid: OccupancyGrid) => {
    disposeDynamicMapGeometries()
    while (group.children.length > 0) {
      const child = group.children[0]
      group.remove(child)
    }

    const w = targetGrid.widthCells
    const h = targetGrid.heightCells
    const res = targetGrid.resolutionM
    const visited = new Uint8Array(w * h)

    let totalSpawned = 0
    const maxObjects = 120

    for (let r = 0; r < h && totalSpawned < maxObjects; r++) {
      for (let c = 0; c < w && totalSpawned < maxObjects; c++) {
        const idx = r * w + c
        if (targetGrid.cells[idx] !== 'occupied' || visited[idx]) continue

        let clusterCount = 0
        let sumX = 0
        let sumZ = 0
        let minC = c
        let maxC = c
        let minR = r
        let maxR = r

        for (let dr = 0; dr <= 3; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const nr = r + dr
            const nc = c + dc
            if (nr >= 0 && nr < h && nc >= 0 && nc < w) {
              const nIdx = nr * w + nc
              if (targetGrid.cells[nIdx] === 'occupied' && !visited[nIdx]) {
                visited[nIdx] = 1
                clusterCount++
                const wx = targetGrid.origin.x + (nc + 0.5) * res
                const wz = targetGrid.origin.y + (nr + 0.5) * res
                sumX += wx
                sumZ += wz
                minC = Math.min(minC, nc)
                maxC = Math.max(maxC, nc)
                minR = Math.min(minR, nr)
                maxR = Math.max(maxR, nr)
              }
            }
          }
        }

        if (clusterCount === 0) continue

        const avgX = sumX / clusterCount
        const avgZ = sumZ / clusterCount
        const spanX = (maxC - minC + 1) * res
        const spanZ = (maxR - minR + 1) * res

        const hash = Math.sin(avgX * 37.1 + avgZ * 91.7) * 43758.5453
        const seed = Math.abs(hash % 1)
        const angle = (seed * Math.PI * 2) % Math.PI
        const tilt = ((hash * 7) % 1) * 0.05

        if (clusterCount >= 5 || spanX > 0.6 || spanZ > 0.6) {
          if (seed > 0.45) {
            const cColor = Math.floor(seed * 10) % containerColors.length
            addCargoContainer(avgX, avgZ, spanX > spanZ ? 0 : Math.PI / 2, cColor, tilt)
          } else {
            addJerseyBarrier(avgX, avgZ, spanX > spanZ ? 0 : Math.PI / 2, tilt)
          }
        } else if (clusterCount >= 3) {
          const pick = Math.floor(seed * 3)
          if (pick === 0) {
            addJerseyBarrier(avgX, avgZ, angle, tilt)
          } else if (pick === 1) {
            addCulvertPipe(avgX, avgZ, angle)
          } else {
            addShatteredRebarSlab(avgX, avgZ, angle)
          }
        } else if (clusterCount >= 2) {
          if (seed > 0.35) {
            addDrumCluster(avgX, avgZ, angle, Math.floor(seed * 7))
          } else {
            addWorklightTower(avgX, avgZ, angle)
          }
        } else {
          if (seed > 0.5) {
            addSafetyCones(avgX, avgZ)
          } else {
            addJerseyBarrier(avgX, avgZ, angle, tilt * 2)
          }
        }

        totalSpawned++
      }
    }
  }

  const dispose = () => {
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
        obj.geometry?.dispose()
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose())
        } else {
          obj.material?.dispose()
        }
      }
    })
    dynamicMapGeometries.clear()
    barrierTex.dispose()
    containerMats.forEach((m) => {
      m.map?.dispose()
      m.dispose()
    })
  }

  return { group, buildObstacles, dispose }
}

/**
 * Builds the complete, cinematic "Planet Titan" environment:
 * - Inverted Titan cosmic sky dome with sunset horizon, layered clouds, and rising smoke
 * - Undulating rocky volcanic basalt terrain (zero blinding glare hotspot under the robot)
 * - Authentic procedural disaster-zone debris obstacles (Jersey barriers, shipping containers, fuel drums, rebar concrete)
 * - 360° horizon megastructures: shattered warp ring, ruined viaduct bridge, factory framework with banner, collapsed transmission pylon, industrial spires
 * - Hovering scout drones in the sky
 * - Holographic Crimson Warning Waypoint Beacon with concentric radar rings and vertical matrix fence
 * - Stepped glowing cyan/purple neon navigation highway path
 * - Volcanic atmospheric ember particles drifting into the sunset sky
 * - Multi-tier cinematic lighting: warm golden sunset key, galactic violet sky hemisphere, electric magenta rim
 */
export function createSceneEnvironment(grid: OccupancyGrid): SceneEnvironment {
  const root = new THREE.Group()
  root.name = 'Titan_Planetary_Environment'

  // 1. Titan Cosmic Sky Dome
  const skyDome = createTitanSkyDome()
  root.add(skyDome.mesh)

  // 2. Undulating Volcanic Basalt Planetary Terrain (No flat grid!)
  const terrain = createUndulatingTitanTerrain()
  root.add(terrain)

  // 3. 360° Surrounding Horizon Megastructures (Concept Art Reference)
  const alienRing = createShatteredAlienRing()
  root.add(alienRing)

  const ruinedBridge = createRuinedViaductBridge()
  root.add(ruinedBridge)

  const industrialSpires = createIndustrialSpires()
  root.add(industrialSpires)

  const factoryFrame = createSkeletalFactoryFrame()
  root.add(factoryFrame)

  const collapsedPylon = createCollapsedTransmissionPylon()
  root.add(collapsedPylon)

  const mountainRing = createDistantMountainRing()
  root.add(mountainRing)

  const scoutDrones = createScoutDrones()
  root.add(scoutDrones.group)

  // 4. Procedural Disaster-Zone Debris Obstacles (Jersey barriers, shipping containers, fuel drums, etc.)
  const obstacleManager = createDisasterObstacleManager()
  obstacleManager.buildObstacles(grid)
  root.add(obstacleManager.group)

  const updateMapGrid = (newGrid: OccupancyGrid) => {
    obstacleManager.buildObstacles(newGrid)
  }

  // 5. Holographic Crimson Warning Waypoint Beacon (Matching User's Photo)
  const goalBeacon = new THREE.Group()
  goalBeacon.name = 'Holographic_Crimson_Warning_Beacon'
  goalBeacon.visible = false

  // A. Concentric Ground Holographic Radar Rings
  const radarGroup = new THREE.Group()
  radarGroup.position.y = 0.008

  const ringRadii = [0.15, 0.35, 0.58, 0.85, 1.15]
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xff1744,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
  })

  ringRadii.forEach((rad) => {
    const rGeo = new THREE.TorusGeometry(rad, 0.0035, 6, 36)
    rGeo.rotateX(Math.PI / 2)
    const ringMesh = new THREE.Mesh(rGeo, ringMat)
    radarGroup.add(ringMesh)
  })

  // Vertical laser matrix grid lines with glowing node sparks at tops (from reference photo)
  const fenceCount = 16
  const fenceGeo = new THREE.BufferGeometry()
  const fencePos = new Float32Array(fenceCount * 6)
  const maxR = ringRadii[ringRadii.length - 1]
  const fenceHeight = 0.32

  const sparkGeo = new THREE.SphereGeometry(0.012, 6, 6)
  const sparkMat = new THREE.MeshBasicMaterial({
    color: 0xff1744,
    blending: THREE.AdditiveBlending,
  })

  for (let f = 0; f < fenceCount; f++) {
    const angle = (f / fenceCount) * Math.PI * 2
    const fx = Math.cos(angle) * maxR
    const fz = Math.sin(angle) * maxR
    const idx = f * 6
    fencePos[idx] = fx
    fencePos[idx + 1] = 0
    fencePos[idx + 2] = fz
    fencePos[idx + 3] = fx
    fencePos[idx + 4] = fenceHeight
    fencePos[idx + 5] = fz

    // Spark node on top of each line
    const sparkNode = new THREE.Mesh(sparkGeo, sparkMat)
    sparkNode.position.set(fx, fenceHeight, fz)
    radarGroup.add(sparkNode)
  }
  fenceGeo.setAttribute('position', new THREE.BufferAttribute(fencePos, 3))
  const fenceMat = new THREE.LineBasicMaterial({
    color: 0xff1744,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
  })
  const fenceLines = new THREE.LineSegments(fenceGeo, fenceMat)
  radarGroup.add(fenceLines)

  // Pulsing expanding radar wave ring
  const pulseRingGeo = new THREE.RingGeometry(0.12, 1.18, 36)
  pulseRingGeo.rotateX(-Math.PI / 2)
  const pulseRingMat = new THREE.MeshBasicMaterial({
    color: 0xff1744,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const pulseWave = new THREE.Mesh(pulseRingGeo, pulseRingMat)
  radarGroup.add(pulseWave)

  goalBeacon.add(radarGroup)

  // B. Central Razor Laser Beam
  const beamHeight = 1.15
  const beamCoreGeo = new THREE.CylinderGeometry(0.005, 0.005, beamHeight, 16, 1, true)
  beamCoreGeo.translate(0, beamHeight / 2, 0)
  const beamCoreMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    blending: THREE.AdditiveBlending,
  })
  const beamCore = new THREE.Mesh(beamCoreGeo, beamCoreMat)
  goalBeacon.add(beamCore)

  const beamAuraGeo = new THREE.CylinderGeometry(0.022, 0.05, beamHeight, 20, 1, true)
  beamAuraGeo.translate(0, beamHeight / 2, 0)
  const beamAuraMat = new THREE.MeshBasicMaterial({
    color: 0xff1744,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const beamAura = new THREE.Mesh(beamAuraGeo, beamAuraMat)
  goalBeacon.add(beamAura)

  // C. Floating Holographic Neon Warning Triangle Marker (`⚠️`)
  const warningTriangle = createHolographicWarningTriangle()
  warningTriangle.position.y = beamHeight
  goalBeacon.add(warningTriangle)

  // Goal point light (vivid neon crimson illumination)
  const goalLight = new THREE.PointLight(0xff1744, 2.8, 4.5, 1.6)
  goalLight.position.set(0, 0.8, 0)
  goalBeacon.add(goalLight)

  root.add(goalBeacon)

  // 6. Holographic Frontier Exploration Beacon (Cyber Cyan/Violet)
  const frontierBeacon = new THREE.Group()
  frontierBeacon.name = 'Frontier_Target_Beacon'
  frontierBeacon.visible = false

  const frontierPillarGeo = new THREE.CylinderGeometry(0.04, 0.16, 6.0, 24, 1, true)
  frontierPillarGeo.translate(0, 3.0, 0)
  const frontierPillarMat = new THREE.MeshBasicMaterial({
    color: 0xa855f7,
    transparent: true,
    opacity: 0.25,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const frontierPillar = new THREE.Mesh(frontierPillarGeo, frontierPillarMat)
  frontierBeacon.add(frontierPillar)

  const frontierDiamondGeo = new THREE.OctahedronGeometry(0.14, 0)
  const frontierDiamondMat = new THREE.MeshStandardMaterial({
    color: 0x06b6d4,
    emissive: 0x0891b2,
    emissiveIntensity: 0.85,
    metalness: 0.2,
    roughness: 0.2,
  })
  const frontierDiamond = new THREE.Mesh(frontierDiamondGeo, frontierDiamondMat)
  frontierDiamond.position.y = 0.85
  frontierBeacon.add(frontierDiamond)

  const frontierLight = new THREE.PointLight(0x06b6d4, 2.2, 4.0, 1.8)
  frontierLight.position.set(0, 0.6, 0)
  frontierBeacon.add(frontierLight)

  root.add(frontierBeacon)

  const setGoalPosition = (pos: Position2D | null) => {
    if (!pos) {
      goalBeacon.visible = false
      return
    }
    goalBeacon.visible = true
    goalBeacon.position.set(pos.x, 0, pos.y)
  }

  const setFrontierTarget = (pos: Position2D | null) => {
    if (!pos) {
      frontierBeacon.visible = false
      return
    }
    frontierBeacon.position.set(pos.x, 0, pos.y)
    frontierBeacon.visible = true
  }

  // 7. Stepped Glowing Neon Navigation Path Pads (Direct Concept Art Style)
  // In the concept art (media_1789913116519.jpg), the path consists of discrete stepped
  // glowing neon rectangular tiles [■] [■] [■] placed across the craggy terrain toward the goal.
  const routeGroup = new THREE.Group()
  routeGroup.name = 'Stepped_Neon_Navigation_Path'
  routeGroup.visible = false
  root.add(routeGroup)

  const padGeo = new THREE.BoxGeometry(0.18, 0.008, 0.12)
  const padRimGeo = new THREE.EdgesGeometry(padGeo)

  const padCenterMat = new THREE.MeshBasicMaterial({
    color: 0x00f0ff,
    transparent: true,
    opacity: 0.88,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })

  const padRimMat = new THREE.LineBasicMaterial({
    color: 0xc084fc,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
  })

  const pathLineMat = new THREE.LineBasicMaterial({
    color: 0x38bdf8,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
  })

  let pathPads: THREE.Group[] = []
  let pathConnectingLine: THREE.Line | null = null

  const setRoutePath = (path: Position2D[]) => {
    // Clear existing pads with proper disposal of unique geometries.
    // Shared materials (padCenterMat, padRimMat, pathLineMat) and shared
    // geometries (padGeo, padRimGeo) are owned by the environment and must NOT be disposed.
    while (routeGroup.children.length > 0) {
      const child = routeGroup.children[0]
      routeGroup.remove(child)
      // Only dispose the connecting line's unique BufferGeometry.
      // Pads use shared padGeo/padRimGeo and shared materials - do not dispose.
      if (child instanceof THREE.Line && child.geometry instanceof THREE.BufferGeometry) {
        child.geometry.dispose()
      }
    }
    pathPads = []
    pathConnectingLine = null

    if (!path || path.length < 2) {
      routeGroup.visible = false
      return
    }

    const pts: THREE.Vector3[] = []
    let totalLen = 0

    for (let i = 0; i < path.length; i++) {
      pts.push(new THREE.Vector3(path[i].x, 0.014, path[i].y))
      if (i > 0) {
        totalLen += pts[i].distanceTo(pts[i - 1])
      }
    }

    if (totalLen < 0.05) {
      routeGroup.visible = false
      return
    }

    const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.25)
    const padSpacing = 0.32
    const numPads = Math.max(2, Math.floor(totalLen / padSpacing))

    // 1. Thin neon connector thread along the curve
    const curvePoints = curve.getPoints(Math.min(120, numPads * 6))
    const lineGeo = new THREE.BufferGeometry().setFromPoints(curvePoints)
    pathConnectingLine = new THREE.Line(lineGeo, pathLineMat)
    routeGroup.add(pathConnectingLine)

    // 2. Discrete stepped rectangular neon tiles [■] [■] [■]
    for (let i = 0; i <= numPads; i++) {
      const u = i / numPads
      const point = curve.getPoint(u)
      const tangent = curve.getTangent(u).normalize()

      const pad = new THREE.Group()
      pad.position.copy(point)
      pad.position.y = 0.012

      // Align pad with curve tangent
      const angleY = Math.atan2(tangent.x, tangent.z)
      pad.rotation.y = angleY + Math.PI / 2

      // Center glowing core tile
      const core = new THREE.Mesh(padGeo, padCenterMat)
      pad.add(core)

      // Neon purple perimeter border
      const rim = new THREE.LineSegments(padRimGeo, padRimMat)
      pad.add(rim)

      routeGroup.add(pad)
      pathPads.push(pad)
    }

    routeGroup.visible = true
  }

  // 8. 360° Real LiDAR Hit Points & Vertical Hazard Slices
  const maxLidarPoints = 720
  const lidarGeo = new THREE.BufferGeometry()
  const lidarPositions = new Float32Array(maxLidarPoints * 3)
  const lidarColors = new Float32Array(maxLidarPoints * 3)
  lidarGeo.setAttribute('position', new THREE.BufferAttribute(lidarPositions, 3))
  lidarGeo.setAttribute('color', new THREE.BufferAttribute(lidarColors, 3))

  const lidarPointMat = new THREE.PointsMaterial({
    vertexColors: true,
    size: 0.075,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const lidarPointsCloud = new THREE.Points(lidarGeo, lidarPointMat)
  lidarPointsCloud.position.y = 0.016
  root.add(lidarPointsCloud)

  const lidarLinesGeo = new THREE.BufferGeometry()
  const lidarLinePositions = new Float32Array(maxLidarPoints * 6)
  const lidarLineColors = new Float32Array(maxLidarPoints * 6)
  lidarLinesGeo.setAttribute('position', new THREE.BufferAttribute(lidarLinePositions, 3))
  lidarLinesGeo.setAttribute('color', new THREE.BufferAttribute(lidarLineColors, 3))

  const lidarLineMat = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const lidarSlices = new THREE.LineSegments(lidarLinesGeo, lidarLineMat)
  root.add(lidarSlices)

  // 9. Atmospheric Sunset Titan Embers & Sparks
  const particleCount = 90
  const particleGeo = new THREE.BufferGeometry()
  const particlePositions = new Float32Array(particleCount * 3)
  const particleColors = new Float32Array(particleCount * 3)

  for (let i = 0; i < particleCount; i++) {
    particlePositions[i * 3] = (Math.random() - 0.5) * 18
    particlePositions[i * 3 + 1] = Math.random() * 0.9 + 0.02
    particlePositions[i * 3 + 2] = (Math.random() - 0.5) * 18

    // Volcanic embers: golden-orange (#ffaa11), fiery crimson (#ef4444), electric violet
    const colorType = Math.random()
    if (colorType < 0.6) {
      particleColors[i * 3] = 1.0 // R
      particleColors[i * 3 + 1] = 0.55 // G
      particleColors[i * 3 + 2] = 0.08 // B (Golden Amber)
    } else if (colorType < 0.85) {
      particleColors[i * 3] = 1.0 // R
      particleColors[i * 3 + 1] = 0.15 // G
      particleColors[i * 3 + 2] = 0.18 // B (Crimson Spark)
    } else {
      particleColors[i * 3] = 0.75 // R
      particleColors[i * 3 + 1] = 0.35 // G
      particleColors[i * 3 + 2] = 1.0 // B (Electric Violet)
    }
  }
  particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3))
  particleGeo.setAttribute('color', new THREE.BufferAttribute(particleColors, 3))

  const particleMat = new THREE.PointsMaterial({
    vertexColors: true,
    size: 0.022,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const particles = new THREE.Points(particleGeo, particleMat)
  root.add(particles)

  // 10. Cinematic Titan Multi-Light Setup (Atmospheric, Rich & Dramatic)
  // Sky Hemisphere Light: Radiant galactic violet sky with warm volcanic amber ground bounce
  const hemiLight = new THREE.HemisphereLight(0x8a2be2, 0x3d140e, 1.25)
  root.add(hemiLight)

  // Ambient fill: subtle warm purple
  const ambientLight = new THREE.AmbientLight(0x3b0764, 0.35)
  root.add(ambientLight)

  // Key light: Setting sun from low angle casting golden sunset shadows
  const keyLight = new THREE.DirectionalLight(0xff8a3d, 2.4)
  keyLight.position.set(16, 9, -20)
  keyLight.castShadow = true
  keyLight.shadow.mapSize.width = 1024
  keyLight.shadow.mapSize.height = 1024
  keyLight.shadow.camera.near = 0.5
  keyLight.shadow.camera.far = 38
  keyLight.shadow.camera.left = -8
  keyLight.shadow.camera.right = 8
  keyLight.shadow.camera.top = 8
  keyLight.shadow.camera.bottom = -8
  keyLight.shadow.bias = -0.0004
  root.add(keyLight)

  // Rim light: Opposite horizon electric magenta highlight
  const rimLight = new THREE.DirectionalLight(0xd946ef, 1.4)
  rimLight.position.set(-15, 6, 18)
  root.add(rimLight)

  // Near-robot warm fill
  const fillLight = new THREE.PointLight(0xffaa66, 0.85, 6.0, 1.8)
  fillLight.position.set(0, 1.2, 0)
  root.add(fillLight)

  // LiDAR point cloud updater
  const updateLidarPoints = (points: LidarPoint[], robotPos: Position2D, headingDeg: number) => {
    const arr = lidarGeo.attributes.position.array as Float32Array
    const col = lidarGeo.attributes.color.array as Float32Array
    const lineArr = lidarLinesGeo.attributes.position.array as Float32Array
    const lineCol = lidarLinesGeo.attributes.color.array as Float32Array

    const headingRad = (headingDeg * Math.PI) / 180

    for (let i = 0; i < maxLidarPoints; i++) {
      if (i < points.length) {
        const pt = points[i]
        const ptAngleRad = (pt.angleDeg * Math.PI) / 180
        const totalAngleRad = headingRad + ptAngleRad

        const ptX = robotPos.x + Math.sin(totalAngleRad) * pt.distanceM
        const ptZ = robotPos.y - Math.cos(totalAngleRad) * pt.distanceM

        // Proximity warning: close obstacles (<0.65m) glowing red/amber, otherwise bright cyan
        const isNear = pt.distanceM < 0.65
        const r = isNear ? 1.0 : 0.22
        const g = isNear ? 0.25 : 0.75
        const b = isNear ? 0.28 : 0.98

        arr[i * 3] = ptX
        arr[i * 3 + 1] = 0.016
        arr[i * 3 + 2] = ptZ

        col[i * 3] = r
        col[i * 3 + 1] = g
        col[i * 3 + 2] = b

        const lIdx = i * 6
        lineArr[lIdx] = ptX
        lineArr[lIdx + 1] = 0.006
        lineArr[lIdx + 2] = ptZ

        lineArr[lIdx + 3] = ptX
        lineArr[lIdx + 4] = isNear ? 0.22 : 0.1
        lineArr[lIdx + 5] = ptZ

        lineCol[lIdx] = r
        lineCol[lIdx + 1] = g
        lineCol[lIdx + 2] = b
        lineCol[lIdx + 3] = r * 0.3
        lineCol[lIdx + 4] = g * 0.3
        lineCol[lIdx + 5] = b * 0.3
      } else {
        arr[i * 3] = 0
        arr[i * 3 + 1] = -100
        arr[i * 3 + 2] = 0

        const lIdx = i * 6
        lineArr[lIdx + 1] = -100
        lineArr[lIdx + 4] = -100
      }
    }
    lidarGeo.attributes.position.needsUpdate = true
    lidarGeo.attributes.color.needsUpdate = true
    lidarLinesGeo.attributes.position.needsUpdate = true
    lidarLinesGeo.attributes.color.needsUpdate = true
  }

  // Animation update loop
  let pulseTime = 0

  const update = (dtSec: number, robotPos: Position2D, linearVel: number) => {
    pulseTime += dtSec

    // Warning Triangle Waypoint Beacon animation
    warningTriangle.rotation.y += dtSec * 1.6
    warningTriangle.position.y = beamHeight + Math.sin(pulseTime * 3.2) * 0.04

    // Pulsing ground radar wave
    const waveProgress = (pulseTime * 0.85) % 1.0
    const waveScale = 0.4 + waveProgress * 0.9
    pulseWave.scale.set(waveScale, waveScale, 1)
    pulseRingMat.opacity = (1 - waveProgress) * 0.55

    // Central beam laser pulse
    beamAura.scale.x = 1 + Math.sin(pulseTime * 6.0) * 0.15
    beamAura.scale.z = beamAura.scale.x

    // Frontier beacon rotation & hover
    if (frontierBeacon.visible) {
      frontierDiamond.rotation.y -= dtSec * 1.8
      frontierDiamond.position.y = 0.85 + Math.sin(pulseTime * 3.0) * 0.05
      frontierPillar.rotation.y -= dtSec * 0.5
    }

    // Stepped path pads pulse wave
    if (routeGroup.visible && pathPads.length > 0) {
      const waveSpeed = 3.5
      pathPads.forEach((pad, idx) => {
        const padPhase = (pulseTime * waveSpeed - idx * 0.25) % (Math.PI * 2)
        const padScale = 1.0 + Math.max(0, Math.sin(padPhase)) * 0.18
        pad.scale.set(padScale, 1.0, padScale)
      })
    }

    // Scout drones animation
    scoutDrones.update(pulseTime)

    // Atmospheric Sunset Titan Embers
    const posArray = particleGeo.attributes.position.array as Float32Array
    const speedFactor = Math.min(1, Math.abs(linearVel) / 0.22)
    const isDriving = Math.abs(linearVel) > 0.02

    for (let i = 0; i < particleCount; i++) {
      posArray[i * 3 + 1] += dtSec * (0.18 + speedFactor * 0.12)
      posArray[i * 3] += dtSec * 0.03
      posArray[i * 3 + 2] -= dtSec * 0.02

      const respawnChance = isDriving ? 0.035 : 0.015
      if (posArray[i * 3 + 1] > 1.6 || Math.random() < respawnChance) {
        const spawnRadius = 9 - speedFactor * 4.0
        const angle = Math.random() * Math.PI * 2
        const r = (Math.random() * 0.7 + 0.08) * spawnRadius

        posArray[i * 3] = robotPos.x + Math.cos(angle) * r
        posArray[i * 3 + 1] = 0.02 + Math.random() * 0.05
        posArray[i * 3 + 2] = robotPos.y + Math.sin(angle) * r
      }
    }
    particleGeo.attributes.position.needsUpdate = true
    particleMat.opacity = isDriving ? 0.55 + speedFactor * 0.35 : 0.45

    // Keep fill light softly illuminating near the robot
    fillLight.position.set(robotPos.x, 1.2, robotPos.y)
  }

  const dispose = () => {
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points || obj instanceof THREE.LineSegments || obj instanceof THREE.Line) {
        obj.geometry?.dispose()
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose())
        } else {
          obj.material?.dispose()
        }
      }
    })
    skyDome.texture.dispose()
    obstacleManager.dispose()
  }

  return {
    root,
    goalBeacon,
    frontierBeacon,
    routeRibbon: routeGroup,
    particles,
    lidarPointsCloud,
    setGoalPosition,
    setFrontierTarget,
    setRoutePath,
    updateMapGrid,
    updateLidarPoints,
    update,
    dispose,
  }
}
