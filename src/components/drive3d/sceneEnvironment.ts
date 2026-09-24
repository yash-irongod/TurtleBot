import * as THREE from 'three'
import type { LidarPoint, OccupancyGrid, Position2D } from '../../types/robot'
import { DEMO_OBSTACLE_ITEMS } from '../../data/mapGrid'

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
 * Creates the 360° Photorealistic Disaster Sky Dome:
 * - Uses the 360° equirectangular disaster panorama (`/textures/disaster_sky.png`)
 * - Perfectly wraps the horizon with ruined bridges, alien ring, galactic cosmos, and fiery sunset
 * - Rotated so the epic glowing sunset horizon faces the robot's forward driving direction
 * - Eliminates any dark celestial circles or terminator artifacts in the forward view
 * - Tracks camera position to maintain an infinite horizon without clipping
 */
function createDisasterSkyDome(loader: THREE.TextureLoader): { mesh: THREE.Mesh; texture: THREE.Texture } {
  const skyGeo = new THREE.SphereGeometry(650, 60, 36)
  skyGeo.scale(-1, 1, 1)

  const skyMat = new THREE.MeshBasicMaterial({
    depthWrite: false,
    fog: false,
    side: THREE.FrontSide,
  })

  const skyTexture = loader.load(
    '/textures/disaster_sky.png',
    (tex) => {
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      tex.colorSpace = THREE.SRGBColorSpace
      skyMat.map = tex
      skyMat.needsUpdate = true
    },
    undefined,
    () => {
      const canvas = document.createElement('canvas')
      canvas.width = 1024
      canvas.height = 512
      const ctx = canvas.getContext('2d')
      if (ctx) {
        const grad = ctx.createLinearGradient(0, 0, 0, 512)
        grad.addColorStop(0, '#0c0217')
        grad.addColorStop(0.4, '#3b0748')
        grad.addColorStop(0.7, '#9f1239')
        grad.addColorStop(0.9, '#ea580c')
        grad.addColorStop(1.0, '#f59e0b')
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, 1024, 512)
        const fallbackTex = new THREE.CanvasTexture(canvas)
        fallbackTex.colorSpace = THREE.SRGBColorSpace
        skyMat.map = fallbackTex
        skyMat.needsUpdate = true
      }
    },
  )

  const skyMesh = new THREE.Mesh(skyGeo, skyMat)
  skyMesh.name = 'Disaster_Sky_Dome_360'
  skyMesh.rotation.y = Math.PI * 0.72

  return { mesh: skyMesh, texture: skyTexture }
}

/**
 * Creates high-detail procedural cracked disaster ground asphalt canvas:
 * - Dark weathered asphalt base with granular aggregate
 * - Deep jagged seismic fracture cracks running across the surface
 * - Chemical / oil spill stains and tire skid marks
 * - Crushed concrete rubble deposits and dust
 */
function createProceduralGroundCanvas(): HTMLCanvasElement {
  const size = 1024
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!

  // 1. Dark weathered industrial asphalt / concrete base
  ctx.fillStyle = '#1c171a'
  ctx.fillRect(0, 0, size, size)

  // 2. Concrete slab expansion joints (256x256 slab grid)
  const slabSize = 256
  for (let sx = 0; sx < size; sx += slabSize) {
    for (let sy = 0; sy < size; sy += slabSize) {
      // Subtle slab-to-slab color tonal variation
      const slabTint = (Math.sin(sx * 12.3 + sy * 45.7) * 0.5 + 0.5) * 12
      ctx.fillStyle = `rgb(${24 + slabTint}, ${20 + slabTint * 0.9}, ${22 + slabTint * 0.8})`
      ctx.fillRect(sx + 2, sy + 2, slabSize - 4, slabSize - 4)
    }
  }

  // Draw dark tar expansion joint seams
  ctx.strokeStyle = '#090609'
  ctx.lineWidth = 4
  ctx.beginPath()
  for (let p = 0; p <= size; p += slabSize) {
    ctx.moveTo(p, 0)
    ctx.lineTo(p, size)
    ctx.moveTo(0, p)
    ctx.lineTo(size, p)
  }
  ctx.stroke()

  // Seam beveled lip highlight
  ctx.strokeStyle = 'rgba(75, 62, 70, 0.45)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let p = 0; p <= size; p += slabSize) {
    ctx.moveTo(p + 2, 0)
    ctx.lineTo(p + 2, size)
    ctx.moveTo(0, p + 2)
    ctx.lineTo(size, p + 2)
  }
  ctx.stroke()

  // 3. Multi-octave granular asphalt aggregate noise & micro-pitting
  const imgData = ctx.getImageData(0, 0, size, size)
  const d = imgData.data
  for (let i = 0; i < d.length; i += 4) {
    const noise = (Math.random() - 0.5) * 28
    const baseR = Math.max(12, Math.min(65, d[i] + noise))
    const baseG = Math.max(10, Math.min(58, d[i + 1] + noise * 0.9))
    const baseB = Math.max(12, Math.min(60, d[i + 2] + noise * 0.85))
    d[i] = baseR
    d[i + 1] = baseG
    d[i + 2] = baseB
  }
  ctx.putImageData(imgData, 0, 0)

  // 4. Deep jagged seismic fracture cracks running across the roadway
  ctx.save()
  const drawCrack = (startX: number, startY: number, length: number, angle: number, mainWidth: number) => {
    let curX = startX
    let curY = startY
    let curAngle = angle
    const segments = Math.floor(length / 16)

    ctx.strokeStyle = '#050305'
    ctx.lineWidth = mainWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    ctx.beginPath()
    ctx.moveTo(curX, curY)
    for (let s = 0; s < segments; s++) {
      curAngle += (Math.random() - 0.5) * 0.65
      const step = 12 + Math.random() * 12
      curX += Math.cos(curAngle) * step
      curY += Math.sin(curAngle) * step
      ctx.lineTo(curX, curY)

      // Micro branching cracks
      if (Math.random() < 0.32 && s > 2) {
        ctx.save()
        ctx.lineWidth = Math.max(1, mainWidth * 0.45)
        ctx.strokeStyle = '#0c080b'
        const bAngle = curAngle + (Math.random() > 0.5 ? 0.78 : -0.78)
        let bx = curX
        let by = curY
        ctx.beginPath()
        ctx.moveTo(bx, by)
        for (let bs = 0; bs < 4; bs++) {
          bx += Math.cos(bAngle) * 11
          by += Math.sin(bAngle) * 11
          ctx.lineTo(bx, by)
        }
        ctx.stroke()
        ctx.restore()
      }
    }
    ctx.stroke()

    // Highlight raised fractured concrete lip
    ctx.strokeStyle = 'rgba(115, 96, 108, 0.45)'
    ctx.lineWidth = 1.2
    ctx.stroke()
  }

  drawCrack(80, 0, 980, Math.PI * 0.46, 5.0)
  drawCrack(0, 360, 850, Math.PI * 0.14, 4.2)
  drawCrack(480, 0, 820, Math.PI * 0.58, 3.8)
  drawCrack(880, 120, 750, Math.PI * 0.74, 3.5)
  drawCrack(180, 780, 640, -Math.PI * 0.16, 3.2)
  drawCrack(600, 600, 420, Math.PI * 0.82, 3.0)
  ctx.restore()

  // 5. Disaster chemical / petroleum spill stains
  const stains = [
    { x: 310, y: 420, rx: 120, ry: 80, angle: 0.35 },
    { x: 760, y: 260, rx: 95, ry: 65, angle: -0.55 },
    { x: 540, y: 800, rx: 150, ry: 90, angle: 0.22 },
    { x: 170, y: 840, rx: 85, ry: 55, angle: 0.75 },
    { x: 820, y: 700, rx: 70, ry: 45, angle: -0.3 },
  ]
  stains.forEach(({ x, y, rx, ry, angle }) => {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle)
    const grad = ctx.createRadialGradient(0, 0, 8, 0, 0, rx)
    grad.addColorStop(0, 'rgba(6, 4, 7, 0.75)')
    grad.addColorStop(0.5, 'rgba(15, 10, 14, 0.45)')
    grad.addColorStop(1, 'rgba(15, 10, 14, 0)')
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  })

  // 6. Heavy tire skid marks
  ctx.save()
  ctx.strokeStyle = 'rgba(10, 7, 9, 0.42)'
  ctx.lineWidth = 14
  ctx.beginPath()
  ctx.moveTo(90, 210)
  ctx.bezierCurveTo(330, 250, 610, 200, 930, 300)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(105, 235)
  ctx.bezierCurveTo(345, 275, 625, 225, 945, 325)
  ctx.stroke()
  ctx.restore()

  // 7. Light rubble / dust wash along seams
  ctx.save()
  ctx.fillStyle = 'rgba(55, 44, 38, 0.15)'
  for (let i = 0; i < 24; i++) {
    const rx = Math.random() * size
    const ry = Math.random() * size
    const rrad = 20 + Math.random() * 45
    ctx.beginPath()
    ctx.arc(rx, ry, rrad, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()

  return canvas
}

/**
 * Creates the undulating disaster terrain floor:
 * - Natural rolling relief outside the central arena (r < 4.2m)
 * - Checks for user-provided `/textures/ground_texture.png` or falls back to procedural cracked asphalt
 * - Scaled naturally (repeat 6x6) so cracks, aggregate, and stains look true to life
 */
function createDisasterTerrain(loader: THREE.TextureLoader): THREE.Mesh {
  const terrainGeo = new THREE.PlaneGeometry(130, 130, 96, 96)
  terrainGeo.rotateX(-Math.PI / 2)

  const pos = terrainGeo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const r = Math.hypot(x, z)

    // Flat navigation arena around center for solid robot contact
    if (r < 4.2) {
      pos.setY(i, 0)
      continue
    }

    const blend = Math.min(1, (r - 4.2) / 6.0)
    const wave1 = Math.sin(x * 0.1) * Math.cos(z * 0.1) * 0.60
    const wave2 = Math.sin(x * 0.22 + 1.2) * Math.sin(z * 0.2 + 0.8) * 0.30
    const wave3 = (Math.sin(x * 0.045 - 0.7) + Math.cos(z * 0.05 + 1.3)) * 1.2

    const craterDist = Math.hypot(x - 24, z + 20)
    const craterDip = craterDist < 16 ? -Math.cos((craterDist / 16) * Math.PI * 0.5) * 1.4 : 0
    const ridgeDist = Math.abs(x * 0.8 + z * 0.6 - 28)
    const ridge = ridgeDist < 12 ? Math.cos((ridgeDist / 12) * Math.PI * 0.5) * 1.5 : 0

    pos.setY(i, (wave1 + wave2 + wave3 + craterDip + ridge) * blend)
  }

  terrainGeo.computeVertexNormals()

  // Base procedural cracked asphalt texture
  const proceduralCanvas = createProceduralGroundCanvas()
  const groundTex = new THREE.CanvasTexture(proceduralCanvas)
  groundTex.wrapS = THREE.RepeatWrapping
  groundTex.wrapT = THREE.RepeatWrapping
  groundTex.repeat.set(6, 6)
  groundTex.colorSpace = THREE.SRGBColorSpace

  const floorMat = new THREE.MeshStandardMaterial({
    map: groundTex,
    roughness: 0.90,
    metalness: 0.10,
  })

  // Attempt to load user-generated ground texture if available in public/textures/ground_texture.png
  loader.load(
    '/textures/ground_texture.png',
    (tex) => {
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.RepeatWrapping
      tex.repeat.set(6, 6)
      tex.colorSpace = THREE.SRGBColorSpace
      floorMat.map = tex
      floorMat.needsUpdate = true
    },
    undefined,
    () => {
      // Procedural canvas texture already active
    },
  )

  const mesh = new THREE.Mesh(terrainGeo, floorMat)
  mesh.name = 'Disaster_Terrain_Floor'
  mesh.receiveShadow = true
  return mesh
}

/**
 * Creates the glowing holographic Warning Waypoint Triangle (`⚠️` hazard marker)
 * Matching the user's uploaded reference photo.
 */
function createHolographicWarningTriangle(): THREE.Group {
  const group = new THREE.Group()
  group.name = 'Holographic_Warning_Triangle_Marker'

  const shape = new THREE.Shape()
  const r = 0.22
  const h = r * 1.5

  const p1 = { x: 0, y: h * 0.66 }
  const p2 = { x: -r * 1.05, y: -h * 0.34 }
  const p3 = { x: r * 1.05, y: -h * 0.34 }

  shape.moveTo(p1.x, p1.y)
  shape.lineTo(p2.x, p2.y)
  shape.lineTo(p3.x, p3.y)
  shape.closePath()

  const hole = new THREE.Path()
  const inset = 0.042
  hole.moveTo(p1.x, p1.y - inset * 1.6)
  hole.lineTo(p2.x + inset * 1.25, p2.y + inset)
  hole.lineTo(p3.x - inset * 1.25, p3.y + inset)
  hole.closePath()
  shape.holes.push(hole)

  const triangleGeo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.012,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.004,
    bevelSegments: 2,
  })
  triangleGeo.center()

  const neonRedMat = new THREE.MeshBasicMaterial({
    color: 0xff1744,
    transparent: true,
    opacity: 0.95,
  })
  const triangleMesh = new THREE.Mesh(triangleGeo, neonRedMat)
  group.add(triangleMesh)

  // Inner translucent fill shield
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
    opacity: 0.18,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const innerFill = new THREE.Mesh(innerFillGeo, innerFillMat)
  innerFill.position.z = 0.006
  group.add(innerFill)

  // Exclamation Mark ("!")
  const barGeo = new THREE.BoxGeometry(0.018, 0.09, 0.016)
  const barMesh = new THREE.Mesh(barGeo, neonRedMat)
  barMesh.position.set(0, 0.018, 0)
  group.add(barMesh)

  const dotGeo = new THREE.BoxGeometry(0.018, 0.018, 0.016)
  const dotMesh = new THREE.Mesh(dotGeo, neonRedMat)
  dotMesh.position.set(0, -0.052, 0)
  group.add(dotMesh)

  // Glowing halo aura
  const haloGeo = new THREE.PlaneGeometry(0.58, 0.58)
  const haloCanvas = document.createElement('canvas')
  haloCanvas.width = 128
  haloCanvas.height = 128
  const hCtx = haloCanvas.getContext('2d')
  if (hCtx) {
    const hGrad = hCtx.createRadialGradient(64, 64, 4, 64, 64, 62)
    hGrad.addColorStop(0, 'rgba(255, 23, 68, 0.85)')
    hGrad.addColorStop(0.35, 'rgba(255, 23, 68, 0.45)')
    hGrad.addColorStop(0.75, 'rgba(225, 29, 72, 0.12)')
    hGrad.addColorStop(1, 'rgba(225, 29, 72, 0)')
    hCtx.fillStyle = hGrad
    hCtx.fillRect(0, 0, 128, 128)
  }
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
 * Realistic Disaster Arena Obstacle Manager:
 * - Creates static, solid, stationary 3D assets:
 *   * 55-gallon oil drum with exact UV-mapped HAZMAT label and top bung hole lid (`drum_texture.png`)
 *   * Shattered reinforced concrete foundation slabs with protruding rusted rebar rods (`slab_texture.png`)
 *   * Corrugated culvert drainage pipe protruding out of the ground at a tilted angle (`pipe_texture.png`)
 *   * Construction traffic safety cone with reflective band and tire scuffs (`cone_texture.png`)
 * - In DEMO mode: Renders exactly the few requested distinct items (fallen drum, slabs, cone, tilted pipe, upright drum).
 * - In LIVE mode: Maps SLAM occupied cells to realistic 3D assets.
 * - All objects remain 100% stationary and pinned in world coordinates.
 */
function createRealTimeObstacleManager(loader: THREE.TextureLoader) {
  const rootGroup = new THREE.Group()
  rootGroup.name = 'Disaster_Arena_Obstacles'

  // 1. Textures
  const drumTex = loader.load('/textures/drum_texture.png', (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace
  })

  const slabTex = loader.load('/textures/slab_texture.png', (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
  })

  const pipeTex = loader.load('/textures/pipe_texture.png', (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.ClampToEdgeWrapping
  })

  const coneTex = loader.load('/textures/cone_texture.png', (tex) => {
    tex.colorSpace = THREE.SRGBColorSpace
  })

  // 2. PBR Materials
  const drumMat = new THREE.MeshStandardMaterial({
    map: drumTex,
    roughness: 0.52,
    metalness: 0.65,
  })

  const slabMat = new THREE.MeshStandardMaterial({
    map: slabTex,
    roughness: 0.88,
    metalness: 0.12,
  })

  const rebarMat = new THREE.MeshStandardMaterial({
    color: 0x854d0e,
    roughness: 0.58,
    metalness: 0.82,
  })

  const pipeMat = new THREE.MeshStandardMaterial({
    map: pipeTex,
    roughness: 0.45,
    metalness: 0.70,
    side: THREE.DoubleSide,
  })

  const pipeInteriorMat = new THREE.MeshStandardMaterial({
    color: 0x1a1412,
    roughness: 0.92,
    metalness: 0.25,
    side: THREE.BackSide,
  })

  const coneMat = new THREE.MeshStandardMaterial({
    map: coneTex,
    roughness: 0.45,
    metalness: 0.15,
    side: THREE.DoubleSide,
  })

  // 3. Exact Geometry Builders with True Texture UV Remapping

  /** 55-Gallon Drum: Vertices 0..49 side wrap, 50..98 top bung lid, 99..147 bottom base */
  const createDrumGeometry = (radius = 0.105, height = 0.32): THREE.BufferGeometry => {
    const geo = new THREE.CylinderGeometry(radius, radius, height, 24, 1, false)
    const uvAttr = geo.attributes.uv

    // Group 0: Cylinder side wall (vertices 0 to 49)
    // origU in [0, 1] wraps around cylinder circumference
    // origV in [0, 1] where 0 is bottom, 1 is top
    // drum_texture.png side wrap rect: u in [0.006, 0.992], v in [0.482, 0.992]
    for (let i = 0; i <= 49; i++) {
      const origU = uvAttr.getX(i)
      const origV = uvAttr.getY(i)
      uvAttr.setXY(i, 0.006 + origU * (0.992 - 0.006), 0.482 + origV * (0.992 - 0.482))
    }

    // Group 1: Top cap circle with bung hole (vertices 50 to 98)
    // In Three.js CylinderGeometry, cap vertices have origU & origV in [0, 1] centered at (0.5, 0.5)
    // Circle 1 in drum_texture.png: center=(0.228, 0.254), radius=0.215
    const topCenterU = 0.228
    const topCenterV = 0.254
    const capRadiusUV = 0.215
    for (let i = 50; i <= 98; i++) {
      const origU = uvAttr.getX(i)
      const origV = uvAttr.getY(i)
      uvAttr.setXY(i, topCenterU + (origU - 0.5) * (2 * capRadiusUV), topCenterV + (origV - 0.5) * (2 * capRadiusUV))
    }

    // Group 2: Bottom cap circle (vertices 99 to 147)
    // Circle 2 in drum_texture.png: center=(0.658, 0.254), radius=0.215
    const botCenterU = 0.658
    const botCenterV = 0.254
    for (let i = 99; i <= 147; i++) {
      const origU = uvAttr.getX(i)
      const origV = uvAttr.getY(i)
      uvAttr.setXY(i, botCenterU + (origU - 0.5) * (2 * capRadiusUV), botCenterV + (origV - 0.5) * (2 * capRadiusUV))
    }

    uvAttr.needsUpdate = true
    return geo
  }

  const drumGeo = createDrumGeometry()

  /** 1. Fallen 55-Gallon Hazmat Drum lying on its side in the rubble */
  const createFallenDrum = (x: number, z: number, angle = 0.4, roll = 0.25): THREE.Group => {
    const group = new THREE.Group()
    group.position.set(x, 0.105, z)
    group.rotation.y = angle
    group.rotation.z = Math.PI / 2
    group.rotation.x = roll

    const mesh = new THREE.Mesh(drumGeo, drumMat)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)

    // Rubble chunks beneath the fallen drum
    const chunkGeo = new THREE.DodecahedronGeometry(0.025, 0)
    ;[
      [-0.10, -0.08, 0.08],
      [0.12, -0.08, -0.07],
      [0.01, -0.085, 0.10],
    ].forEach(([cx, cy, cz]) => {
      const chunk = new THREE.Mesh(chunkGeo, slabMat)
      chunk.position.set(cx, cy, cz)
      group.add(chunk)
    })

    return group
  }

  /** Upright 55-Gallon Weathered Fuel Drum */
  const createUprightDrum = (x: number, z: number, angle = 0, tilt = 0): THREE.Group => {
    const group = new THREE.Group()
    group.position.set(x, 0.16, z)
    group.rotation.y = angle
    group.rotation.x = tilt

    const mesh = new THREE.Mesh(drumGeo, drumMat)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)

    return group
  }

  /** 2. Shattered Concrete Slab with Exposed Steel Rebar Rods */
  const createSlabWithRebar = (x: number, z: number, width = 0.44, height = 0.13, depth = 0.30, angle = 0): THREE.Group => {
    const group = new THREE.Group()
    group.position.set(x, 0, z)
    group.rotation.y = angle

    const slabGeo = new THREE.BoxGeometry(width, height, depth)
    const slabMesh = new THREE.Mesh(slabGeo, slabMat)
    slabMesh.position.y = height / 2
    slabMesh.castShadow = true
    slabMesh.receiveShadow = true
    group.add(slabMesh)

    // Exposed jagged rusted steel rebar wires
    const rebarGeo = new THREE.CylinderGeometry(0.0035, 0.0035, 0.14, 6)
    const rebarConfigs = [
      { rx: width * 0.5 + 0.04, ry: height * 0.65, rz: depth * 0.2, rotZ: -0.45, rotY: 0.2 },
      { rx: width * 0.5 + 0.05, ry: height * 0.35, rz: -depth * 0.25, rotZ: -0.6, rotY: -0.3 },
      { rx: -width * 0.5 - 0.04, ry: height * 0.5, rz: depth * 0.15, rotZ: 0.5, rotY: 0.15 },
      { rx: -width * 0.5 - 0.035, ry: height * 0.3, rz: -depth * 0.2, rotZ: 0.35, rotY: -0.4 },
    ]
    rebarConfigs.forEach(({ rx, ry, rz, rotZ, rotY }) => {
      const rod = new THREE.Mesh(rebarGeo, rebarMat)
      rod.position.set(rx, ry, rz)
      rod.rotation.set(0, rotY, rotZ)
      rod.castShadow = true
      group.add(rod)
    })

    // Rubble debris chunks
    const chunkGeo = new THREE.DodecahedronGeometry(0.025, 0)
    ;[
      [-width * 0.45, 0.025, depth * 0.55],
      [width * 0.48, 0.025, depth * 0.50],
      [width * 0.40, 0.02, -depth * 0.55],
    ].forEach(([cx, cy, cz]) => {
      const chunk = new THREE.Mesh(chunkGeo, slabMat)
      chunk.position.set(cx, cy, cz)
      chunk.scale.set(1.2, 0.6, 0.9)
      group.add(chunk)
    })

    return group
  }

  /** 3. Traffic Safety Cone (with square rubber base and honeycomb reflective bands) */
  const createSafetyConeGroup = (x: number, z: number, angle = 0): THREE.Group => {
    const group = new THREE.Group()
    group.position.set(x, 0, z)
    group.rotation.y = angle

    // Upright cone
    const upright = new THREE.Group()
    const baseGeo = new THREE.BoxGeometry(0.16, 0.014, 0.16)
    const bUV = baseGeo.attributes.uv
    for (let i = 0; i < bUV.count; i++) {
      bUV.setXY(i, 0.52 + bUV.getX(i) * 0.42, 0.56 + bUV.getY(i) * 0.42)
    }
    bUV.needsUpdate = true

    const baseMesh = new THREE.Mesh(baseGeo, coneMat)
    baseMesh.position.y = 0.007
    baseMesh.castShadow = true
    upright.add(baseMesh)

    const coneGeo = new THREE.CylinderGeometry(0.016, 0.075, 0.25, 20, 1, true)
    const cUV = coneGeo.attributes.uv
    for (let i = 0; i < cUV.count; i++) {
      cUV.setXY(i, 0.01 + cUV.getX(i) * 0.52, 0.05 + cUV.getY(i) * 0.45)
    }
    cUV.needsUpdate = true

    const coneMesh = new THREE.Mesh(coneGeo, coneMat)
    coneMesh.position.y = 0.139
    coneMesh.castShadow = true
    upright.add(coneMesh)
    group.add(upright)

    // Knocked-over fallen cone beside it
    const fallen = upright.clone()
    fallen.position.set(0.18, 0.025, 0.07)
    fallen.rotation.z = Math.PI / 2.05
    fallen.rotation.y = 0.65
    group.add(fallen)

    return group
  }

  /** 4. Corrugated Drainage Pipe Protruding from Ground at Tilted Angle */
  const createTiltedEmergingPipe = (
    x: number,
    z: number,
    radius = 0.13,
    length = 0.65,
    tiltAngle = 0.52,
    rotY = -0.35,
  ): THREE.Group => {
    const group = new THREE.Group()
    group.position.set(x, 0, z)
    group.rotation.y = rotY

    // Pitch pipe upward coming out of subterranean breach
    const pipeAssembly = new THREE.Group()
    pipeAssembly.position.set(0, 0.03, 0)
    pipeAssembly.rotation.x = tiltAngle

    // Outer corrugated cylinder
    const pipeGeo = new THREE.CylinderGeometry(radius, radius, length, 24, 1, true)
    const pipeMesh = new THREE.Mesh(pipeGeo, pipeMat)
    pipeMesh.position.y = length * 0.35
    pipeMesh.castShadow = true
    pipeMesh.receiveShadow = true
    pipeAssembly.add(pipeMesh)

    // Inner dark hollow interior
    const innerGeo = new THREE.CylinderGeometry(radius * 0.94, radius * 0.94, length * 1.01, 24, 1, true)
    const innerMesh = new THREE.Mesh(innerGeo, pipeInteriorMat)
    innerMesh.position.y = length * 0.35
    pipeAssembly.add(innerMesh)

    // End rim on exposed mouth
    const rimGeo = new THREE.TorusGeometry(radius, 0.008, 6, 24)
    rimGeo.rotateX(Math.PI / 2)
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x4a3828, roughness: 0.6, metalness: 0.7 })
    const rim = new THREE.Mesh(rimGeo, rimMat)
    rim.position.set(0, length * 0.85, 0)
    pipeAssembly.add(rim)

    group.add(pipeAssembly)

    // Concrete rubble collar surrounding the pipe breach in the ground
    const collarGeo = new THREE.DodecahedronGeometry(0.035, 0)
    const collarCount = 7
    for (let c = 0; c < collarCount; c++) {
      const a = (c / collarCount) * Math.PI * 2
      const cx = Math.cos(a) * (radius + 0.05)
      const cz = Math.sin(a) * (radius + 0.05)
      const chunk = new THREE.Mesh(collarGeo, slabMat)
      chunk.position.set(cx, 0.02, cz)
      chunk.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0)
      group.add(chunk)
    }

    return group
  }

  /** 5. Solid Concrete Jersey Barrier / Wall Block */
  const createSolidConcreteBarrier = (
    x: number,
    z: number,
    length = 0.55,
    height = 0.16,
    width = 0.22,
    angle = 0,
  ): THREE.Group => {
    const group = new THREE.Group()
    group.position.set(x, height / 2, z)
    group.rotation.y = angle

    const geo = new THREE.BoxGeometry(length, height, width)
    const mesh = new THREE.Mesh(geo, slabMat)
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)

    return group
  }

  // Set of instantiated live obstacle positions in world space (to avoid duplicate meshes)
  const liveObstacleKeys = new Set<string>()

  /**
   * Builds the clean, sparse disaster arena obstacles.
   */
  const buildMappedObstacles = (grid: OccupancyGrid) => {
    while (rootGroup.children.length > 0) {
      const child = rootGroup.children[0]
      rootGroup.remove(child)
    }
    liveObstacleKeys.clear()

    // Check if this is the demo grid (or demo mode)
    const isDemo = grid.widthCells === 60 && grid.heightCells === 40

    if (isDemo) {
      // Build exactly the clean, sparse disaster items requested by user
      for (const item of DEMO_OBSTACLE_ITEMS) {
        let obj: THREE.Group
        if (item.type === 'fallen_drum') {
          obj = createFallenDrum(item.x, item.y, 0.5, 0.22)
        } else if (item.type === 'slab') {
          obj = createSlabWithRebar(item.x, item.y, 0.44, 0.13, 0.30, item.id === 'obs-slab-1' ? 0.35 : -0.5)
        } else if (item.type === 'cone') {
          obj = createSafetyConeGroup(item.x, item.y, 0.2)
        } else if (item.type === 'tilted_pipe') {
          obj = createTiltedEmergingPipe(item.x, item.y, 0.13, 0.65, 0.52, -0.45)
        } else {
          obj = createUprightDrum(item.x, item.y, 0.1, 0.04)
        }
        rootGroup.add(obj)
      }

      return
    }

    // LIVE mode: Build solid 3D textured assets from SLAM occupied cells
    const w = grid.widthCells
    const h = grid.heightCells
    const res = grid.resolutionM
    const visited = new Uint8Array(w * h)

    let totalSpawned = 0
    const maxObjects = 35

    for (let r = 0; r < h && totalSpawned < maxObjects; r++) {
      for (let c = 0; c < w && totalSpawned < maxObjects; c++) {
        const idx = r * w + c
        if (grid.cells[idx] !== 'occupied' || visited[idx]) continue

        let clusterCount = 0
        let sumX = 0
        let sumZ = 0
        let minC = c
        let maxC = c
        let minR = r
        let maxR = r

        // Flood search local 7x7 neighborhood (~0.35m cluster)
        for (let dr = -3; dr <= 3; dr++) {
          for (let dc = -3; dc <= 3; dc++) {
            const nr = r + dr
            const nc = c + dc
            if (nr >= 0 && nr < h && nc >= 0 && nc < w) {
              const nIdx = nr * w + nc
              if (grid.cells[nIdx] === 'occupied' && !visited[nIdx]) {
                visited[nIdx] = 1
                clusterCount++
                const wx = grid.origin.x + (nc + 0.5) * res
                const wz = grid.origin.y + (nr + 0.5) * res
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

        // Filter isolated 1-cell sensor speckle noise
        if (clusterCount < 2) continue

        const avgX = sumX / clusterCount
        const avgZ = sumZ / clusterCount

        // Arena boundary is strictly handled by the futuristic translucent shield - never spawn boundary obstacles!
        if (Math.abs(avgX) >= 2.9 || Math.abs(avgZ) >= 1.8) continue

        const spanX = (maxC - minC + 1) * res
        const spanZ = (maxR - minR + 1) * res
        const hash = Math.sin(avgX * 37.1 + avgZ * 91.7) * 43758.5453
        const seed = Math.abs(hash % 1)
        const angle = (seed * Math.PI * 2) % Math.PI

        let obj: THREE.Group
        if (spanX > 0.6 || spanZ > 0.6) {
          // Elongated interior partition segment: spawn solid concrete barrier block
          const wallAngle = spanX >= spanZ ? 0 : Math.PI / 2
          obj = createSolidConcreteBarrier(avgX, avgZ, Math.min(0.65, Math.max(spanX, spanZ)), 0.16, 0.22, wallAngle)
        } else if (clusterCount >= 6) {
          if (seed > 0.5) {
            obj = createSlabWithRebar(avgX, avgZ, 0.44, 0.13, 0.30, angle)
          } else {
            obj = createTiltedEmergingPipe(avgX, avgZ, 0.13, 0.65, 0.52, angle)
          }
        } else if (clusterCount >= 3) {
          if (seed > 0.5) {
            obj = createFallenDrum(avgX, avgZ, angle, seed * 0.3)
          } else {
            obj = createUprightDrum(avgX, avgZ, angle, 0.04)
          }
        } else {
          obj = createSafetyConeGroup(avgX, avgZ, angle)
        }

        rootGroup.add(obj)
        const key = `${avgX.toFixed(1)},${avgZ.toFixed(1)}`
        liveObstacleKeys.add(key)
        totalSpawned++
      }
    }
  }

  /**
   * Real-time live obstacle detector:
   * When in LIVE mode and SLAM /map is not yet publishing dense obstacles,
   * clusters persistent LiDAR returns in world space to instantiate solid 3D textured assets.
   */
  const updateLiveObstaclesFromLidar = (points: LidarPoint[], robotPos: Position2D, headingDeg: number) => {
    // Only active if no static map obstacles exist yet
    if (rootGroup.children.length >= 8) return

    const headingRad = (headingDeg * Math.PI) / 180
    const binCount: Record<string, { count: number; sumX: number; sumZ: number }> = {}

    for (let i = 0; i < points.length; i++) {
      const pt = points[i]
      if (pt.distanceM < 0.4 || pt.distanceM > 2.8) continue

      const ptAngleRad = (pt.angleDeg * Math.PI) / 180
      const totalAngleRad = headingRad + ptAngleRad
      const wx = robotPos.x + Math.sin(totalAngleRad) * pt.distanceM
      const wz = robotPos.y - Math.cos(totalAngleRad) * pt.distanceM

      // Never track boundary returns as interior obstacle objects
      if (Math.abs(wx) >= 2.9 || Math.abs(wz) >= 1.8) continue

      const binKey = `${(Math.round(wx * 2) / 2).toFixed(1)},${(Math.round(wz * 2) / 2).toFixed(1)}`
      if (!binCount[binKey]) {
        binCount[binKey] = { count: 0, sumX: 0, sumZ: 0 }
      }
      binCount[binKey].count++
      binCount[binKey].sumX += wx
      binCount[binKey].sumZ += wz
    }

    for (const [key, bin] of Object.entries(binCount)) {
      if (bin.count >= 4 && !liveObstacleKeys.has(key) && rootGroup.children.length < 20) {
        liveObstacleKeys.add(key)
        const avgX = bin.sumX / bin.count
        const avgZ = bin.sumZ / bin.count

        // Boundary safety check
        if (Math.abs(avgX) >= 2.9 || Math.abs(avgZ) >= 1.8) continue

        const hash = Math.sin(avgX * 43.1 + avgZ * 67.3) * 43758.5453
        const seed = Math.abs(hash % 1)
        const angle = (seed * Math.PI * 2) % Math.PI

        let obj: THREE.Group
        if (seed < 0.3) {
          obj = createFallenDrum(avgX, avgZ, angle, 0.2)
        } else if (seed < 0.55) {
          obj = createSlabWithRebar(avgX, avgZ, 0.44, 0.13, 0.30, angle)
        } else if (seed < 0.75) {
          obj = createSafetyConeGroup(avgX, avgZ, angle)
        } else if (seed < 0.9) {
          obj = createTiltedEmergingPipe(avgX, avgZ, 0.13, 0.65, 0.52, angle)
        } else {
          obj = createUprightDrum(avgX, avgZ, angle, 0.04)
        }
        rootGroup.add(obj)
      }
    }
  }

  const dispose = () => {
    rootGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose()
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose())
        } else {
          obj.material?.dispose()
        }
      }
    })
    drumTex.dispose()
    slabTex.dispose()
    pipeTex.dispose()
    coneTex.dispose()
  }

  return {
    group: rootGroup,
    buildMappedObstacles,
    updateLiveObstaclesFromLidar,
    dispose,
  }
}

/**
 * Builds the complete, cinematic Disaster Zone 3D Environment:
 * - 360° Photorealistic Disaster Sky Dome (`disaster_sky.png`)
 * - High-detail cracked industrial asphalt terrain floor
 * - Clean, sparse, stationary realistic 3D Obstacles:
 *   * Fallen 55-gallon oil drum with exact HAZMAT label and lid bungs
 *   * Shattered reinforced concrete slabs with exposed rusted steel rebar
 *   * Corrugated culvert drainage pipe protruding out of the ground at tilted angle
 *   * Traffic safety cones with reflective honeycomb bands
 *   * Weathered fuel drum
 * - Holographic Warning Waypoint Beacon (`⚠️` neon crimson triangle)
 * - Stepped glowing navigation path pads
 * - Volcanic atmospheric embers drifting in warm sunset key light
 * - Real-time 360° LiDAR point cloud and proximity warning slices
 */
export function createSceneEnvironment(grid: OccupancyGrid): SceneEnvironment {
  const root = new THREE.Group()
  root.name = 'Disaster_Zone_Scene_Environment'

  const loader = new THREE.TextureLoader()

  // 1. Photorealistic 360° Disaster Sky Dome
  const skyDome = createDisasterSkyDome(loader)
  root.add(skyDome.mesh)

  // 2. High-detail Disaster Ground Terrain (Cracked industrial asphalt)
  const terrain = createDisasterTerrain(loader)
  root.add(terrain)

  // 3. Stationary Disaster Arena Obstacles (Fallen drum, slabs with rebar, tilted pipe, cones)
  const obstacleManager = createRealTimeObstacleManager(loader)
  obstacleManager.buildMappedObstacles(grid)
  root.add(obstacleManager.group)

  const updateMapGrid = (newGrid: OccupancyGrid) => {
    obstacleManager.buildMappedObstacles(newGrid)
  }

  // 4. Holographic Crimson Warning Waypoint Beacon (`⚠️`)
  const goalBeacon = new THREE.Group()
  goalBeacon.name = 'Holographic_Crimson_Warning_Beacon'
  goalBeacon.visible = false

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

  const warningTriangle = createHolographicWarningTriangle()
  warningTriangle.position.y = beamHeight
  goalBeacon.add(warningTriangle)

  const goalLight = new THREE.PointLight(0xff1744, 2.8, 4.5, 1.6)
  goalLight.position.set(0, 0.8, 0)
  goalBeacon.add(goalLight)

  root.add(goalBeacon)

  // 5. Holographic Frontier Exploration Beacon (Cyber Cyan/Violet)
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

  // 6. Stepped Glowing Neon Navigation Path Pads
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

  const setRoutePath = (path: Position2D[]) => {
    while (routeGroup.children.length > 0) {
      const child = routeGroup.children[0]
      routeGroup.remove(child)
      if (child instanceof THREE.Line && child.geometry instanceof THREE.BufferGeometry) {
        child.geometry.dispose()
      }
    }
    pathPads = []

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

    const curvePoints = curve.getPoints(Math.min(120, numPads * 6))
    const lineGeo = new THREE.BufferGeometry().setFromPoints(curvePoints)
    const pathConnectingLine = new THREE.Line(lineGeo, pathLineMat)
    routeGroup.add(pathConnectingLine)

    for (let i = 0; i <= numPads; i++) {
      const u = i / numPads
      const point = curve.getPoint(u)
      const tangent = curve.getTangent(u).normalize()

      const pad = new THREE.Group()
      pad.position.copy(point)
      pad.position.y = 0.012

      const angleY = Math.atan2(tangent.x, tangent.z)
      pad.rotation.y = angleY + Math.PI / 2

      const core = new THREE.Mesh(padGeo, padCenterMat)
      pad.add(core)

      const rim = new THREE.LineSegments(padRimGeo, padRimMat)
      pad.add(rim)

      routeGroup.add(pad)
      pathPads.push(pad)
    }

    routeGroup.visible = true
  }

  // 7. Clean LiDAR Handler: routes live obstacle detection to obstacleManager
  // (Shiny blue particle points and vertical line slices completely removed per user specification)
  const lidarGeo = new THREE.BufferGeometry()
  const lidarPointMat = new THREE.PointsMaterial({ visible: false })
  const lidarPointsCloud = new THREE.Points(lidarGeo, lidarPointMat)
  lidarPointsCloud.visible = false

  // 8. LiDAR Updater: updates real-time live obstacle detection
  const updateLidarPoints = (points: LidarPoint[], robotPos: Position2D, headingDeg: number) => {
    obstacleManager.updateLiveObstaclesFromLidar(points, robotPos, headingDeg)
  }

  // 9. Atmospheric Volcanic Embers & Sparks
  const particleCount = 80
  const particleGeo = new THREE.BufferGeometry()
  const particlePositions = new Float32Array(particleCount * 3)
  const particleColors = new Float32Array(particleCount * 3)

  for (let i = 0; i < particleCount; i++) {
    particlePositions[i * 3] = (Math.random() - 0.5) * 16
    particlePositions[i * 3 + 1] = Math.random() * 0.8 + 0.02
    particlePositions[i * 3 + 2] = (Math.random() - 0.5) * 16

    const colorType = Math.random()
    if (colorType < 0.6) {
      particleColors[i * 3] = 1.0
      particleColors[i * 3 + 1] = 0.55
      particleColors[i * 3 + 2] = 0.08
    } else if (colorType < 0.85) {
      particleColors[i * 3] = 1.0
      particleColors[i * 3 + 1] = 0.15
      particleColors[i * 3 + 2] = 0.18
    } else {
      particleColors[i * 3] = 0.75
      particleColors[i * 3 + 1] = 0.35
      particleColors[i * 3 + 2] = 1.0
    }
  }
  particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3))
  particleGeo.setAttribute('color', new THREE.BufferAttribute(particleColors, 3))

  const particleMat = new THREE.PointsMaterial({
    vertexColors: true,
    size: 0.020,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const particles = new THREE.Points(particleGeo, particleMat)
  root.add(particles)

  // 10. Multi-Tier Cinematic Lighting Setup
  const hemiLight = new THREE.HemisphereLight(0x8a2be2, 0x3d140e, 1.25)
  root.add(hemiLight)

  const ambientLight = new THREE.AmbientLight(0x3b0764, 0.35)
  root.add(ambientLight)

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

  const rimLight = new THREE.DirectionalLight(0xd946ef, 1.4)
  rimLight.position.set(-15, 6, 18)
  root.add(rimLight)

  const fillLight = new THREE.PointLight(0xffaa66, 0.85, 6.0, 1.8)
  fillLight.position.set(0, 1.2, 0)
  root.add(fillLight)

  // Animation loop
  let pulseTime = 0

  const update = (dtSec: number, robotPos: Position2D, linearVel: number, cameraPos?: THREE.Vector3) => {
    pulseTime += dtSec

    // Sky dome follows camera position to create infinite horizon
    if (cameraPos) {
      skyDome.mesh.position.copy(cameraPos)
    }

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

    // Atmospheric Sunset Embers
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
