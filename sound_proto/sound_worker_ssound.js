/* Proto 3 — SoundWorkerSsound: WASM tweet synth with JS fallback.
 * Tries createSoundWorkerModule (App.js) first; else CPU JS port of tweet.sound.
 */
(function (root) {
  "use strict";

  /* ssound's synthesis clock is fixed at 44.1 kHz. The browser device is
   * commonly 48 kHz, so synthesize the original grid first, then resample. */
  var SR = 44100;
  var outputRate = 44100;
  var voices = [];
  var nextId = 1;
  var audioFrame = 0;
  var master = 1.0;
  var backend = "js";
  var wasm = null;
  var loadPromise = null;
  var F32 = Math.fround;
  var jsLastPeak = 0.0;
  var echoBuffer = new Float32Array(44100 * 2);
  var echoPos = 0;

  function fadd(a, b) { return F32(F32(a) + F32(b)); }
  function fsub(a, b) { return F32(F32(a) - F32(b)); }
  function fmul(a, b) { return F32(F32(a) * F32(b)); }
  function fdiv(a, b) { return F32(F32(a) / F32(b)); }
  function fsin(a) { return F32(Math.sin(F32(a))); }
  function fcos(a) { return F32(Math.cos(F32(a))); }
  function fexp(a) { return F32(Math.exp(F32(a))); }
  function fract32(a) {
    a = F32(a);
    return fsub(a, Math.floor(a));
  }
  function mix32(a, b, t) {
    return fadd(fmul(a, fsub(1, t)), fmul(b, t));
  }
  function smoothstep32(edge0, edge1, x) {
    var t = fdiv(fsub(x, edge0), fsub(edge1, edge0));
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    return fmul(fmul(t, t), fsub(3, fmul(2, t)));
  }

  function Hash1(p) {
    var p2x = fract32(fmul(p, 5.3983));
    var p2y = fract32(fmul(p, 5.4427));
    /* tweet.sound: dot(p2.yx, p2.xy + vec2(21.5351, 14.3137)). */
    var d = fadd(
      fmul(p2y, fadd(p2x, 21.5351)),
      fmul(p2x, fadd(p2y, 14.3137))
    );
    /* Exact tweet.sound order: p2 is not fract()'d again after the dot. */
    p2x = fadd(p2x, d);
    p2y = fadd(p2y, d);
    return fract32(fmul(fmul(p2x, p2y), 95.4337));
  }
  function Noise(n) {
    var f = fract32(n);
    n = Math.floor(F32(n));
    f = fmul(fmul(f, f), fsub(3, fmul(2, f)));
    return fsub(mix32(Hash1(n), Hash1(n + 1), f), 0.5);
  }
  function NoiseSlope(n, loc) {
    var f = fract32(n);
    n = Math.floor(F32(n));
    f = smoothstep32(0, loc, f);
    return mix32(Hash1(n), Hash1(n + 1), f);
  }
  function TweetVolume(t) {
    var n1 = NoiseSlope(fmul(t, 11.0), 0.3);
    var n2 = smoothstep32(0, 1, Math.abs(fsin(fmul(t, 14.0))));
    var n3 = smoothstep32(
      0.4,
      0.9,
      NoiseSlope(fadd(fmul(t, 0.5), 4.0), 0.3)
    );
    var n = fmul(fmul(n1, n2), 0.2);
    n = fmul(n, n3);
    n = fmul(n, n);
    if (n < 0) n = 0;
    if (n > 1) n = 1;
    return F32(n);
  }
  function Tweet(t) {
    t = fsub(t, 1.5);
    var f = fadd(
      fmul(
        fmul(fsin(fmul(fmul(6.2831, 2.0), t)), Noise(fsub(fmul(t, 8.1), 100.0))),
        100.0
      ),
      5000.0
    );
    f = fadd(f, fcos(fmul(fmul(50.0, 6.2831), t)));
    return fsin(fmul(fmul(6.2831, f), t));
  }
  function decaySeconds(envelop) {
    if (!(envelop > 1e-6)) return 0.5;
    var d = Math.log(0.001) / -envelop;
    if (!isFinite(d) || d < 0) return 0.5;
    return d > 4 ? 4 : d;
  }
  function envelope(t, duration, fadein, envelop) {
    if (t < 0 || t > duration + decaySeconds(envelop)) return 0;
    var e = t < duration ? F32(1.0) : fexp(fmul(-envelop, fsub(t, duration)));
    if (fadein > 0 && t < fadein) e = fmul(e, fdiv(t, fadein));
    return e < 0 ? 0 : e > 1 ? 1 : e;
  }
  function sampleTweet(t, freqX, freqY) {
    var volume = fmul(TweetVolume(fmul(fsub(fadd(t, freqY), 0.5), 0.6)), 20.0);
    return fmul(Tweet(fmul(fadd(t, freqX), 0.4)), volume);
  }
  function softClip(x) {
    x = F32(x);
    if (x > -1 && x < 1) return x;
    var a = x < 0 ? F32(-x) : x;
    return x > 0
      ? fadd(1, fmul(0.2, fsub(a, 1)))
      : fsub(-1, fmul(0.2, fsub(a, 1)));
  }
  function resetEcho() {
    echoBuffer.fill(0);
    echoPos = 0;
    jsLastPeak = 0;
  }
  function processEcho(out, frames) {
    var delay = 11025; /* ssound/bfx default: 250 ms at 44.1 kHz */
    var peak = 0, i, ri, inL, inR, wetL, wetR, outL, outR, p;
    for (i = 0; i < frames; i++) {
      ri = echoPos - delay;
      if (ri < 0) ri += 44100;
      inL = out[i * 2];
      inR = out[i * 2 + 1];
      wetL = echoBuffer[ri * 2];
      wetR = echoBuffer[ri * 2 + 1];
      outL = fadd(fmul(0.7, inL), fmul(0.3, wetL));
      outR = fadd(fmul(0.7, inR), fmul(0.3, wetR));
      echoBuffer[echoPos * 2] = softClip(fadd(inL, fmul(wetL, 0.4)));
      echoBuffer[echoPos * 2 + 1] = softClip(fadd(inR, fmul(wetR, 0.4)));
      out[i * 2] = outL;
      out[i * 2 + 1] = outR;
      p = Math.max(Math.abs(outL), Math.abs(outR));
      if (p > peak) peak = p;
      echoPos++;
      if (echoPos >= 44100) echoPos = 0;
    }
    jsLastPeak = peak;
  }

  function jsPlay(desc) {
    desc = desc || {};
    var v = {
      id: nextId++,
      startFrame: audioFrame + (desc.startOffsetFrames | 0),
      duration: F32(desc.duration > 0 ? +desc.duration : 0.35),
      volume: F32(desc.volume >= 0 ? +desc.volume : 0.6),
      fadein: F32(Math.max(0, desc.fadein >= 0 ? +desc.fadein : 0.0000006)),
      envelop: F32(desc.envelop >= 0 ? +desc.envelop : 8.0),
      freqX: F32(desc.freqX != null ? +desc.freqX : 2.0),
      freqY: F32(desc.freqY != null ? +desc.freqY : 4.0),
      freqZ: F32(desc.freqZ != null ? +desc.freqZ : 0.0),
      freqW: F32(desc.freqW != null ? +desc.freqW : 1.0),
      type: desc.soundType || "tweet"
    };
    voices.push(v);
    return v.id;
  }
  function jsStopAll() { voices.length = 0; resetEcho(); }
  function jsSetMaster(vol) { master = F32(vol >= 0 ? +vol : 1); }
  function jsLiveVoices() { return voices.length; }
  function jsGenerateBlock(frames) {
    frames = frames | 0;
    if (frames < 1) frames = 1024;
    var out = new Float32Array(frames * 2);
    var i, vi, v, t, env, sig, g;
    var still = [];
    for (vi = 0; vi < voices.length; vi++) {
      v = voices[vi];
      var endFrame =
        v.startFrame + Math.ceil((v.duration + decaySeconds(v.envelop)) * SR);
      if (audioFrame >= endFrame) continue;
      still.push(v);
      for (i = 0; i < frames; i++) {
        var absFrame = audioFrame + i;
        if (absFrame < v.startFrame) continue;
        t = F32((absFrame - v.startFrame) / SR);
        env = envelope(t, v.duration, v.fadein, v.envelop);
        if (env <= 0) continue;
        if (v.type === "tone")
          sig = fmul(
            fsin(fmul(fmul(F32(2 * Math.PI), v.freqX > 20 ? v.freqX : 440), t)),
            0.15
          );
        else sig = sampleTweet(t, v.freqX, v.freqY);
        g = fmul(fmul(fmul(sig, v.volume), env), master);
        /* tweet.sound returns vec2(signal): the legacy bird is centred, not panned. */
        out[i * 2] = fadd(out[i * 2], g);
        out[i * 2 + 1] = fadd(out[i * 2 + 1], g);
      }
    }
    voices = still;
    audioFrame += frames;
    processEcho(out, frames);
    return out;
  }

  function wasmPlay(desc) {
    desc = desc || {};
    var type = desc.soundType === "tone" ? 1 : 0;
    var vol = desc.volume >= 0 ? +desc.volume : 0.6;
    var dur = desc.duration > 0 ? +desc.duration : 0.35;
    var fadein = Math.max(0, desc.fadein >= 0 ? +desc.fadein : 0.0000006);
    var envelop = desc.envelop >= 0 ? +desc.envelop : 8.0;
    var fx = desc.freqX != null ? +desc.freqX : 2.0;
    var fy = desc.freqY != null ? +desc.freqY : 4.0;
    var fz = desc.freqZ != null ? +desc.freqZ : 0.0;
    var fw = desc.freqW != null ? +desc.freqW : 1.0;
    return wasm._sound_worker_play(type, vol, dur, fadein, envelop, fx, fy, fz, fw) | 0;
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
      ptr = wasm._malloc(bytes);
      if (!ptr) return jsGenerateBlock(frames);
      wasm._sound_worker_generate_block(ptr, frames);
      var out = wasm.HEAPF32.slice(ptr >> 2, (ptr >> 2) + frames * 2);
      wasm._free(ptr);
      return out;
    } catch (eGen) {
      console.warn("[SoundWorkerSsound] generate failed, JS fallback", eGen);
      try {
        if (ptr) wasm._free(ptr);
      } catch (e2) {}
      /* Permanent soft-fallback for this session if GPU path is broken. */
      if (backend.indexOf("wasm-gpu") === 0) backend = "wasm";
      return jsGenerateBlock(frames);
    }
  }

  /* Linear cache avoids join/slice allocations on every 1024-frame refill.
   * Only the generated transferable block is allocated in the worker hot path. */
  var RESAMPLE_CAP = 16384;
  var resampleSamples = new Float32Array(RESAMPLE_CAP * 2);
  var resampleHead = 0;
  var resampleFrames = 0;
  var resamplePos = 0.0;

  function resetOutput() {
    /* Source frames already generated into this cache intentionally become
     * stale after a play/flush. Discard them so the new voice starts now. */
    resampleHead = 0;
    resampleFrames = 0;
    resamplePos = 0.0;
  }

  function generateSourceBlock(frames) {
    if ((backend.indexOf("wasm") === 0) && wasm)
      return wasmGenerateBlock(frames);
    return jsGenerateBlock(frames);
  }

  function ensureSourceFrames(want) {
    var chunk, chunkFrames;
    while (resampleFrames < want) {
      chunk = generateSourceBlock(1024);
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
    /* Catmull-Rom interpolation: preserves the 44.1 kHz waveform far better
     * than evaluating the nonlinear FM formula on a different sample grid. */
    var a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    var a1 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
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

    var out = new Float32Array(frames * 2);
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
    /* Retain one source frame before the next interpolation position. */
    drop = Math.floor(resamplePos) - 1;
    if (drop > 0) {
      resampleHead += drop;
      resampleFrames -= drop;
      resamplePos -= drop;
    }
    return out;
  }

  var loadError = "";

  var preferCpu = false;

  function tryLoadWasm() {
    loadError = "";
    try {
      if (typeof importScripts === "function") {
        var loaded = false;
        var names = [
          "SoundWorker.js?v=desk16",
          "./SoundWorker.js?v=desk16",
          "App.js?v=desk16",
          "./App.js?v=desk16"
        ];
        var ni;
        for (ni = 0; ni < names.length; ni++) {
          try {
            importScripts(names[ni]);
            loaded = true;
            break;
          } catch (eImp) {}
        }
        if (!loaded) {
          loadError = "importScripts SoundWorker.js/App.js failed";
          return Promise.resolve(false);
        }
      }
      /* importScripts puts `var createSoundWorkerModule` on the worker global — not only root. */
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
          gpuCanvas = new OffscreenCanvas(1024, 1);
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
        if (!preGl) {
          loadError = "OffscreenCanvas webgl2 unavailable in worker";
        }
      }

      /* Sokol/emscripten may touch document during GL setup — stub it in workers. */
      if (typeof document === "undefined") {
        self.document = {
          getElementById: function () {
            return null;
          },
          querySelector: function () {
            return null;
          },
          querySelectorAll: function () {
            return [];
          },
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
          /* Built as SoundWorker.wasm; older packs used App.wasm. */
          var p = path;
          if (p === "App.wasm") p = "SoundWorker.wasm";
          try {
            var u = new URL(p, self.location.href);
            u.searchParams.set("v", "desk16");
            return u.href;
          } catch (e) {
            return p;
          }
        },
        print: function (t) {
          if (t) console.log("[wasm]", t);
        },
        printErr: function (t) {
          if (t) console.warn("[wasm]", t);
        }
      })
        .then(function (mod) {
          wasm = mod;
          /* Do not silently use an older worker whose tweet hash/envelope and
           * gain differ from tweet.sound. The corrected JS worker remains a
           * valid off-thread fallback until SoundWorker.wasm is rebuilt. */
          try {
            if (
              typeof wasm._sound_worker_version !== "function" ||
              (wasm._sound_worker_version() | 0) < 10
            ) {
              loadError = "SoundWorker.wasm is older than exact-tweet+bfx v10; using JS worker";
              wasm = null;
              backend = "js";
              return false;
            }
          } catch (eVersion) {
            loadError = "SoundWorker.wasm version check failed; using JS worker";
            wasm = null;
            backend = "js";
            return false;
          }
          try {
            if (typeof wasm._sound_worker_init === "function") wasm._sound_worker_init();
          } catch (eInit) {
            loadError = "init: " + (eInit && eInit.message ? eInit.message : eInit);
            console.warn("[SoundWorkerSsound] init error (keep wasm)", eInit);
          }
          backend = "wasm";
          if (preferCpu) {
            try {
              if (typeof wasm._sound_worker_prefer_cpu === "function")
                wasm._sound_worker_prefer_cpu(1);
            } catch (ePref) {}
            backend = "wasm-cpu";
            return true;
          }
          try {
            if (typeof wasm._sound_worker_init_gpu === "function") {
              var gpuOk = wasm._sound_worker_init_gpu() | 0;
              if (gpuOk) {
                backend = "wasm-gpu";
                if (
                  typeof wasm._sound_worker_gpu_pcm_ok === "function" &&
                  !(wasm._sound_worker_gpu_pcm_ok() | 0)
                ) {
                  backend = "wasm-gpu-cpu";
                }
              } else {
                var code =
                  typeof wasm._sound_worker_gpu_fail_code === "function"
                    ? wasm._sound_worker_gpu_fail_code() | 0
                    : 0;
                if (!loadError)
                  loadError = "gpu init returned 0 code=" + code + " (CPU wasm ok)";
              }
            }
          } catch (eGpu) {
            if (!loadError)
              loadError = "gpu: " + (eGpu && eGpu.message ? eGpu.message : eGpu);
            console.warn("[SoundWorkerSsound] gpu init error (CPU wasm ok)", eGpu);
          }
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
    loadPromise = tryLoadWasm().then(function (ok) {
      if (!ok) backend = "js";
      return backend;
    });
    return loadPromise;
  }

  root.SoundWorkerSsound = {
    load: load,
    getBackend: function () {
      return backend;
    },
    getLoadError: function () {
      return loadError;
    },
    play: function (desc) {
      return (backend.indexOf("wasm") === 0) && wasm ? wasmPlay(desc) : jsPlay(desc);
    },
    stopAll: function () {
      if ((backend.indexOf("wasm") === 0) && wasm) wasm._sound_worker_stop_all();
      else jsStopAll();
    },
    setMaster: function (vol) {
      if ((backend.indexOf("wasm") === 0) && wasm) wasm._sound_worker_set_master(vol);
      else jsSetMaster(vol);
    },
    liveVoices: function () {
      if ((backend.indexOf("wasm") === 0) && wasm) return wasm._sound_worker_live_voices() | 0;
      return jsLiveVoices();
    },
    generateBlock: function (frames, sampleRate) {
      var out = generateOutputBlock(frames, sampleRate);
      if ((backend.indexOf("wasm") === 0) && wasm) {
        try {
          if (
            typeof wasm._sound_worker_backend === "function" &&
            (wasm._sound_worker_backend() | 0) === 2
          )
            backend = "wasm-gpu-cpu";
          else if (
            typeof wasm._sound_worker_gpu_pcm_ok === "function" &&
            backend === "wasm-gpu" &&
            !(wasm._sound_worker_gpu_pcm_ok() | 0)
          )
            backend = "wasm-gpu-cpu";
        } catch (eBe) {}
      }
      return out;
    },
    getAudioFrame: function () {
      if (backend.indexOf("wasm") === 0 && wasm && wasm._sound_worker_audio_frame)
        return wasm._sound_worker_audio_frame() | 0;
      return audioFrame;
    },
    lastPeak: function () {
      if (backend.indexOf("wasm") === 0 && wasm && wasm._sound_worker_last_peak)
        return +wasm._sound_worker_last_peak();
      return jsLastPeak;
    },
    setSampleRate: function (sr) {
      if (sr > 0 && (sr | 0) !== outputRate) {
        outputRate = sr | 0;
        resetOutput();
      }
      if (backend.indexOf("wasm") === 0 && wasm && wasm._sound_worker_set_sample_rate) {
        try {
          wasm._sound_worker_set_sample_rate(SR);
        } catch (e) {}
      }
    },
    resetOutput: resetOutput,
    getSynthesisRate: function () { return SR; },
    getOutputRate: function () { return outputRate; }
  };
})(typeof self !== "undefined" ? self : this);
