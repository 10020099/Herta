/**
 * Minimal WebGL program bootstrap shared by the rail's shader visuals
 * (AuraVisual's tide wave, DeviceGlow's ring/spill). Extracted from
 * AuraVisual when the device card gained its own shader — the compile/link
 * error paths must stay identical so both components fall back the same way.
 */

export function createShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (shader === null) throw new Error("createShader failed");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const msg = gl.getShaderInfoLog(shader) ?? "shader compile error";
    gl.deleteShader(shader);
    throw new Error(msg);
  }
  return shader;
}

export function createProgram(
  gl: WebGLRenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vs = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (program === null) throw new Error("createProgram failed");
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const msg = gl.getProgramInfoLog(program) ?? "program link error";
    gl.deleteProgram(program);
    throw new Error(msg);
  }
  return program;
}

/** Fullscreen-quad vertex shader shared by every rail visual. */
export const QUAD_VERTEX_SOURCE = `
attribute vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`;
