/* Proto bus - AudioWorklet inline synth (default) + optional GPU worker PCM.
 *
 * Android note: AudioWorklet requires a secure context (HTTPS or localhost).
 * Testing via http://192.168.x.x fails with audioWorklet === undefined.
 * Fallback uses ScriptProcessorNode on the main thread.
 *
 * inlineSynth (default): NO OffscreenCanvas worker - avoids multi-second WASM/GL
 * cold start. Worker is only spawned when inlineSynth:false (PCM proto path).
 */
(function (global) {
  "use strict";

  function workerSupported(needsCanvas) {
    return (
      typeof Worker !== "undefined" &&
      (!needsCanvas || typeof OffscreenCanvas !== "undefined")
    );
  }

  function hasAudioContext() {
    return typeof AudioContext !== "undefined" || typeof webkitAudioContext !== "undefined";
  }

  function isSecureEnough() {
    try {
      if (global.isSecureContext) return true;
    } catch (e) {}
    var h = (global.location && location.hostname) || "";
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  }

  function isMobileUa() {
    try {
      return /Android|iPhone|iPad|iPod|Mobile/i.test(
        (global.navigator && navigator.userAgent) || ""
      );
    } catch (e) {
      return false;
    }
  }

  /* Inline path only needs AudioContext. Worker path needs Worker+OffscreenCanvas. */
  function audioSupported() {
    return hasAudioContext();
  }

  function workletSupported(ctx) {
    return !!(
      ctx &&
      ctx.audioWorklet &&
      typeof ctx.audioWorklet.addModule === "function" &&
      typeof AudioWorkletNode !== "undefined"
    );
  }

  function locate(name, explicit) {
    if (explicit) return explicit;
    if (typeof global.Module !== "undefined" && typeof global.Module.locateFile === "function") {
      try {
        return global.Module.locateFile(name);
      } catch (e) {}
    }
    return name;
  }

  function workletUrl(opts) {
    var workletPath = locate("spin_audio_processor.js", opts && opts.workletUrl);
    /* Cache-bust: browsers pin AudioWorklet modules hard across reloads. */
    if (workletPath.indexOf("?") < 0) workletPath += "?v=desk16";
    else workletPath += "&v=desk16";
    return workletPath;
  }

  function createBus(opts) {
    opts = opts || {};
    var mobile = isMobileUa();
    /* Desktop-correct path (conversation start): worker synth @44.1k → Worklet PCM.
     * Old App.wasm may still pass inlineSynth:true — ignore it. Use forceInlineSynth
     * only for deliberate A/B tests. */
    var inlineSynth = !!opts.forceInlineSynth;
    var state = {
      ok: false,
      ready: false,
      audioReady: false,
      audioPath: "",
      error: "",
      worker: null,
      audioCtx: null,
      worklet: null,
      scriptNode: null,
      audioPort: null,
      workletUrl: null,
      _workletModuleReady: false,
      _warmPromise: null,
      _startPromise: null,
      _unlockAttempts: 0,
      _unlockStarted: false,
      audioStage: "waiting-gesture",
      stats: {
        n: 0,
        last_ms: 0,
        avg_ms: 0,
        max_ms: 0,
        frame: 0,
        stall_ms: 0,
        stall_mode: "async",
        sample0: 0,
        pcm_blocks: 0,
        queued_est: 0,
        underruns: 0,
        underrunFrames: 0,
        maxGapMs: 0,
        minQueuedFrames: 0,
        fillWaitMs: 0,
        fillWaitMaxMs: 0,
        bufferBoostFrames: 0,
        queuedFrames: 0,
        voices: 0,
        ssound: 0,
        wasm: 0,
        gpu: 0,
        droppedStarts: 0
      },
      renderer: "",
      vendor: "",
      width: opts.width > 0 ? opts.width | 0 : 1024,
      height: opts.height > 0 ? opts.height | 0 : 1,
      blockFrames: opts.blockFrames > 0 ? opts.blockFrames | 0 : 1024,
      /* Deeper FIFO on mobile — absorbs raytracer stalls without changing timbre. */
      targetFrames: opts.targetFrames > 0 ? opts.targetFrames | 0 : (mobile ? 12288 : 4096),
      needFrames: opts.needFrames > 0 ? opts.needFrames | 0 : (mobile ? 6144 : 2048),
      /* 0 = device rate. Worker keeps synth at 44.1k and resamples (desktop-good path). */
      sampleRate: opts.sampleRate > 0 ? opts.sampleRate | 0 : 0,
      legacyTimeScale: opts.legacyTimeScale > 0 ? +opts.legacyTimeScale : 1.0,
      toneHz: opts.toneHz > 0 ? +opts.toneHz : 440,
      preferCpu: !!opts.preferCpu,
      inlineSynth: inlineSynth,
      mobile: mobile
    };

    if (!audioSupported()) {
      state.error = "audio-unsupported";
      return state;
    }

    /* ---- optional GPU worker (PCM proto only) ---- */
    if (!inlineSynth) {
      if (!workerSupported(!state.preferCpu)) {
        state.error = "worker-unsupported";
        return state;
      }
      var url = locate("sound_worker_proto.js", opts.workerUrl);
      if (url.indexOf("?") < 0) url += "?v=desk16";
      else url += "&v=desk16";
      var worker;
      try {
        worker = new Worker(url);
      } catch (err) {
        state.error = "worker-create:" + (err && err.message ? err.message : err);
        return state;
      }

      /* CPU synth does not need another WebGL context beside the raytracer. */
      var canvas = state.preferCpu ? null : new OffscreenCanvas(state.width, state.height);
      worker.onmessage = function (ev) {
        var msg = ev.data || {};
        if (msg.type === "ready") {
          state.ready = true;
          state.ok = true;
          state.renderer = msg.renderer || "";
          state.vendor = msg.vendor || "";
          state.stats.ssound = msg.ssound | 0;
          state.stats.wasm = msg.wasm | 0;
          state.stats.gpu = msg.gpu | 0;
          state.stats.backend = msg.backend || "";
          if (typeof opts.onReady === "function") opts.onReady(state, msg);
          return;
        }
        if (msg.type === "audio-attached") {
          state.audioReady = true;
          if (typeof opts.onAudioAttached === "function") opts.onAudioAttached(state, msg);
          return;
        }
        if (msg.type === "stats") {
          state.stats.n = msg.n | 0;
          state.stats.last_ms = +msg.last_ms || 0;
          state.stats.avg_ms = +msg.avg_ms || 0;
          state.stats.max_ms = +msg.max_ms || 0;
          state.stats.frame = msg.frame | 0;
          state.stats.stall_ms = +msg.stall_ms || 0;
          state.stats.stall_mode = msg.stall_mode || "async";
          state.stats.sample0 = msg.sample0 | 0;
          state.stats.pcm_blocks = msg.pcm_blocks | 0;
          state.stats.queued_est = msg.queued_est | 0;
          state.stats.voices = msg.voices | 0;
          state.stats.ssound = msg.ssound | 0;
          state.stats.wasm = msg.wasm | 0;
          state.stats.backend = msg.backend || "";
          state.stats.peak = +msg.peak || 0;
          state.stats.synthRate = msg.synth_rate | 0;
          state.stats.outputRate = msg.output_rate | 0;
          state.stats.synthLastMs = +msg.synth_last_ms || 0;
          state.stats.synthAvgMs = +msg.synth_avg_ms || 0;
          state.stats.synthMaxMs = +msg.synth_max_ms || 0;
          state.stats.workerFillLastMs = +msg.fill_last_ms || 0;
          state.stats.workerFillMaxMs = +msg.fill_max_ms || 0;
          if (typeof opts.onStats === "function") opts.onStats(state, msg);
          return;
        }
        if (msg.type === "error") {
          state.ok = false;
          state.ready = false;
          state.error = (msg.reason || "error") + (msg.detail ? ":" + msg.detail : "");
          if (typeof opts.onError === "function") opts.onError(state, msg);
          return;
        }
        if (msg.type === "stopped") {
          state.ready = false;
          state.audioReady = false;
          if (typeof opts.onStopped === "function") opts.onStopped(state, msg);
        }
      };
      worker.onerror = function (err) {
        state.ok = false;
        state.error = "worker-onerror:" + (err && err.message ? err.message : "unknown");
        if (typeof opts.onError === "function") opts.onError(state, { reason: state.error });
      };

      try {
        var initMsg = {
          type: "init",
          canvas: canvas,
          width: state.width,
          height: state.height,
          stall_ms: opts.stallMs > 0 ? +opts.stallMs : 0,
          tick_ms: opts.tickMs > 0 ? opts.tickMs | 0 : 16,
          blockFrames: state.blockFrames,
          targetFrames: state.targetFrames,
          needFrames: state.needFrames,
          sampleRate: state.sampleRate || 44100,
          toneHz: state.toneHz,
          preferCpu: state.preferCpu
        };
        if (canvas) worker.postMessage(initMsg, [canvas]);
        else worker.postMessage(initMsg);
      } catch (err) {
        state.error = "postMessage:" + (err && err.message ? err.message : err);
        try {
          worker.terminate();
        } catch (e2) {}
        return state;
      }
      state.worker = worker;
    } else {
      /* Inline: ready immediately - no WASM/GL worker cold start. */
      state.ready = true;
      state.ok = true;
      state.renderer = "worklet-inline";
      if (typeof opts.onReady === "function") {
        try {
          opts.onReady(state, { renderer: state.renderer });
        } catch (eReady) {}
      }
    }

    state.ok = true;

    /* Prefetch only. Creating/compiling on a suspended AudioContext here made
     * Android wait before resume(), after the touch activation had expired. */
    state._warmPromise = (async function warmWorklet() {
      if (!hasAudioContext()) return;
      try {
        var path = workletUrl(opts);
        try {
          await fetch(path, { credentials: "same-origin", cache: "force-cache" });
        } catch (eFetch) {}
        console.log("[sound_bus] worklet source prefetched" + (mobile ? " mobile" : ""));
      } catch (eWarm) {
        console.warn("[sound_bus] worklet warm failed (will retry on gesture)", eWarm);
      }
    })();

    /* Detach Sokol main-thread ScriptProcessor ASAP (FPS must not pace audio). */
    (function detachMainSaudioSoon() {
      function kill() {
        try {
          if (typeof Module === "undefined") return;
          if (Module._saudio_node) {
            try {
              Module._saudio_node.disconnect();
            } catch (e0) {}
            Module._saudio_node.onaudioprocess = null;
            Module._saudio_node = null;
          }
          if (Module._saudio_context) {
            try {
              if (state.audioCtx && Module._saudio_context === state.audioCtx) return;
              Module._saudio_context.close();
            } catch (e1) {}
            Module._saudio_context = null;
          }
        } catch (e2) {}
      }
      kill();
      setTimeout(kill, 50);
      setTimeout(kill, 500);
    })();

    state.setStall = function (ms, mode) {
      if (state.worker)
        state.worker.postMessage({
          type: "set_stall",
          ms: ms > 0 ? +ms : 0,
          mode: mode === "busy" ? "busy" : "async"
        });
    };
    state.setTone = function (hz, gain) {
      if (state.worker)
        state.worker.postMessage({
          type: "set_tone",
          hz: hz > 0 ? +hz : 0,
          gain: gain >= 0 ? +gain : -1
        });
    };
    state.ping = function () {
      if (state.worker) state.worker.postMessage({ type: "ping" });
    };

    state._pendingPlays = [];

    function sendPlayReady(desc) {
      var msg = { type: "play" };
      var k;
      if (desc)
        for (k in desc)
          if (Object.prototype.hasOwnProperty.call(desc, k)) msg[k] = desc[k];
      if (state.inlineSynth && state.worklet && state.worklet.port) {
        state.worklet.port.postMessage(msg);
        return 1;
      }
      if (state._scriptPlay) {
        state._scriptPlay(desc || {});
        return 1;
      }
      if (!state.worker) return -1;
      state.worker.postMessage(msg);
      return 1;
    }

    function flushPendingPlays() {
      var q = state._pendingPlays.splice(0, state._pendingPlays.length);
      var i;
      for (i = 0; i < q.length; i++) sendPlayReady(q[i]);
    }

    state.play = function (desc) {
      if (state.audioReady) return sendPlayReady(desc || {});

      /* Events emitted before the autoplay gesture are already stale. Replaying
       * that whole backlog at unlock caused a clipped pop and an owl-like chord. */
      if (!state._unlockStarted) {
        state.stats.droppedStarts++;
        return 1;
      }
      if (state._pendingPlays.length >= 32) state._pendingPlays.shift();
      state._pendingPlays.push(desc || {});
      return 1;
    };
    state.stopAll = function () {
      if (state.inlineSynth && state.worklet && state.worklet.port)
        state.worklet.port.postMessage({ type: "stop_all" });
      if (state.worker) state.worker.postMessage({ type: "stop_all" });
    };
    state.setMaster = function (vol) {
      if (state.inlineSynth && state.worklet && state.worklet.port)
        state.worklet.port.postMessage({ type: "set_master", volume: vol });
      if (state.worker) state.worker.postMessage({ type: "set_master", volume: vol });
    };

    function attachWorkerAudioPort(port) {
      if (!state.worker) return;
      state.worker.postMessage(
        {
          type: "set-audio-port",
          port: port,
          blockFrames: state.blockFrames,
          targetFrames: state.targetFrames,
          needFrames: state.needFrames,
          sampleRate: state.sampleRate || 44100,
          toneHz: state.toneHz
        },
        [port]
      );
    }

    function startScriptProcessorFallback(ctx) {
      /* Last resort - still main-thread. Prefer Worklet. Inline synth here so we
       * at least don't depend on a lagging worker FIFO. */
      console.warn("[sound_bus] ScriptProcessor fallback (main-thread - avoid if possible)");
      var voices = [];
      var nextId = 1;
      var frame = 0;
      var master = 1.0;
      var underruns = 0;

      function hash1(p) {
        var p2x = (p * 5.3983) % 1; if (p2x < 0) p2x += 1;
        var p2y = (p * 5.4427) % 1; if (p2y < 0) p2y += 1;
        var d = p2y * (p2x + 21.5351) + p2x * (p2y + 14.3137);
        p2x += d;
        p2y += d;
        var r = (p2x * p2y * 95.4337) % 1;
        return r < 0 ? r + 1 : r;
      }
      function noise(n) {
        var f = n - Math.floor(n); n = Math.floor(n);
        f = f * f * (3 - 2 * f);
        return hash1(n) * (1 - f) + hash1(n + 1) * f - 0.5;
      }
      function noiseSlope(n, loc) {
        var f = n - Math.floor(n); n = Math.floor(n);
        if (loc <= 0) f = f >= 1 ? 1 : 0;
        else {
          f = f / loc;
          if (f < 0) f = 0;
          if (f > 1) f = 1;
          f = f * f * (3 - 2 * f);
        }
        return hash1(n) * (1 - f) + hash1(n + 1) * f;
      }
      function smoothstep(edge0, edge1, x) {
        var k = (x - edge0) / (edge1 - edge0);
        if (k < 0) k = 0;
        if (k > 1) k = 1;
        return k * k * (3 - 2 * k);
      }
      function tweetVolume(t) {
        var n1 = noiseSlope(t * 11.0, 0.3);
        var n2 = smoothstep(0.0, 1.0, Math.abs(Math.sin(t * 14.0)));
        var n3 = smoothstep(0.4, 0.9, noiseSlope(t * 0.5 + 4.0, 0.3));
        var n = n1 * n2 * 0.2 * n3;
        n *= n;
        return n < 0 ? 0 : n > 1 ? 1 : n;
      }
      function tweet(t) {
        t -= 1.5;
        var f = Math.sin(6.2831 * 2.0 * t) * noise(t * 8.1 - 100.0) * 100.0 + 5000.0;
        f += Math.cos(50.0 * 6.2831 * t);
        return Math.sin(6.2831 * f * t);
      }
      function sampleTweet(t, fx, fy) {
        return tweet((t + fx) * 0.4) *
          tweetVolume((t + fy - 0.5) * 0.6) * 20.0;
      }
      function decaySeconds(envelop) {
        var d = envelop > 1e-6 ? Math.log(0.001) / -envelop : 0.5;
        if (!isFinite(d) || d < 0) d = 0.5;
        return d > 4 ? 4 : d;
      }

      state._scriptPlay = function (desc) {
        var envelop = desc.envelop >= 0 ? +desc.envelop : 8.0;
        var duration = desc.duration > 0 ? +desc.duration : 0.08;
        voices.push({
          start: frame,
          duration: duration,
          totalLife: duration + decaySeconds(envelop),
          volume: desc.volume >= 0 ? +desc.volume : 0.6,
          fadein: desc.fadein >= 0 ? +desc.fadein : 0.0000006,
          envelop: envelop,
          freqX: desc.freqX != null ? +desc.freqX : 2,
          freqY: desc.freqY != null ? +desc.freqY : 4,
          id: nextId++
        });
      };
      state._scriptStopAll = function () { voices.length = 0; };

      /* Large buffer: ScriptProcessor runs on the RENDER thread. Under a heavy
       * WebGL frame it is the only reason FPS can glitch audio on HTTP Android.
       * Prefer HTTPS + AudioWorklet (path worklet-inline) to fully decouple. */
      var bufSize = state.mobile ? 4096 : 2048;
      if (!ctx.createScriptProcessor) throw new Error("no-script-processor");
      var sp = ctx.createScriptProcessor(bufSize, 0, 2);
      sp.onaudioprocess = function (e) {
        var left = e.outputBuffer.getChannelData(0);
        var right = e.outputBuffer.getChannelData(1);
        var n = left.length;
        var sr = ctx.sampleRate;
        var scale = state.legacyTimeScale > 1e-6 ? state.legacyTimeScale : 1.0;
        var i, vi, v, t, synthT, env, g, still = [];
        for (i = 0; i < n; i++) { left[i] = 0; right[i] = 0; }
        for (vi = 0; vi < voices.length; vi++) {
          v = voices[vi];
          if (frame >= v.start + Math.ceil(v.totalLife * sr / scale)) continue;
          still.push(v);
          for (i = 0; i < n; i++) {
            var af = frame + i;
            if (af < v.start) continue;
            t = (af - v.start) / sr;
            synthT = t * scale;
            env = synthT < v.duration ? 1.0 :
              Math.exp(-v.envelop * (synthT - v.duration));
            if (v.fadein > 1e-12 && synthT < v.fadein)
              env *= synthT / v.fadein;
            if (env <= 0) continue;
            g = sampleTweet(synthT, v.freqX, v.freqY) * v.volume * env * master;
            if (g > 1) g = 1; else if (g < -1) g = -1;
            left[i] += g; right[i] += g;
          }
        }
        voices = still;
        for (i = 0; i < n; i++) {
          if (left[i] > 1) left[i] = 1; else if (left[i] < -1) left[i] = -1;
          if (right[i] > 1) right[i] = 1; else if (right[i] < -1) right[i] = -1;
        }
        frame += n;
        state.stats.underruns = underruns;
        state.stats.queuedFrames = voices.length;
        state.stats.voices = voices.length;
      };
      sp.connect(ctx.destination);
      state.scriptNode = sp;
      state.audioPath = "script-inline";
      state.audioReady = true;
      /* Route play to script when worklet unavailable. */
      var prevPlay = state.play;
      state.play = function (desc) {
        if (!state.audioReady && state.startAudio) try { state.startAudio(); } catch (e) {}
        if (state._scriptPlay) { state._scriptPlay(desc || {}); return 1; }
        return prevPlay(desc);
      };
      state.stopAll = function () {
        if (state._scriptStopAll) state._scriptStopAll();
        if (state.worker) state.worker.postMessage({ type: "stop_all" });
      };
    }

    async function startWorkletPath(ctx) {
      var path = workletUrl(opts);
      if (!state._workletModuleReady) {
        try {
          await ctx.audioWorklet.addModule(path);
        } catch (e1) {
          var src = await fetch(path).then(function (r) {
            if (!r.ok) throw new Error("worklet-fetch");
            return r.text();
          });
          var blob = new Blob([src], { type: "application/javascript" });
          state.workletUrl = URL.createObjectURL(blob);
          await ctx.audioWorklet.addModule(state.workletUrl);
        }
        state._workletModuleReady = true;
      }

      var node = new AudioWorkletNode(ctx, "spin-audio-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {
          mode: state.inlineSynth ? "inline" : "pcm",
          maxVoices: state.mobile ? 10 : 20,
          /* Same tweet.sound formula and historical clock on every device. */
          lightSynth: false,
          legacyTimeScale: state.legacyTimeScale
        }
      });
      node.port.onmessage = function (ev) {
        var msg = ev.data || {};
        if (msg.type === "stats") {
          state.stats.underruns = msg.underruns | 0;
          state.stats.underrunFrames = msg.underrunFrames | 0;
          state.stats.maxGapMs = +msg.maxGapMs || 0;
          state.stats.minQueuedFrames = msg.minQueuedFrames | 0;
          state.stats.fillWaitMs = +msg.fillWaitMs || 0;
          state.stats.fillWaitMaxMs = +msg.fillWaitMaxMs || 0;
          state.stats.bufferBoostFrames = msg.bufferBoostFrames | 0;
          state.stats.queuedFrames = msg.queuedFrames | 0;
          state.stats.voices = msg.voices | 0;
          state.stats.audioMode = msg.mode || (state.inlineSynth ? "inline" : "pcm");
          if (typeof opts.onAudioStats === "function") opts.onAudioStats(state, msg);
        }
      };

      if (state.inlineSynth) {
        node.port.postMessage({ type: "set-mode", mode: "inline" });
        node.connect(ctx.destination);
        state.worklet = node;
        state.audioPath = "worklet-inline";
        state.audioReady = true;
        return;
      }

      var channel = new MessageChannel();
      attachWorkerAudioPort(channel.port1);
      node.port.postMessage(
        {
          type: "set-source-port",
          port: channel.port2,
          needFrames: state.needFrames,
          targetFrames: state.targetFrames
        },
        [channel.port2]
      );

      node.connect(ctx.destination);
      state.worklet = node;
      state.audioPath = "worklet-pcm";
      state.audioReady = true;
    }

    function killMainThreadSaudio() {
      /* Sokol WebAudio = ScriptProcessor on the MAIN thread - FPS drops stretch/starve it.
       * Worklet must be the only device owner. Sokol may recreate saudio after init. */
      try {
        if (typeof Module === "undefined") return;
        if (Module._saudio_node) {
          try {
            Module._saudio_node.disconnect();
          } catch (e0) {}
          Module._saudio_node.onaudioprocess = null;
          Module._saudio_node = null;
        }
        if (Module._saudio_context) {
          try {
            /* Do not close if it is our bus context. */
            if (state.audioCtx && Module._saudio_context === state.audioCtx) return;
            Module._saudio_context.close();
          } catch (e1) {}
          Module._saudio_context = null;
        }
      } catch (eKill) {}
    }

    /* Keep killing saudio: the raytracer / ssound init can recreate it later. */
    if (!state._saudioWatch) {
      state._saudioWatch = setInterval(killMainThreadSaudio, 500);
    }

    state.startAudio = function () {
      var resumePromise;
      if (!audioSupported()) {
        state.error = "audio-unsupported";
        state.audioStage = "error";
        return Promise.reject(new Error(state.error));
      }
      if (!state._unlockStarted) {
        state.stats.droppedStarts += state._pendingPlays.length;
        state._pendingPlays.length = 0;
        state._unlockStarted = true;
      }
      state._unlockAttempts++;
      if (state.worklet || state.scriptNode) {
        state.audioStage = "resume";
        try {
          resumePromise =
            state.audioCtx && state.audioCtx.state !== "running"
              ? state.audioCtx.resume()
              : Promise.resolve();
        } catch (resumeErr0) {
          state.error = "resume:" + String(resumeErr0 && resumeErr0.message ? resumeErr0.message : resumeErr0);
          return Promise.reject(resumeErr0);
        }
        return (async function () {
          await resumePromise;
          state.audioReady = true;
          state.audioStage = "ready";
          state.error = "";
          flushPendingPlays();
          return state;
        })();
      }

      killMainThreadSaudio();
      var AC = global.AudioContext || global.webkitAudioContext;
      var ctx = state.audioCtx;
      if (!ctx) {
        var acOpts = { latencyHint: "interactive" };
        /* Device native rate. Synth stays @44.1k in the worker and resamples —
         * same path that sounded correct on desktop WebGL. */
        if (state.sampleRate > 0) acOpts.sampleRate = state.sampleRate;
        ctx = new AC(acOpts);
        state.audioCtx = ctx;
      }
      state.sampleRate = ctx.sampleRate | 0;
      console.log(
        "[sound_bus] AudioContext " + state.sampleRate + " Hz | synth 44100 → resample"
      );
      state.audioStage = "resume";
      try {
        /* Invoke resume synchronously inside pointer/touch/key activation. Do not
         * put any await before this call: Chrome Android expires activation. */
        resumePromise = ctx.state !== "running" ? ctx.resume() : Promise.resolve();
      } catch (resumeErr) {
        state.error = "resume:" + String(resumeErr && resumeErr.message ? resumeErr.message : resumeErr);
        state.audioStage = "error";
        return Promise.reject(resumeErr);
      }

      /* Do not reserve _startPromise until resume resolves. A denied/parked
       * Android resume must not prevent a later real gesture from retrying. */
      return Promise.resolve(resumePromise).then(function () {
        if (state.worklet || state.scriptNode) {
          state.audioReady = true;
          state.audioStage = "ready";
          state.error = "";
          flushPendingPlays();
          return state;
        }
        if (state._startPromise) return state._startPromise;

        state._startPromise = (async function () {
          /* Prefetch is deliberately not awaited here: a slow HTTP request used
           * to leave the HUD on TAP forever after AudioContext had resumed. */
          if (workletSupported(ctx)) {
            state.audioStage = "worklet";
            try {
              await startWorkletPath(ctx);
            } catch (err) {
              console.warn("[sound_bus] worklet failed, falling back to ScriptProcessor", err);
              state.audioStage = "fallback";
              await startScriptProcessorFallback(ctx);
            }
          } else {
            state.audioStage = "fallback";
            console.warn(
              "[sound_bus] AudioWorklet unavailable (secure context? " +
                isSecureEnough() +
                ") - ScriptProcessor fallback"
            );
            await startScriptProcessorFallback(ctx);
          }

          killMainThreadSaudio();
          state.audioReady = true;
          state.audioStage = "ready";
          state.error = "";
          flushPendingPlays();

          if (typeof opts.onAudioReady === "function") opts.onAudioReady(state);
          return state;
        })();
        state._startPromise = state._startPromise.then(
          function (result) {
            state._startPromise = null;
            return result;
          },
          function (err) {
            state._startPromise = null;
            state.audioStage = "error";
            throw err;
          }
        );
        return state._startPromise;
      }, function (err) {
        state.audioStage = "resume-denied";
        state.error = "resume:" + String(err && err.message ? err.message : err);
        throw err;
      });
    };

    state.stop = function () {
      if (state.worklet) {
        try {
          state.worklet.disconnect();
        } catch (e) {}
        state.worklet = null;
      }
      if (state.scriptNode) {
        try {
          state.scriptNode.disconnect();
        } catch (e0) {}
        state.scriptNode.onaudioprocess = null;
        state.scriptNode = null;
      }
      state.audioPort = null;
      if (state.audioCtx) {
        try {
          state.audioCtx.close();
        } catch (e2) {}
        state.audioCtx = null;
      }
      if (state.workletUrl) {
        try {
          URL.revokeObjectURL(state.workletUrl);
        } catch (e3) {}
        state.workletUrl = null;
      }
      if (state.worker) {
        try {
          state.worker.postMessage({ type: "stop" });
        } catch (e4) {}
        try {
          state.worker.terminate();
        } catch (e5) {}
        state.worker = null;
      }
      state.ready = false;
      state.audioReady = false;
      state.audioPath = "";
    };

    return state;
  }

  var api = {
    supported: workerSupported,
    workerSupported: workerSupported,
    audioSupported: audioSupported,
    workletSupported: function () {
      try {
        if (!hasAudioContext()) return false;
        if (!isSecureEnough() && typeof AudioWorkletNode === "undefined") return false;
        return typeof AudioWorkletNode !== "undefined";
      } catch (e) {
        return false;
      }
    },
    isSecureEnough: isSecureEnough,
    create: createBus
  };
  global.SoundBusProto = api;
  if (typeof global.Module !== "undefined") {
    global.Module.SoundBusProto = api;
  }
})(typeof self !== "undefined" ? self : this);
