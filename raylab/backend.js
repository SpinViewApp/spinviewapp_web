/* backend.js - written by build.cwc from web/backend_{web_backend}.js.
 * Names the engine deployed NEXT TO this shell, so index.html preflights the
 * right API instead of guessing. Loaded before the launcher, synchronously.
 * Absent -> the shell assumes WebGPU (the historical deploy). */
/* WebGL2 / GLES3 (sokol lib emsc_webgl, -DSOKOL_GLES3, shaders GLSL300es) */
window.__spinBuildBackend = "webgl";
