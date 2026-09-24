import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'

interface CustomShader {
  uniforms: {
    tDiffuse: { value: THREE.Texture | null }
    uSpeed: { value: number }
    uAccel: { value: number }
    uTurnBias: { value: number }
    uTime: { value: number }
    uCenter: { value: THREE.Vector2 }
  }
  vertexShader: string
  fragmentShader: string
}

const SpeedVfxShader: CustomShader = {
  uniforms: {
    tDiffuse:  { value: null },
    uSpeed:    { value: 0.0 }, // 0.0 to 1.0 — normalized vehicle speed
    uAccel:    { value: 0.0 }, // 0.0 to 1.0 — acceleration factor
    uTurnBias: { value: 0.0 }, // -1.0 to 1.0 — turn factor (positive = left turn)
    uTime:     { value: 0.0 },
    uCenter:   { value: new THREE.Vector2(0.5, 0.45) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uSpeed;
    uniform float uAccel;
    uniform float uTurnBias;
    uniform float uTime;
    uniform vec2  uCenter;
    varying vec2  vUv;

    // Pseudo-random noise — hash for film grain and streak selection
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec2 dir = vUv - uCenter;
      float dist = length(dir);
      vec2 normDir = normalize(dir + 0.0001);

      // ── 1. Dynamic Radial Motion Blur ───────────────────────────────────────
      // Blurs the periphery of the frame, keeps center (robot) sharp.
      // Slight directional bias: on left turns the blur leans right (centrifugal).
      float blurStrength = uSpeed * 0.017 * smoothstep(0.18, 0.85, dist);

      // Turn bias shifts the blur center slightly to show g-force loading
      // uTurnBias > 0 = left turn = camera leans right = blur leans left in UV
      vec2 blurCenter = uCenter + vec2(-uTurnBias * 0.025, 0.0);
      vec2 biasedDir  = vUv - blurCenter;

      vec4 color = vec4(0.0);
      const int SAMPLES = 10;
      float totalWeight = 0.0;

      for (int i = 0; i < SAMPLES; i++) {
        float scale = 1.0 - blurStrength * (float(i) / float(SAMPLES - 1));
        vec2 sampleUv = blurCenter + biasedDir * scale;
        float weight  = 1.0 - float(i) * 0.08;
        color += texture2D(tDiffuse, clamp(sampleUv, 0.001, 0.999)) * weight;
        totalWeight += weight;
      }
      color /= totalWeight;

      // ── 2. Velocity Chromatic Aberration ────────────────────────────────────
      // RGB fringe at edges; strengthens on acceleration for punch feel.
      float chroma = (uSpeed * 0.0055 + uAccel * 0.0035) * smoothstep(0.25, 0.85, dist);
      float r = texture2D(tDiffuse, clamp(vUv + normDir * chroma, 0.001, 0.999)).r;
      float b = texture2D(tDiffuse, clamp(vUv - normDir * chroma, 0.001, 0.999)).b;
      color.r = mix(color.r, r, smoothstep(0.1, 0.6, uSpeed + uAccel * 0.5));
      color.b = mix(color.b, b, smoothstep(0.1, 0.6, uSpeed + uAccel * 0.5));

      // ── 3. Cinematic Vignette ───────────────────────────────────────────────
      // Base vignette — slightly asymmetric on turns (outside edge darkens more).
      // Turn darkens the outside (positive turn = left = darkens right side).
      float turnVignetteBias = uTurnBias * (vUv.x - 0.5) * 0.12;
      float vignette = smoothstep(1.05, 0.38, dist) - turnVignetteBias * smoothstep(0.3, 0.8, dist);
      color.rgb *= mix(0.60, 1.0, clamp(vignette, 0.0, 1.0));

      // ── 4. Speed Streaks ─────────────────────────────────────────────────────
      // Sparse radial bright lines at the screen periphery, only at significant speed.
      // Creates a Forza-style "velocity cone" feel at the edge of the frame.
      float streakThreshold = 0.38;
      if (uSpeed > streakThreshold && dist > 0.38) {
        // 10 possible streak directions, ~40% populated (hash-selected)
        float angle = atan(dir.y, dir.x);
        float numStreaks = 10.0;
        float sectorSize = 6.28318 / numStreaks;

        // Quantize to sector
        float sectorIdx = floor((angle + 3.14159) / sectorSize);
        float sectorCenter = (sectorIdx + 0.5) * sectorSize - 3.14159;
        float angDiff = abs(angle - sectorCenter);

        // Hash-select ~40% of sectors for streaks (varies per frame via time for shimmer)
        float sectorHash = hash(vec2(sectorIdx, floor(uTime * 2.0)));
        float streakPresent = step(0.6, sectorHash);

        // Streak sharpness and edge falloff
        float streakFalloff = smoothstep(0.045, 0.0, angDiff);
        float edgeFalloff   = smoothstep(0.38, 0.72, dist);
        float speedFade     = (uSpeed - streakThreshold) / (1.0 - streakThreshold);

        // Streak color: slightly blue-white for a lens/motion-artifact feel
        vec3 streakColor = vec3(0.75, 0.90, 1.0);
        color.rgb += streakColor * streakFalloff * edgeFalloff * streakPresent * speedFade * 0.16;
      }

      // ── 5. Subtle Film Grain ─────────────────────────────────────────────────
      // Breaks the pure-CG look by adding a physical camera texture.
      float grain = (hash(vUv + fract(uTime * 0.37)) - 0.5) * 0.005;
      color.rgb += grain;

      gl_FragColor = color;
    }
  `,
}

export interface PostProcessingPipeline {
  composer: EffectComposer
  bloomPass: UnrealBloomPass
  speedPass: ShaderPass
  render: (dtSec: number, normalizedSpeed: number, accelFactor?: number, turnBias?: number) => void
  setSize: (width: number, height: number) => void
  dispose: () => void
}

/**
 * AAA Post-Processing Pipeline:
 * - UnrealBloom: visibly glowing headlights, neon LiDAR, and LED accents
 * - Speed VFX: radial motion blur (10 samples) with turn-biased blur center
 * - Chromatic aberration that strengthens on acceleration
 * - Asymmetric vignette during turns
 * - Speed streaks at periphery (hash-selected, shimmer over time)
 * - Film grain for physical camera feel
 * - Filmic tone mapping output
 */
export function createPostProcessingPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
): PostProcessingPipeline {
  const composer = new EffectComposer(renderer)
  composer.setSize(width, height)

  // 1. Base Render Pass
  const renderPass = new RenderPass(scene, camera)
  composer.addPass(renderPass)

  // 2. Unreal Bloom Pass
  // strength 0.42: visibly glowing neons/headlights without washing out the scene
  // radius 0.52: wide cinematic bloom spread
  // threshold 0.65: catches bright emissives (headlights, LiDAR, LEDs) while pavement stays clean
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    0.42,  // strength
    0.52,  // radius
    0.65,  // threshold
  )
  composer.addPass(bloomPass)

  // 3. Speed VFX Shader Pass (Radial Blur + Chromatic Aberration + Speed Streaks + Film Grain)
  const speedPass = new ShaderPass(SpeedVfxShader)
  composer.addPass(speedPass)

  // 4. Filmic Output Pass
  const outputPass = new OutputPass()
  composer.addPass(outputPass)

  let elapsedTime = 0

  const render = (dtSec: number, normalizedSpeed: number, accelFactor = 0, turnBias = 0) => {
    elapsedTime += dtSec

    const uniforms = speedPass.uniforms
    if (uniforms.uSpeed)    uniforms.uSpeed.value    = Math.max(0, Math.min(1, normalizedSpeed))
    if (uniforms.uAccel)    uniforms.uAccel.value    = Math.max(0, Math.min(1, accelFactor))
    if (uniforms.uTurnBias) uniforms.uTurnBias.value = Math.max(-1, Math.min(1, turnBias))
    if (uniforms.uTime)     uniforms.uTime.value      = elapsedTime

    composer.render(dtSec)
  }

  const setSize = (w: number, h: number) => {
    if (w <= 0 || h <= 0) return
    composer.setSize(w, h)
    bloomPass.resolution.set(w, h)
  }

  const dispose = () => {
    composer.passes.forEach((p) => p.dispose?.())
  }

  return {
    composer,
    bloomPass,
    speedPass,
    render,
    setSize,
    dispose,
  }
}
