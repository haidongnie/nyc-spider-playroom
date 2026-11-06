import { Fn, clamp, dot, float, length, mix, renderOutput, screenUV, smoothstep, vec3, vec4 } from 'three/tsl';

// The active Japanese Seaside Street profile uses ordinary lit materials and
// manually attached ink shells. Its grading is done *after* display conversion.
export function createSeasideOutput(renderer, sceneColor) {
  const toneMapping = renderer.toneMapping;
  const outputColorSpace = renderer.outputColorSpace;
  return Fn(() => {
    const display = renderOutput(vec4(sceneColor.rgb.mul(2 ** 0.3), 1), toneMapping, outputColorSpace).rgb;
    const gray = dot(display, vec3(0.2126, 0.7152, 0.0722));
    const saturated = mix(vec3(gray), display, 1.04);
    const graded = saturated.sub(0.5).mul(1.05).add(0.5);
    const corner = length(screenUV.sub(0.5)).div(Math.SQRT1_2);
    const vignette = float(1).sub(smoothstep(0.32, 1, corner).mul(0.10));
    return vec4(clamp(graded.mul(vignette), 0, 1), 1);
  })();
}
