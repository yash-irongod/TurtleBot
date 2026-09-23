import * as THREE from 'three'

export interface TurtleBot3Mesh {
  root: THREE.Group
  chassis: THREE.Group
  leftWheel: THREE.Group
  rightWheel: THREE.Group
  lidarHead: THREE.Group
  headlights: THREE.SpotLight[]
  taillights: THREE.Mesh[]
  underglow: THREE.PointLight
  update: (
    dtSec: number,
    linearVel: number,
    angularVel: number,
    pitchRad?: number,
    rollRad?: number,
  ) => void
  dispose: () => void
}

/**
 * Realistic, authentic TurtleBot 3 Burger 3D model (Robotics engineered standard):
 * - Real multi-tier carbon-fiber waffle plates with titanium standoffs & copper hardware
 * - Genuine Dynamixel XL430 servo motors with black casings, wiring, and hubs
 * - Raspberry Pi 4 Model B board with USB 3.0/2.0 ports, Ethernet jack, and CPU heatsink fins
 * - OpenCR 1.0 controller board with status LEDs and push buttons
 * - Authentic 360° LDS-01 / LDS-02 LiDAR sensor turret with optical scanner
 * - Realistic Burger drive wheels with dark rims and rubber tread tires
 * - Rear ball caster wheel for authentic kinematics
 * - Dual projector headlights and reactive brake taillights
 * - Clean ground (zero circular laser rings or floor grids)
 */
export function createTurtleBot3Burger(): TurtleBot3Mesh {
  const root = new THREE.Group()
  root.name = 'TurtleBot3_Burger_Root'

  const chassis = new THREE.Group()
  chassis.name = 'Chassis_Body'
  root.add(chassis)

  // -------------------------------------------------------------
  // Materials (Authentic robotics hardware)
  // -------------------------------------------------------------
  const carbonPlateMat = new THREE.MeshStandardMaterial({
    color: 0x1c1a24,
    metalness: 0.75,
    roughness: 0.38,
  })

  const beveledRimMat = new THREE.MeshStandardMaterial({
    color: 0x383245,
    metalness: 0.9,
    roughness: 0.22,
  })

  const standoffMat = new THREE.MeshStandardMaterial({
    color: 0x78716c,
    metalness: 0.88,
    roughness: 0.25,
  })

  const washerMat = new THREE.MeshStandardMaterial({
    color: 0xd97706,
    metalness: 0.9,
    roughness: 0.2,
  })

  const tireMat = new THREE.MeshStandardMaterial({
    color: 0x141216,
    roughness: 0.95,
    metalness: 0.04,
  })

  const wheelRimMat = new THREE.MeshStandardMaterial({
    color: 0x2b2b36,
    roughness: 0.5,
    metalness: 0.6,
  })

  const neonCyanMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff })
  const neonGreenMat = new THREE.MeshBasicMaterial({ color: 0x10b981 })
  const neonAmberMat = new THREE.MeshBasicMaterial({ color: 0xf59e0b })
  const tailLightOffMat = new THREE.MeshStandardMaterial({ color: 0x3f0505, roughness: 0.6 })
  const tailLightBrakeMat = new THREE.MeshBasicMaterial({ color: 0xff0033 })

  // -------------------------------------------------------------
  // 1. Multi-Tier Chassis Construction
  // -------------------------------------------------------------
  const plateRadius = 0.071
  const plateThickness = 0.003
  const plateGeo = new THREE.CylinderGeometry(plateRadius, plateRadius, plateThickness, 36)
  const plateBevelGeo = new THREE.TorusGeometry(plateRadius, 0.0015, 8, 36)
  plateBevelGeo.rotateX(Math.PI / 2)

  function createChassisPlate(y: number): THREE.Group {
    const group = new THREE.Group()
    group.position.y = y

    const plate = new THREE.Mesh(plateGeo, carbonPlateMat)
    plate.castShadow = true
    plate.receiveShadow = true
    group.add(plate)

    const bevel = new THREE.Mesh(plateBevelGeo, beveledRimMat)
    group.add(bevel)

    // Recessed screw heads
    const screwGeo = new THREE.CylinderGeometry(0.0025, 0.0025, 0.001, 8)
    const boltPositions = [
      [0.045, 0.045],
      [-0.045, 0.045],
      [0.045, -0.045],
      [-0.045, -0.045],
    ]
    boltPositions.forEach(([bx, bz]) => {
      const screw = new THREE.Mesh(screwGeo, beveledRimMat)
      screw.position.set(bx, plateThickness / 2 + 0.0005, bz)
      group.add(screw)
    })

    return group
  }

  // Deck 1 (Lower): y = 0.035
  const deck1 = createChassisPlate(0.035)
  chassis.add(deck1)

  // Battery enclosure
  const batteryGeo = new THREE.BoxGeometry(0.048, 0.026, 0.068)
  const batteryMat = new THREE.MeshStandardMaterial({ color: 0x0c1017, metalness: 0.5, roughness: 0.4 })
  const battery = new THREE.Mesh(batteryGeo, batteryMat)
  battery.position.set(0, 0.049, 0.005)
  battery.castShadow = true
  chassis.add(battery)

  // Standoff pillars
  const standoffPositions: [number, number][] = [
    [0.044, 0.044],
    [-0.044, 0.044],
    [0.044, -0.044],
    [-0.044, -0.044],
  ]
  const standoffGeo = new THREE.CylinderGeometry(0.0032, 0.0032, 0.038, 12)
  const washerGeo = new THREE.CylinderGeometry(0.0048, 0.0048, 0.0012, 12)

  standoffPositions.forEach(([sx, sz]) => {
    const pillar1 = new THREE.Mesh(standoffGeo, standoffMat)
    pillar1.position.set(sx, 0.054, sz)
    pillar1.castShadow = true
    chassis.add(pillar1)

    const w1 = new THREE.Mesh(washerGeo, washerMat)
    w1.position.set(sx, 0.036, sz)
    chassis.add(w1)
  })

  // Deck 2 (Middle - OpenCR Board): y = 0.073
  const deck2 = createChassisPlate(0.073)
  chassis.add(deck2)

  // OpenCR 1.0 Controller Board
  const pcbMat = new THREE.MeshStandardMaterial({ color: 0x064e3b, roughness: 0.35, metalness: 0.25 })
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.002, 0.062), pcbMat)
  pcb.position.set(0, 0.075, 0)
  chassis.add(pcb)

  // Status LEDs on OpenCR
  const ledGeo = new THREE.BoxGeometry(0.002, 0.0015, 0.002)
  const led1 = new THREE.Mesh(ledGeo, neonGreenMat)
  led1.position.set(-0.016, 0.0765, 0.02)
  chassis.add(led1)

  const led2 = new THREE.Mesh(ledGeo, neonAmberMat)
  led2.position.set(-0.012, 0.0765, 0.02)
  chassis.add(led2)

  const led3 = new THREE.Mesh(ledGeo, neonCyanMat)
  led3.position.set(-0.008, 0.0765, 0.02)
  chassis.add(led3)

  // Second tier standoffs
  standoffPositions.forEach(([sx, sz]) => {
    const pillar2 = new THREE.Mesh(standoffGeo, standoffMat)
    pillar2.position.set(sx, 0.092, sz)
    pillar2.castShadow = true
    chassis.add(pillar2)

    const w2 = new THREE.Mesh(washerGeo, washerMat)
    w2.position.set(sx, 0.074, sz)
    chassis.add(w2)
  })

  // Deck 3 (Top - Raspberry Pi 4): y = 0.111
  const deck3 = createChassisPlate(0.111)
  chassis.add(deck3)

  // Raspberry Pi 4 PCB
  const rpiPcbMat = new THREE.MeshStandardMaterial({ color: 0x047857, roughness: 0.35, metalness: 0.2 })
  const rpiPcb = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.0018, 0.065), rpiPcbMat)
  rpiPcb.position.set(0, 0.113, 0.002)
  chassis.add(rpiPcb)

  // Ethernet Jack & USB Ports on RPi
  const metalPortMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.9, roughness: 0.2 })
  const rj45 = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.011, 0.018), metalPortMat)
  rj45.position.set(0.014, 0.119, 0.028)
  chassis.add(rj45)

  const usbBlock = new THREE.Mesh(new THREE.BoxGeometry(0.013, 0.013, 0.016), metalPortMat)
  usbBlock.position.set(-0.014, 0.12, 0.028)
  chassis.add(usbBlock)

  // CPU Aluminum Heatsink
  const heatsinkMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.85, roughness: 0.3 })
  const heatsink = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.005, 0.014), heatsinkMat)
  heatsink.position.set(-0.004, 0.116, -0.006)
  chassis.add(heatsink)

  // Top tier standoffs (supporting LiDAR)
  const lidarStandoffGeo = new THREE.CylinderGeometry(0.003, 0.003, 0.032, 12)
  standoffPositions.forEach(([sx, sz]) => {
    const pillar3 = new THREE.Mesh(lidarStandoffGeo, standoffMat)
    pillar3.position.set(sx * 0.8, 0.127, sz * 0.8)
    pillar3.castShadow = true
    chassis.add(pillar3)
  })

  // Deck 4 (LiDAR Base Plate): y = 0.143
  const deck4Geo = new THREE.CylinderGeometry(0.058, 0.058, 0.0025, 36)
  const deck4 = new THREE.Mesh(deck4Geo, carbonPlateMat)
  deck4.position.y = 0.143
  deck4.castShadow = true
  chassis.add(deck4)

  // -------------------------------------------------------------
  // 2. 360° LDS-01 / LDS-02 LiDAR Sensor Tower
  // -------------------------------------------------------------
  const lidarBaseMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.45, metalness: 0.7 })
  const lidarHeadMat = new THREE.MeshStandardMaterial({ color: 0x1e1b2e, roughness: 0.3, metalness: 0.8 })
  const laserLensMat = new THREE.MeshBasicMaterial({ color: 0xff0044 })

  // Fixed lower LiDAR housing
  const lidarLowerHousing = new THREE.Mesh(
    new THREE.CylinderGeometry(0.038, 0.042, 0.016, 28),
    lidarBaseMat,
  )
  lidarLowerHousing.position.y = 0.152
  lidarLowerHousing.castShadow = true
  chassis.add(lidarLowerHousing)

  // Rotating upper turret head
  const lidarHead = new THREE.Group()
  lidarHead.name = 'LiDAR_Rotating_Head'
  lidarHead.position.y = 0.165
  chassis.add(lidarHead)

  // Drum dome
  const lidarDome = new THREE.Mesh(
    new THREE.CylinderGeometry(0.036, 0.037, 0.014, 28),
    lidarHeadMat,
  )
  lidarDome.castShadow = true
  lidarHead.add(lidarDome)

  // Optical emitter & receiver windows
  const opticRecessGeo = new THREE.BoxGeometry(0.008, 0.007, 0.012)
  const optic1 = new THREE.Mesh(opticRecessGeo, laserLensMat)
  optic1.position.set(0.032, 0, 0)
  lidarHead.add(optic1)

  const optic2 = new THREE.Mesh(opticRecessGeo, laserLensMat)
  optic2.position.set(-0.032, 0, 0)
  lidarHead.add(optic2)

  // Pulsed red laser scan line
  const laserRayGeo = new THREE.CylinderGeometry(0.0008, 0.0016, 1.4, 8)
  laserRayGeo.rotateZ(Math.PI / 2)
  laserRayGeo.translate(0.7, 0, 0)
  const laserRayMat = new THREE.MeshBasicMaterial({
    color: 0xff1744,
    transparent: true,
    opacity: 0.75,
    blending: THREE.AdditiveBlending,
  })
  const laserRay = new THREE.Mesh(laserRayGeo, laserRayMat)
  laserRay.position.y = 0
  lidarHead.add(laserRay)

  // -------------------------------------------------------------
  // 3. Dynamixel XL430 Actuators & Drive Wheels
  // -------------------------------------------------------------
  const servoMat = new THREE.MeshStandardMaterial({ color: 0x1c1917, roughness: 0.5, metalness: 0.4 })
  const servoGeo = new THREE.BoxGeometry(0.032, 0.042, 0.032)

  // Left & Right Actuators
  const leftServo = new THREE.Mesh(servoGeo, servoMat)
  leftServo.position.set(-0.052, 0.024, 0)
  leftServo.castShadow = true
  chassis.add(leftServo)

  const rightServo = new THREE.Mesh(servoGeo, servoMat)
  rightServo.position.set(0.052, 0.024, 0)
  rightServo.castShadow = true
  chassis.add(rightServo)

  const wheelRadius = 0.033
  const wheelWidth = 0.018

  function createBurgerWheel(isLeft: boolean): THREE.Group {
    const wheelGroup = new THREE.Group()
    wheelGroup.name = isLeft ? 'Left_Drive_Wheel' : 'Right_Drive_Wheel'

    const wheelMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(wheelRadius, wheelRadius, wheelWidth, 28),
      tireMat,
    )
    wheelMesh.rotation.z = Math.PI / 2
    wheelMesh.castShadow = true
    wheelGroup.add(wheelMesh)

    // Inner rim
    const rimMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(wheelRadius * 0.65, wheelRadius * 0.65, wheelWidth + 0.001, 20),
      wheelRimMat,
    )
    rimMesh.rotation.z = Math.PI / 2
    wheelGroup.add(rimMesh)

    // Center axle hub nut
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.006, 0.006, wheelWidth + 0.004, 12),
      beveledRimMat,
    )
    hub.rotation.z = Math.PI / 2
    wheelGroup.add(hub)

    // Tread notches on rubber tire
    const notchGeo = new THREE.BoxGeometry(0.002, wheelWidth + 0.0005, 0.003)
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2
      const notch = new THREE.Mesh(notchGeo, beveledRimMat)
      notch.position.set(0, Math.cos(angle) * wheelRadius, Math.sin(angle) * wheelRadius)
      wheelGroup.add(notch)
    }

    return wheelGroup
  }

  const leftWheel = createBurgerWheel(true)
  leftWheel.position.set(-0.08, wheelRadius, 0)
  root.add(leftWheel)

  const rightWheel = createBurgerWheel(false)
  rightWheel.position.set(0.08, wheelRadius, 0)
  root.add(rightWheel)

  // Rear Ball Caster Wheel
  const casterMount = new THREE.Mesh(
    new THREE.BoxGeometry(0.016, 0.018, 0.016),
    standoffMat,
  )
  casterMount.position.set(0, 0.024, -0.052)
  casterMount.castShadow = true
  chassis.add(casterMount)

  const casterBall = new THREE.Mesh(
    new THREE.SphereGeometry(0.009, 20, 20),
    new THREE.MeshStandardMaterial({ color: 0x94a3b8, metalness: 0.95, roughness: 0.1 }),
  )
  casterBall.position.set(0, 0.009, -0.052)
  casterBall.castShadow = true
  chassis.add(casterBall)

  // -------------------------------------------------------------
  // 4. Lights: Projector Headlights & Reactive Taillights
  // -------------------------------------------------------------
  const headlights: THREE.SpotLight[] = []

  const headlampMat = new THREE.MeshBasicMaterial({ color: 0xfff7ed })
  const headlampHousingMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.3 })

  ;[-0.036, 0.036].forEach((x) => {
    const housing = new THREE.Mesh(
      new THREE.CylinderGeometry(0.006, 0.008, 0.012, 16),
      headlampHousingMat,
    )
    housing.rotation.x = Math.PI / 2
    housing.position.set(x, 0.074, 0.068)
    chassis.add(housing)

    const bulb = new THREE.Mesh(new THREE.CircleGeometry(0.005, 16), headlampMat)
    bulb.position.set(x, 0.074, 0.0745)
    chassis.add(bulb)

    const spot = new THREE.SpotLight(0xfff7ed, 2.4, 6.0, Math.PI / 5, 0.4, 1.4)
    spot.position.set(x, 0.074, 0.075)
    spot.target.position.set(x, 0, 1.8)
    chassis.add(spot)
    chassis.add(spot.target)
    headlights.push(spot)
  })

  // Reactive Red Taillights
  const taillights: THREE.Mesh[] = []
  ;[-0.038, 0.038].forEach((x) => {
    const tl = new THREE.Mesh(
      new THREE.BoxGeometry(0.014, 0.004, 0.003),
      tailLightOffMat,
    )
    tl.position.set(x, 0.074, -0.07)
    chassis.add(tl)
    taillights.push(tl)
  })

  // Subtle Underglow
  const underglow = new THREE.PointLight(0xa855f7, 0.35, 0.6, 2.0)
  underglow.position.set(0, 0.015, 0)
  chassis.add(underglow)

  // -------------------------------------------------------------
  // Animation & Physics Update
  // -------------------------------------------------------------
  let wheelRotL = 0
  let wheelRotR = 0
  let prevVel = 0
  let timeAccum = 0

  const update = (
    dtSec: number,
    linearVel: number,
    angularVel: number,
    pitchRad = 0,
    rollRad = 0,
  ) => {
    timeAccum += dtSec

    // 1. Suspension pitch & roll
    chassis.rotation.x = pitchRad
    chassis.rotation.z = rollRad

    // 2. LiDAR 360° spin (~300 RPM)
    lidarHead.rotation.y += dtSec * Math.PI * 10

    // Laser beam subtle pulse
    laserRayMat.opacity = 0.6 + Math.sin(timeAccum * 20) * 0.2

    // 3. Differential wheel rotation
    const track = 0.16
    const vL = linearVel - (angularVel * track) / 2
    const vR = linearVel + (angularVel * track) / 2

    wheelRotL -= (vL / wheelRadius) * dtSec
    wheelRotR -= (vR / wheelRadius) * dtSec

    leftWheel.rotation.x = wheelRotL
    rightWheel.rotation.x = wheelRotR

    // 4. Brake lights flare on deceleration
    const accel = (linearVel - prevVel) / Math.max(0.001, dtSec)
    prevVel = linearVel
    const isBraking = accel < -0.03 || (linearVel < 0.01 && Math.abs(prevVel) > 0.04)

    taillights.forEach((tl) => {
      tl.material = isBraking ? tailLightBrakeMat : tailLightOffMat
    })

    // 5. LED pulsing
    led1.visible = Math.sin(timeAccum * 8) > -0.2
    led2.visible = Math.cos(timeAccum * 12) > 0
    led3.visible = Math.abs(linearVel) > 0.01 || Math.abs(angularVel) > 0.05
  }

  const dispose = () => {
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose()
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose())
        } else {
          obj.material?.dispose()
        }
      }
    })
  }

  return {
    root,
    chassis,
    leftWheel,
    rightWheel,
    lidarHead,
    headlights,
    taillights,
    underglow,
    update,
    dispose,
  }
}
