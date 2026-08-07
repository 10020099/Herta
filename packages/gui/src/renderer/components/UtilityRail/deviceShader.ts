/**
 * The 板砖 device LED shader (2026-07-12): one fragment pass replacing the
 * RingSVG ellipse stack (7 strokes + 2 SVG gaussian filter graphs) and the
 * `.agent-spill` gradient/blur/screen-blend div. Everything is an analytic
 * field around the LED's position on the device PNG, so the WHOLE stack —
 * spill wash, halo bloom, ring body, hot core — takes the state color as a
 * uniform: an amber approval state renders an amber LED, not a blue LED
 * wearing an amber drop-shadow (the old CSS-filter compromise).
 *
 * Field layers, inside-out (r == 1.0 on the LED ring):
 *   glass — soft disk tint inside the ring (was blueGlassFill/ringFaceTint)
 *   core  — thin white-hot line, tinted toward the state color by uCoreMix
 *   band  — the glowing torus body (was the 8px hot inner stroke)
 *   bloom — exponential halo hugging the ring (was hotInnerRingGlow's blurs)
 *   spill — wide wash over the device face (was the 3-layer radial div)
 *
 * Uniforms come from device-visual-engine's per-frame step: colors/gains
 * already lerped between states, breath folded into uIntensity, and the
 * success/error flash envelopes in uFlash.
 */
export const DEVICE_SHADER_SOURCE = `
precision mediump float;

uniform vec2 iResolution;
uniform vec2 uCenter;      /* ring center, fraction of canvas, y-down */
uniform vec2 uRingRadius;  /* LED ring semi-axes, fraction of canvas w/h */
uniform vec2 uSpillCenter; /* spill wash center, fraction of canvas */
uniform vec2 uSpillRadius; /* spill semi-axes, fraction of canvas w/h */
uniform vec3 uColor;       /* state base color: spill wash + glass disk */
uniform vec3 uGlow;        /* state hot color: ring body + bloom */
uniform float uCoreMix;    /* 0 = pure white core, 1 = fully state-colored */
uniform float uIntensity;  /* master gain, breath-modulated CPU-side */
uniform float uSpill;      /* spill wash strength */
uniform float uFlash;      /* success/error event envelope, 0..1 */

void main() {
  /* y-down fraction coords so the CPU-side geometry constants can be read
     straight off the CSS percentages they replace. */
  vec2 uv = vec2(gl_FragCoord.x, iResolution.y - gl_FragCoord.y) / iResolution;

  /* Elliptical normalized radius: 1.0 exactly on the LED ring. */
  float r = length((uv - uCenter) / uRingRadius);

  /* Spill: two nested falloffs — a wide ambient wash + a tighter hot pool
     just under the LED (mirrors the old gradient stack's 20%/42% layers). */
  vec2 s = (uv - uSpillCenter) / uSpillRadius;
  float sd = dot(s, s);
  float spill = exp(-sd * 2.2) * 0.34 + exp(-sd * 7.5) * 0.38;

  float bloom = exp(-abs(r - 1.0) * 3.0) * 0.85;
  float band = exp(-((r - 1.0) * (r - 1.0)) / 0.026);
  float core = exp(-((r - 1.0) * (r - 1.0)) / 0.003);
  float glass = smoothstep(1.0, 0.15, r) * 0.32;

  vec3 col = uColor * (spill * uSpill + glass)
    + uGlow * (bloom * 0.55 + band * 0.9)
    + mix(vec3(1.0), uGlow, uCoreMix) * core;
  col *= uIntensity;
  /* Flash rides on top of the steady state: a white-leaning burst through
     the ring + halo (success pop, error double-blink). */
  col += (band + bloom * 0.6) * uFlash * mix(vec3(1.0), uGlow, 0.35);

  float a = spill * uSpill * 0.85 + glass * 0.9 + bloom * 0.7 + band + core;
  a = clamp(a * min(uIntensity, 1.15) + (band + bloom * 0.4) * uFlash, 0.0, 1.0);

  gl_FragColor = vec4(col, a);
}
`;

/**
 * Where the LED lives on agent_device.png, as fractions of the 216×270
 * `.agent-preview` box — transcribed from the CSS geometry this shader
 * replaces (`.agent-ring`: left 44.56% / top 33.17%, box 8.91%×7.49%, hot
 * ring at 63%/64% of that box; `.agent-spill`: box 41.9%×37.1% with its
 * 45% point on the ring center). If the PNG is ever re-rendered, retune
 * here — nothing else carries the alignment.
 */
export const DEVICE_GLOW_GEOMETRY = {
  center: [0.4456, 0.3317] as const,
  ringRadius: [0.0281, 0.024] as const,
  spillCenter: [0.4456, 0.3503] as const,
  spillRadius: [0.1, 0.096] as const,
};
