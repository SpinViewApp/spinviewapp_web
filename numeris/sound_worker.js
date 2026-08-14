/* sound_worker.js — GPU SoundWorker.wasm + PCM pump.
 * No CPU instrument transcription: if worker WebGL2 fails, C falls back
 * to the main-thread ssound GPU pump (Safari). Cache: gpu14
 */
(function (root) {
  "use strict";

  var CONFIG_SR = 48000;
  var SR = CONFIG_SR;
  var outputRate = CONFIG_SR;
  var backend = "loading";
  var wasm = null;
  var loadPromise = null;
  var F32 = Math.fround;
  var ECHO_DELAY_MS = 80.0;
  var ECHO_MIX = 0.3;
  var ECHO_FB = 0.4;
  var gpuVariants = null;
  var loadError = "";
  var preferCpu = false;
  var srcScratch = null;
  var srcScratchFrames = 0;
  var srcView = null;
  var srcViewFrames = 0;
  var RESAMPLE_CAP = 32768;
  var resampleSamples = new Float32Array(RESAMPLE_CAP * 2);
  var resampleHead = 0;
  var resampleFrames = 0;
  var resamplePos = 0.0;
  var outScratch = null;
  var outScratchFrames = 0;

  function applyEchoSettings(delayMs, feedback, mix) {
    if (delayMs > 0) ECHO_DELAY_MS = delayMs < 1 ? 1 : delayMs > 1000 ? 1000 : delayMs;
    if (feedback >= 0) ECHO_FB = feedback > 0.98 ? 0.98 : feedback;
    if (mix >= 0) ECHO_MIX = mix > 1 ? 1 : mix;
    if (wasm && typeof wasm._sound_worker_set_echo === "function") {
      try {
        wasm._sound_worker_set_echo(ECHO_DELAY_MS, ECHO_FB, ECHO_MIX);
      } catch (eEcho) {}
    }
  }

  function applyConfigRate(sr) {
    sr = sr > 0 ? sr | 0 : 48000;
    if (sr === CONFIG_SR) return;
    CONFIG_SR = sr;
    SR = CONFIG_SR;
    resetOutput();
  }

  function acquireSrcScratch(frames) {
    if (!srcScratch || srcScratchFrames < frames) {
      srcScratch = new Float32Array(frames * 2);
      srcScratchFrames = frames;
      srcView = null;
      srcViewFrames = 0;
    }
    if (!srcView || srcViewFrames !== frames) {
      srcView = srcScratch.subarray(0, frames * 2);
      srcViewFrames = frames;
    }
    return srcView;
  }

  function acquireOutScratch(frames) {
    if (!outScratch || outScratchFrames < frames) {
      outScratch = new Float32Array(frames * 2);
      outScratchFrames = frames;
    }
    return outScratch;
  }

  function resetOutput() {
    resampleHead = 0;
    resampleFrames = 0;
    resamplePos = 0.0;
    gpuHoldOff = 0;
    gpuHoldLen = 0;
  }

  function silentBlock(frames) {
    var out = acquireSrcScratch(frames);
    out.fill(0);
    return out.subarray(0, frames * 2);
  }

  function buildGpuVariantMap() {
    gpuVariants = null;
    if (!wasm || typeof wasm._sound_worker_variant_count !== "function") return;
    try {
      var n = wasm._sound_worker_variant_count() | 0;
      if (n < 1) return;
      var map = {};
      var i, ptr;
      for (i = 0; i < n; i++) {
        ptr = wasm._sound_worker_variant_name(i);
        if (ptr) map[wasm.UTF8ToString(ptr)] = i;
      }
      gpuVariants = map;
      console.log("[SoundWorkerSsound] GPU variants:", Object.keys(map).join(", "));
    } catch (eVar) {
      console.warn("[SoundWorkerSsound] variant map failed", eVar);
    }
  }

  function gpuVariantIndex(name) {
    if (!gpuVariants) return -1;
    var v = gpuVariants[name || "tweet"];
    return v == null ? -1 : v | 0;
  }

  function fallbackGpuDead(reason) {
    if (backend !== "wasm-gpu") return;
    console.warn("[SoundWorkerSsound] " + reason + " — host should use main-thread GPU");
    loadError = reason;
    backend = "gpu-unavailable";
    wasm = null;
    gpuVariants = null;
  }

  function wasmPlay(desc) {
    desc = desc || {};
    var variant = gpuVariantIndex(desc.soundType);
    if (variant < 0 || !wasm) return -1;
    var vol = desc.volume >= 0 ? +desc.volume : 0.6;
    var dur = desc.duration > 0 ? +desc.duration : 0.35;
    var fadein = Math.max(0, desc.fadein >= 0 ? +desc.fadein : 0.0000006);
    var envelop = desc.envelop >= 0 ? +desc.envelop : 8.0;
    var fx = desc.freqX != null ? +desc.freqX : 2.0;
    var fy = desc.freqY != null ? +desc.freqY : 4.0;
    var fz = desc.freqZ != null ? +desc.freqZ : 0.0;
    var fw = desc.freqW != null ? +desc.freqW : 1.0;
    var toff = desc.timeOffset != null ? +desc.timeOffset : 0.0;
    /* Drop leftover silent GPU grain so the next PCM slice re-renders. */
    gpuHoldOff = gpuHoldLen;
    return (
      wasm._sound_worker_play(
        variant, vol, dur, fadein, envelop, fx, fy, fz, fw, toff
      ) | 0
    );
  }

  function wasmGenerateBlock(frames) {
    frames = frames | 0;
    if (frames < 1) frames = 1024;
    if (wasm && wasm._sound_worker_set_sample_rate) {
      try {
        wasm._sound_worker_set_sample_rate(SR);
      } catch (eSr) {}
    }
    var bytes = frames * 2 * 4;
    var ptr = 0;
    try {
      if (!wasm._spinPcmScratch || wasm._spinPcmScratchFrames < frames) {
        if (wasm._spinPcmScratch) {
          try { wasm._free(wasm._spinPcmScratch); } catch (eFree) {}
        }
        wasm._spinPcmScratch = wasm._malloc(bytes);
        wasm._spinPcmScratchFrames = frames;
      }
      ptr = wasm._spinPcmScratch;
      if (!ptr) return silentBlock(frames);
      wasm._sound_worker_generate_block(ptr, frames);
      var out = acquireSrcScratch(frames);
      out.set(wasm.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + frames * 2));
      return out;
    } catch (eGen) {
      console.warn("[SoundWorkerSsound] generate failed", eGen);
      fallbackGpuDead("wasm generate threw");
      return silentBlock(frames);
    }
  }

  var GPU_RENDER = 2048;
  var gpuHold = new Float32Array(GPU_RENDER * 2);
  var gpuHoldOff = 0;
  var gpuHoldLen = 0;

  function clampPcm(buf, n) {
    var i, v;
    for (i = 0; i < n; i++) {
      v = buf[i];
      if (!(v > -2) || !(v < 2)) buf[i] = 0;
      else if (v > 1) buf[i] = 1;
      else if (v < -1) buf[i] = -1;
    }
  }

  function generateSourceBlock(frames) {
    frames = frames | 0;
    if (frames < 1) frames = 256;
    if (!((backend.indexOf("wasm") === 0) && wasm))
      return silentBlock(frames);
    var out = acquireSrcScratch(frames);
    var filled = 0;
    var take, chunk;
    while (filled < frames) {
      if (gpuHoldOff >= gpuHoldLen) {
        chunk = wasmGenerateBlock(GPU_RENDER);
        gpuHold.set(chunk.subarray(0, GPU_RENDER * 2));
        clampPcm(gpuHold, GPU_RENDER * 2);
        gpuHoldOff = 0;
        gpuHoldLen = GPU_RENDER;
      }
      take = frames - filled;
      if (take > gpuHoldLen - gpuHoldOff) take = gpuHoldLen - gpuHoldOff;
      out.set(
        gpuHold.subarray(gpuHoldOff * 2, (gpuHoldOff + take) * 2),
        filled * 2
      );
      gpuHoldOff += take;
      filled += take;
    }
    return out.subarray(0, frames * 2);
  }

  function ensureSourceFrames(want) {
    var chunk, chunkFrames;
    while (resampleFrames < want) {
      chunk = generateSourceBlock(2048);
      chunkFrames = chunk.length >> 1;
      if (resampleHead + resampleFrames + chunkFrames > RESAMPLE_CAP) {
        resampleSamples.copyWithin(
          0,
          resampleHead * 2,
          (resampleHead + resampleFrames) * 2
        );
        resampleHead = 0;
      }
      resampleSamples.set(chunk, (resampleHead + resampleFrames) * 2);
      resampleFrames += chunkFrames;
    }
  }

  function cubicSample(y0, y1, y2, y3, t) {
    var a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    var a1 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    var a2 = -0.5 * y0 + 0.5 * y2;
    return ((a0 * t + a1) * t + a2) * t + y1;
  }

  function generateOutputBlock(frames, sampleRate) {
    frames = frames | 0;
    if (frames < 1) frames = 1024;
    if (sampleRate > 0 && (sampleRate | 0) !== outputRate) {
      outputRate = sampleRate | 0;
      resetOutput();
    }
    if (!(outputRate > 0)) outputRate = SR;
    if (outputRate === SR && resampleFrames === 0)
      return generateSourceBlock(frames);

    var out = acquireOutScratch(frames);
    var step = SR / outputRate;
    var needed = Math.floor(resamplePos + step * Math.max(0, frames - 1)) + 3;
    var i, ch, base, i0, i1, i2, i3, frac, v, drop;
    ensureSourceFrames(needed);
    for (i = 0; i < frames; i++) {
      base = Math.floor(resamplePos);
      frac = resamplePos - base;
      i0 = base > 0 ? base - 1 : 0;
      i1 = base;
      i2 = base + 1 < resampleFrames ? base + 1 : resampleFrames - 1;
      i3 = base + 2 < resampleFrames ? base + 2 : resampleFrames - 1;
      for (ch = 0; ch < 2; ch++) {
        v = cubicSample(
          resampleSamples[(resampleHead + i0) * 2 + ch],
          resampleSamples[(resampleHead + i1) * 2 + ch],
          resampleSamples[(resampleHead + i2) * 2 + ch],
          resampleSamples[(resampleHead + i3) * 2 + ch],
          frac
        );
        out[i * 2 + ch] = F32(v);
      }
      resamplePos += step;
    }
    drop = Math.floor(resamplePos) - 1;
    if (drop > 0) {
      resampleHead += drop;
      resampleFrames -= drop;
      resamplePos -= drop;
    }
    return out.subarray(0, frames * 2);
  }

  function tryLoadWasm() {
    loadError = "";
    try {
      if (typeof importScripts === "function") {
        var loaded = false;
        var names = ["SoundWorker.js?v=gpu14", "./SoundWorker.js?v=gpu14"];
        var ni;
        for (ni = 0; ni < names.length; ni++) {
          try {
            importScripts(names[ni]);
            loaded = true;
            break;
          } catch (eImp) {}
        }
        if (!loaded) {
          loadError = "importScripts SoundWorker.js failed";
          return Promise.resolve(false);
        }
      }
      var factory =
        (typeof createSoundWorkerModule === "function" && createSoundWorkerModule) ||
        (root && root.createSoundWorkerModule) ||
        (typeof globalThis !== "undefined" && globalThis.createSoundWorkerModule);
      if (typeof factory !== "function") {
        loadError = "createSoundWorkerModule missing after SoundWorker.js";
        return Promise.resolve(false);
      }

      var gpuCanvas = null;
      var preGl = null;
      if (!preferCpu) {
        try {
          gpuCanvas = new OffscreenCanvas(2048, 1);
          preGl = gpuCanvas.getContext("webgl2", {
            alpha: false,
            antialias: false,
            depth: true,
            stencil: false,
            preserveDrawingBuffer: false,
            powerPreference: "low-power"
          });
        } catch (eGl) {
          gpuCanvas = null;
          preGl = null;
        }
        if (!preGl)
          loadError = "OffscreenCanvas webgl2 unavailable in worker";
      }

      if (typeof document === "undefined") {
        self.document = {
          getElementById: function () { return null; },
          querySelector: function () { return null; },
          querySelectorAll: function () { return []; },
          createElement: function () {
            return { style: {}, setAttribute: function () {}, appendChild: function () {} };
          },
          body: null,
          documentElement: { style: {} },
          readyState: "complete"
        };
      }

      return factory({
        canvas: gpuCanvas,
        preinitializedWebGLContext: preGl || undefined,
        locateFile: function (path) {
          var p = path;
          if (p === "App.wasm") p = "SoundWorker.wasm";
          try {
            var u = new URL(p, self.location.href);
            u.searchParams.set("v", "gpu14");
            return u.href;
          } catch (e) {
            return p;
          }
        },
        print: function (t) { if (t) console.log("[wasm]", t); },
        printErr: function (t) { if (t) console.warn("[wasm]", t); }
      })
        .then(function (mod) {
          wasm = mod;
          try {
            if (
              typeof wasm._sound_worker_version !== "function" ||
              (wasm._sound_worker_version() | 0) < 22
            ) {
              loadError = "SoundWorker.wasm predates Numeris GPU worker v22";
              wasm = null;
              backend = "gpu-unavailable";
              return false;
            }
          } catch (eVersion) {
            loadError = "SoundWorker.wasm version check failed";
            wasm = null;
            backend = "gpu-unavailable";
            return false;
          }
          try {
            if (typeof wasm._sound_worker_init === "function") wasm._sound_worker_init();
          } catch (eInit) {
            loadError = "init: " + (eInit && eInit.message ? eInit.message : eInit);
            console.warn("[SoundWorkerSsound] init error", eInit);
          }
          try {
            var gpuOk =
              typeof wasm._sound_worker_init_gpu === "function"
                ? wasm._sound_worker_init_gpu() | 0
                : 0;
            if (!gpuOk) {
              var code =
                typeof wasm._sound_worker_gpu_fail_code === "function"
                  ? wasm._sound_worker_gpu_fail_code() | 0
                  : 0;
              loadError = "gpu init failed code=" + code;
              wasm = null;
              backend = "gpu-unavailable";
              return false;
            }
          } catch (eGpu) {
            loadError = "gpu: " + (eGpu && eGpu.message ? eGpu.message : eGpu);
            console.warn("[SoundWorkerSsound] worker GPU init failed", eGpu);
            wasm = null;
            backend = "gpu-unavailable";
            return false;
          }
          buildGpuVariantMap();
          if (!gpuVariants) {
            loadError = "gpu variant table empty";
            wasm = null;
            backend = "gpu-unavailable";
            return false;
          }
          applyEchoSettings(ECHO_DELAY_MS, ECHO_FB, ECHO_MIX);
          backend = "wasm-gpu";
          return true;
        })
        .catch(function (err) {
          loadError = "factory: " + (err && err.message ? err.message : String(err));
          console.warn("[SoundWorkerSsound] wasm load failed", err);
          return false;
        });
    } catch (e) {
      loadError = "tryLoad: " + (e && e.message ? e.message : e);
      return Promise.resolve(false);
    }
  }

  function load(opts) {
    if (opts && opts.preferCpu) preferCpu = true;
    if (loadPromise) return loadPromise;
    if (preferCpu) {
      backend = "gpu-unavailable";
      loadPromise = Promise.resolve("gpu-unavailable");
      return loadPromise;
    }
    loadPromise = tryLoadWasm().then(function (ok) {
      if (!ok && backend !== "wasm-gpu") backend = "gpu-unavailable";
      return backend;
    });
    return loadPromise;
  }

  function wasmAlive() {
    return (backend.indexOf("wasm") === 0) && wasm;
  }

  root.SoundWorkerSsound = {
    load: load,
    getBackend: function () { return backend; },
    getLoadError: function () { return loadError; },
    play: function (desc) { return wasmAlive() ? wasmPlay(desc) : -1; },
    stopAll: function () {
      if (wasmAlive()) wasm._sound_worker_stop_all();
    },
    setMaster: function (vol) {
      if (wasmAlive()) wasm._sound_worker_set_master(vol);
    },
    liveVoices: function () {
      return wasmAlive() ? wasm._sound_worker_live_voices() | 0 : 0;
    },
    generateBlock: function (frames, sampleRate) {
      var out = generateOutputBlock(frames, sampleRate);
      if (wasmAlive()) {
        try {
          if (
            typeof wasm._sound_worker_gpu_pcm_ok === "function" &&
            !(wasm._sound_worker_gpu_pcm_ok() | 0)
          )
            fallbackGpuDead("GPU readback went silent");
        } catch (eBe) {}
      }
      return out;
    },
    getAudioFrame: function () {
      return wasmAlive() && wasm._sound_worker_audio_frame
        ? wasm._sound_worker_audio_frame() | 0 : 0;
    },
    lastPeak: function () {
      return wasmAlive() && wasm._sound_worker_last_peak
        ? +wasm._sound_worker_last_peak() : 0;
    },
    echoLive: function () {
      return wasmAlive() && wasm._sound_worker_last_peak
        ? +wasm._sound_worker_last_peak() > 1e-5 : false;
    },
    setSampleRate: function (sr) {
      if (sr > 0 && (sr | 0) !== outputRate) {
        outputRate = sr | 0;
        resetOutput();
      }
      if (wasmAlive() && wasm._sound_worker_set_sample_rate) {
        try { wasm._sound_worker_set_sample_rate(SR); } catch (e) {}
      }
    },
    setEcho: applyEchoSettings,
    resetOutput: resetOutput,
    setConfigRate: applyConfigRate,
    getConfigRate: function () { return CONFIG_SR; },
    getSynthesisRate: function () { return SR; },
    getOutputRate: function () { return outputRate; }
  };
})(typeof self !== "undefined" ? self : this);

/* ---- worker PCM pump ---- */
(function () {
  "use strict";

  var running = false;
  var pumpPaused = false;
  var tickDelayMs = 16;
  var tickTimer = 0;
  var audioPort = null;
  var blockFrames = 256;
  var targetFrames = 2048;
  var needFrames = 1024;
  var fillBusy = 0;
  var sampleRate = 48000;
  var queuedEstimate = 0;
  var queuedWallMs = 0;
  var pcmBlocksSent = 0;
  var audioPumpTimer = 0;
  var silentPumpTimer = 0;
  var preferCpu = false;
  var synthBlocks = 0;
  var synthLastMs = 0;
  var synthSumMs = 0;
  var synthMaxMs = 0;
  var fillLastMs = 0;
  var fillMaxMs = 0;
  var synthReady = false;
  var pendingPlays = [];
  var pcmPool = [];
  var pcmPoolBytes = 0;
  var stats = { n: 0, last_ms: 0, avg_ms: 0, max_ms: 0, sum_ms: 0 };

  function acquirePcmBuffer(bytes) {
    var ab;
    if (pcmPoolBytes !== bytes) {
      pcmPool.length = 0;
      pcmPoolBytes = bytes;
    }
    ab = pcmPool.pop();
    if (!ab || ab.byteLength !== bytes) ab = new ArrayBuffer(bytes);
    return ab;
  }

  function recycleHint(bytes) {
    if (pcmPoolBytes !== bytes) {
      pcmPool.length = 0;
      pcmPoolBytes = bytes;
    }
    while (pcmPool.length < 4) pcmPool.push(new ArrayBuffer(bytes));
  }

  function fail(reason, detail) {
    postMessage({
      type: "error",
      reason: reason || "unknown",
      detail: detail ? String(detail) : ""
    });
  }

  function emitStats(force) {
    if (!force && (pcmBlocksSent & 63) !== 0) return;
    postMessage({
      type: "stats",
      n: stats.n,
      last_ms: stats.last_ms,
      avg_ms: stats.avg_ms,
      max_ms: stats.max_ms,
      pcm_blocks: pcmBlocksSent,
      queued_est: estimatedQueued(),
      synth_rate:
        typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.getSynthesisRate
          ? SoundWorkerSsound.getSynthesisRate() : 48000,
      output_rate:
        typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.getOutputRate
          ? SoundWorkerSsound.getOutputRate() : sampleRate,
      synth_last_ms: synthLastMs,
      synth_avg_ms: synthBlocks ? synthSumMs / synthBlocks : 0,
      synth_max_ms: synthMaxMs,
      fill_last_ms: fillLastMs,
      fill_max_ms: fillMaxMs,
      voices: typeof SoundWorkerSsound !== "undefined" ? SoundWorkerSsound.liveVoices() : 0,
      ssound: typeof SoundWorkerSsound !== "undefined" ? 1 : 0,
      wasm: typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.getBackend &&
        (SoundWorkerSsound.getBackend().indexOf("wasm") === 0) ? 1 : 0,
      backend: typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.getBackend
        ? SoundWorkerSsound.getBackend() : "gpu-unavailable",
      peak: typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.lastPeak
        ? SoundWorkerSsound.lastPeak() : 0
    });
  }

  function noteQueued(frames) {
    queuedEstimate = frames > 0 ? frames | 0 : 0;
    queuedWallMs = performance.now();
  }

  function estimatedQueued() {
    if (!(sampleRate > 0) || !(queuedWallMs > 0)) return queuedEstimate;
    var elapsed = (performance.now() - queuedWallMs) / 1000;
    if (elapsed < 0) elapsed = 0;
    if (elapsed > 0.5) elapsed = 0.5;
    var consumed = Math.floor(elapsed * sampleRate);
    var q = queuedEstimate - consumed;
    return q > 0 ? q : 0;
  }

  function sendPcmBlock() {
    if (!audioPort) return false;
    var frames = blockFrames;
    var bytes = frames * 2 * 4;
    var synthT0 = performance.now();
    var samples = SoundWorkerSsound.generateBlock(frames, sampleRate);
    var ab = acquirePcmBuffer(bytes);
    var out = new Float32Array(ab);
    out.set(samples);
    recycleHint(bytes);
    synthLastMs = performance.now() - synthT0;
    synthBlocks++;
    synthSumMs += synthLastMs;
    if (synthLastMs > synthMaxMs) synthMaxMs = synthLastMs;
    audioPort.postMessage(
      { type: "pcm", frames: frames, samples: ab },
      [ab]
    );
    queuedEstimate = estimatedQueued() + frames;
    queuedWallMs = performance.now();
    pcmBlocksSent += 1;
    if (pcmBlocksSent <= 4 || (pcmBlocksSent & 31) === 0)
      console.log("[sound_worker] pcm #" + pcmBlocksSent +
        " frames=" + frames + " synthMs=" + synthLastMs.toFixed(1) +
        " peak=" + (SoundWorkerSsound.lastPeak ? SoundWorkerSsound.lastPeak() : 0));
    emitStats(false);
    return true;
  }

  function forcePushBlocks(n) {
    var i;
    if (!audioPort || !running) return;
    n = n > 0 ? n | 0 : 2;
    for (i = 0; i < n; i++) sendPcmBlock();
  }

  function fillToTarget(target) {
    if (!audioPort || !running || !synthReady || fillBusy) return;
    var want = target > 0 ? target : targetFrames;
    var guard = 0;
    var fillT0 = performance.now();
    fillBusy = 1;
    if (want < blockFrames) want = blockFrames;
    if (want > 4096) want = 4096;
    while (running && audioPort && estimatedQueued() < want && guard < 16) {
      sendPcmBlock();
      guard++;
    }
    fillBusy = 0;
    fillLastMs = performance.now() - fillT0;
    if (fillLastMs > fillMaxMs) fillMaxMs = fillLastMs;
  }

  function clearAudioPump() {
    if (audioPumpTimer) {
      clearTimeout(audioPumpTimer);
      audioPumpTimer = 0;
    }
  }

  function clearSilentPump() {
    if (silentPumpTimer) {
      clearTimeout(silentPumpTimer);
      silentPumpTimer = 0;
    }
  }

  function scheduleSilentPump() {
    clearSilentPump();
    if (!running || audioPort || !synthReady) return;
    silentPumpTimer = setTimeout(function () {
      silentPumpTimer = 0;
      if (!running || audioPort || !synthReady) return;
      try {
        SoundWorkerSsound.generateBlock(blockFrames, sampleRate);
      } catch (eSilent) {}
      var live =
        (SoundWorkerSsound.liveVoices && SoundWorkerSsound.liveVoices() > 0) ||
        (SoundWorkerSsound.echoLive && SoundWorkerSsound.echoLive());
      if (live) scheduleSilentPump();
    }, tickDelayMs > 0 ? tickDelayMs : 16);
  }

  function scheduleAudioPump() {
    clearAudioPump();
    if (!running || !audioPort) return;
    var q = estimatedQueued();
    var delay = q >= targetFrames ? 12 : q >= needFrames ? 4 : 2;
    audioPumpTimer = setTimeout(function () {
      audioPumpTimer = 0;
      if (!running || !audioPort || !synthReady) return;
      if (estimatedQueued() < targetFrames) fillToTarget(targetFrames);
      scheduleAudioPump();
    }, delay);
  }

  function onAudioMessage(ev) {
    var msg = ev.data || {};
    if (msg.type === "need") {
      if (!running || pumpPaused) return;
      noteQueued(msg.queuedFrames | 0);
      if (msg.needFrames > 0) needFrames = msg.needFrames | 0;
      if (msg.targetFrames > 0) targetFrames = msg.targetFrames | 0;
      if (targetFrames < 1024) targetFrames = 1024;
      if (targetFrames > 4096) targetFrames = 4096;
      if (needFrames < 256) needFrames = 256;
      if (needFrames > targetFrames) needFrames = targetFrames;
      fillToTarget(targetFrames);
      scheduleAudioPump();
    }
  }

  function attachAudioPort(port) {
    clearSilentPump();
    audioPort = port;
    audioPort.onmessage = onAudioMessage;
    audioPort.start && audioPort.start();
    noteQueued(0);
    console.log("[sound_worker] audio port attached synthReady=" + (synthReady ? 1 : 0));
    if (synthReady) fillToTarget(targetFrames);
    scheduleAudioPump();
    postMessage({ type: "audio-attached", blockFrames: blockFrames, targetFrames: targetFrames });
  }

  function playSound(msg) {
    var id = SoundWorkerSsound.play(msg);
    if ((pcmBlocksSent & 7) === 0)
      console.log("[sound_worker] play " + (msg.soundType || "?") +
        " id=" + id +
        " voices=" + SoundWorkerSsound.liveVoices() +
        " backend=" + SoundWorkerSsound.getBackend());
    postMessage({ type: "played", id: id, voices: SoundWorkerSsound.liveVoices() });
    if (!audioPort) {
      scheduleSilentPump();
      return;
    }
    forcePushBlocks(1);
    fillToTarget(needFrames);
    scheduleAudioPump();
  }

  function clearTick() {
    if (tickTimer) {
      clearTimeout(tickTimer);
      tickTimer = 0;
    }
  }

  onmessage = function (ev) {
    var msg = ev.data || {};
    var type = msg.type;
    try {
      if (type === "init") {
        tickDelayMs = msg.tick_ms > 0 ? msg.tick_ms | 0 : 16;
        blockFrames = msg.blockFrames > 0 ? msg.blockFrames | 0 : 256;
        targetFrames = msg.targetFrames > 0 ? msg.targetFrames | 0 : 2048;
        needFrames = msg.needFrames > 0 ? msg.needFrames | 0 : 1024;
        if (msg.synthRate > 0 && SoundWorkerSsound.setConfigRate)
          SoundWorkerSsound.setConfigRate(msg.synthRate | 0);
        sampleRate = msg.sampleRate > 0 ? +msg.sampleRate : (
          SoundWorkerSsound.getConfigRate ? SoundWorkerSsound.getConfigRate() : 48000);
        preferCpu = !!msg.preferCpu;
        synthReady = false;
        pumpPaused = false;
        pendingPlays.length = 0;
        if (blockFrames < 128) blockFrames = 128;
        if (blockFrames > 512) blockFrames = 512;
        if (targetFrames < 1024) targetFrames = 1024;
        if (needFrames < 256) needFrames = 256;
        running = true;
        if (msg.audioPort) attachAudioPort(msg.audioPort);
        function postReady(backend) {
          var err = SoundWorkerSsound.getLoadError ? SoundWorkerSsound.getLoadError() : "";
          synthReady = true;
          postMessage({
            type: "ready",
            audio: !!audioPort,
            ssound: 1,
            wasm: backend && backend.indexOf("wasm") === 0 ? 1 : 0,
            gpu: backend && backend.indexOf("wasm-gpu") === 0 ? 1 : 0,
            backend: backend || "gpu-unavailable",
            load_error: err || ""
          });
          if (pendingPlays.length) {
            var q = pendingPlays.splice(0, pendingPlays.length);
            for (var qi = 0; qi < q.length; qi++) playSound(q[qi]);
          } else if (audioPort) {
            fillToTarget(targetFrames);
          }
        }
        SoundWorkerSsound.load({ preferCpu: preferCpu })
          .then(postReady)
          .catch(function () { postReady("gpu-unavailable"); });
        return;
      }
      if (type === "set-audio-port") {
        if (msg.blockFrames > 0) blockFrames = msg.blockFrames | 0;
        if (blockFrames < 128) blockFrames = 128;
        if (blockFrames > 512) blockFrames = 512;
        if (msg.targetFrames > 0) targetFrames = msg.targetFrames | 0;
        if (msg.needFrames > 0) needFrames = msg.needFrames | 0;
        if (msg.sampleRate > 0) {
          sampleRate = +msg.sampleRate;
          /* Device rate is the Worklet clock. Do not rewrite the engine
           * (GPU shader) rate — that forces a cubic resample and pitch drift. */
          if (SoundWorkerSsound.setSampleRate)
            SoundWorkerSsound.setSampleRate(sampleRate);
        }
        if (msg.synthRate > 0 && SoundWorkerSsound.setConfigRate)
          SoundWorkerSsound.setConfigRate(msg.synthRate | 0);
        if (!msg.port) {
          fail("missing-audio-port");
          return;
        }
        attachAudioPort(msg.port);
        return;
      }
      if (type === "play") {
        try {
          if (pumpPaused) return;
          if (!running) {
            running = true;
            if (synthReady && audioPort) scheduleAudioPump();
          }
          if (!synthReady) {
            if (pendingPlays.length >= 64) pendingPlays.shift();
            pendingPlays.push(msg);
          } else playSound(msg);
        } catch (ePlay) {
          fail(
            "play-exception",
            (ePlay && ePlay.message ? ePlay.message : ePlay) +
              (ePlay && ePlay.stack ? " | " + ePlay.stack : "")
          );
        }
        return;
      }
      if (type === "stop_all") {
        pendingPlays.length = 0;
        SoundWorkerSsound.stopAll();
        if (SoundWorkerSsound.resetOutput) SoundWorkerSsound.resetOutput();
        if (audioPort) {
          noteQueued(0);
          audioPort.postMessage({ type: "flush" });
          if (synthReady) forcePushBlocks(4);
        }
        postMessage({ type: "stopped_all" });
        return;
      }
      if (type === "shutdown_soft") {
        pendingPlays.length = 0;
        pumpPaused = true;
        running = false;
        clearAudioPump();
        clearSilentPump();
        SoundWorkerSsound.stopAll();
        if (SoundWorkerSsound.resetOutput) SoundWorkerSsound.resetOutput();
        postMessage({ type: "shutdown_soft" });
        return;
      }
      if (type === "resume_soft") {
        pumpPaused = false;
        if (!running) running = true;
        if (synthReady && audioPort) {
          scheduleAudioPump();
          fillToTarget(needFrames > 0 ? needFrames : 768);
        }
        postMessage({ type: "resume_soft" });
        return;
      }
      if (type === "trim_latency") {
        var soft = !!msg.soft;
        var q = estimatedQueued();
        var deep = (targetFrames > 0 ? targetFrames : 2048) * 1.35;
        if (deep < 1536) deep = 1536;
        if (soft && q <= deep) return;
        noteQueued(0);
        if (audioPort) {
          audioPort.postMessage({ type: "flush" });
          var pad = Math.max(blockFrames, ((sampleRate > 0 ? sampleRate : 48000) * 0.006) | 0);
          try {
            audioPort.postMessage({
              type: "pcm",
              frames: pad,
              samples: new Float32Array(pad * 2)
            });
            noteQueued(pad);
          } catch (ePad) {}
          if (synthReady) fillToTarget(needFrames > 0 ? needFrames : 768);
        }
        return;
      }
      if (type === "set_master") {
        SoundWorkerSsound.setMaster(msg.volume);
        return;
      }
      if (type === "set_echo") {
        if (SoundWorkerSsound.setEcho)
          SoundWorkerSsound.setEcho(msg.delayMs, msg.feedback, msg.mix);
        return;
      }
      if (type === "ping") {
        emitStats(true);
        return;
      }
      if (type === "stop") {
        running = false;
        pumpPaused = true;
        audioPort = null;
        clearTick();
        clearAudioPump();
        postMessage({ type: "stopped", n: stats.n, pcm_blocks: pcmBlocksSent });
        return;
      }
    } catch (err) {
      fail("worker-exception", err && err.message ? err.message : err);
      running = false;
      clearTick();
      clearAudioPump();
    }
  };
})();
