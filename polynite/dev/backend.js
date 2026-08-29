/* backend.js - written by build.cwc from web/backend_{web_backend}.js.
 * Names the engine deployed NEXT TO this shell, so index.html preflights the
 * right API instead of guessing. Loaded before the launcher, synchronously.
 * Absent -> the shell assumes WebGPU (the historical deploy). */
/* Dawn / WebGPU  (sokol lib emsc, -DSOKOL_WGPU, shaders WGSL) */
window.__spinBuildBackend = "webgpu";
