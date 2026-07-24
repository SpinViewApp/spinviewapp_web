/* Proto bus - worker PCM @44.1k → resample → AudioWorklet (desktop + Android).
 *
 * Android note: AudioWorklet needs HTTPS/localhost. On plain HTTP the sink falls
 * back to ScriptProcessor but still consumes the SAME worker PCM (script-pcm),
 * not a separate inline synth. Prefer HTTPS so FPS cannot starve the sink.
 */
(function (global) {
  "use strict";

  /* Old App.wasm EM_JS may reference SSOUND_SAMPLE_RATE as a bare JS id
   * (C macros are not expanded inside EM_JS string bodies). */
  if (typeof global.SSOUND_SAMPLE_RATE !== "number")
    global.SSOUND_SAMPLE_RATE = 44100;

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
    if (workletPath.indexOf("?") < 0) workletPath += "?v=andr31";
    else workletPath += "&v=andr31";
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
      _workletModulePromise: null,
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
      /* Shallow start FIFO — deep mobile buffers delayed first audible audio
       * by seconds under ScriptProcessor / slow worker fill. Underrun boost
       * still grows the look-ahead after the first gap. */
      targetFrames: opts.targetFrames > 0 ? opts.targetFrames | 0 : (mobile ? 8192 : 8192),
      needFrames: opts.needFrames > 0 ? opts.needFrames | 0 : (mobile ? 2048 : 2048),
      /* Engine clock (SSOUND_SAMPLE_RATE). Device rate filled after AudioContext. */
      synthRate: opts.synthRate > 0 ? opts.synthRate | 0 : 44100,
      /* 0 until unlock — then AudioContext.sampleRate (may differ → resample). */
      sampleRate: opts.sampleRate > 0 ? opts.sampleRate | 0 : 0,
      convertPath: "pending",
      legacyTimeScale: opts.legacyTimeScale > 0 ? +opts.legacyTimeScale : 1.0,
      /* SOUND_UNLOCK_FADEIN_SEC — ramp when device first becomes audible. */
      unlockFadeSec: opts.unlockFadeSec > 0 ? +opts.unlockFadeSec : 0.12,
      toneHz: opts.toneHz > 0 ? +opts.toneHz : 440,
      preferCpu: !!opts.preferCpu,
      inlineSynth: inlineSynth,
      mobile: mobile
    };

    function refreshConvertPath() {
      var cfg = state.synthRate | 0;
      var dev = state.sampleRate | 0;
      if (!(cfg > 0)) cfg = 44100;
      if (!(dev > 0)) {
        state.convertPath = "pending";
        return state.convertPath;
      }
      state.convertPath =
        cfg === dev ? "identity" : "resample " + cfg + "\u2192" + dev;
      return state.convertPath;
    }

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
      if (url.indexOf("?") < 0) url += "?v=andr31";
      else url += "&v=andr31";
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
          markAudioReadyIfRunning();
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
          state.stats.configRate = state.synthRate | 0;
          state.stats.deviceRate = state.sampleRate | 0;
          state.stats.convertPath = state.convertPath || "";
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
          /* Engine clock until device rate is known via set-audio-port. */
          sampleRate: state.sampleRate || state.synthRate,
          synthRate: state.synthRate,
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

    function markAudioReadyIfRunning() {
      var ctx = state.audioCtx;
      if (ctx && ctx.state === "running" && (state.worklet || state.scriptNode)) {
        state.audioReady = true;
        state.audioStage = "ready";
        state.error = "";
        state._gesturePrimed = true;
        return true;
      }
      state.audioReady = false;
      if (ctx && ctx.state === "suspended") state.audioStage = "suspended";
      else if (ctx) state.audioStage = String(ctx.state || "none");
      return false;
    }

    /* Drop a stuck suspended graph so the next gesture can create a fresh
     * AudioContext (addModule is per-context — cleared too). */
    function nukeAudioGraph() {
      try {
        if (state.worklet) state.worklet.disconnect();
      } catch (e0) {}
      try {
        if (state.scriptNode) {
          state.scriptNode.onaudioprocess = null;
          state.scriptNode.disconnect();
        }
      } catch (e1) {}
      state.worklet = null;
      state.scriptNode = null;
      state.audioPort = null;
      state.audioReady = false;
      state._workletModuleReady = false;
      state._workletModulePromise = null;
      state._gesturePrimed = false;
      try {
        if (state.audioCtx && state.audioCtx.state !== "closed") state.audioCtx.close();
      } catch (e2) {}
      state.audioCtx = null;
      state.audioPath = "";
    }

    function ensureAudioContext() {
      if (state.audioCtx) return state.audioCtx;
      var AC = global.AudioContext || global.webkitAudioContext;
      var acOpts = { latencyHint: "interactive" };
      if (state.sampleRate > 0) acOpts.sampleRate = state.sampleRate;
      var ctx = new AC(acOpts);
      state.audioCtx = ctx;
      state.sampleRate = ctx.sampleRate | 0;
      refreshConvertPath();
      try {
        if (typeof Module !== "undefined" && Module.sound_worker_proto) {
          var stHud = Module.sound_worker_proto;
          stHud.stats = stHud.stats || {};
          stHud.stats.synth_rate = state.synthRate | 0;
          stHud.stats.output_rate = state.sampleRate | 0;
        }
      } catch (eHud) {}
      return ctx;
    }

    /* Android Chrome often ignores resume() alone on touchstart; a sync silent
     * buffer start() in the same turn locks user-activation before touchend/click. */
    function primeHtmlMedia() {
      try {
        var a = state._silentAudio;
        if (!a) {
          /* Minimal WAV — HTMLMediaElement.play() carries stronger gesture
           * activation on Android WebView than AudioContext.resume() alone. */
          a = new Audio(
            "data:audio/wav;base64,UklGRmgAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA="
          );
          a.preload = "auto";
          a.volume = 0.01;
          state._silentAudio = a;
        }
        var p = a.play();
        if (p && typeof p.then === "function")
          p.catch(function () {});
      } catch (eHtml) {}
    }

    function primeAudioGesture(ctx) {
      if (!ctx) return;
      /* Re-prime every attempt until the context is actually running. */
      if (ctx.state === "running" && state._gesturePrimed) return;
      try {
        var buf = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        try {
          var osc = ctx.createOscillator();
          var g = ctx.createGain();
          g.gain.value = 0.0001;
          osc.connect(g);
          g.connect(ctx.destination);
          osc.start(0);
          osc.stop(ctx.currentTime + 0.02);
        } catch (eOsc) {}
        if (ctx.state === "running") state._gesturePrimed = true;
      } catch (ePrime) {}
    }

    function attachWorkletNodeSync(ctx) {
      var node = new AudioWorkletNode(ctx, "spin-audio-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {
          mode: state.inlineSynth ? "inline" : "pcm",
          maxVoices: state.mobile ? 10 : 20,
          lightSynth: false,
          legacyTimeScale: state.legacyTimeScale,
          unlockFadeSec: state.unlockFadeSec
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
        markAudioReadyIfRunning();
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
      markAudioReadyIfRunning();
    }

    /* Prefetch worklet SOURCE only. Do NOT addModule on a suspended context —
     * Chrome Android can hang addModule for seconds until/after resume, and
     * unlock was awaiting that same hung promise (~4s silence after tap). */
    function prefetchWorkletSource() {
      if (state.workletUrl || state._prefetchPromise) return state._prefetchPromise;
      state._prefetchPromise = (async function () {
        var path = workletUrl(opts);
        var src = await fetch(path, { credentials: "same-origin", cache: "force-cache" }).then(
          function (r) {
            if (!r.ok) throw new Error("worklet-fetch");
            return r.text();
          }
        );
        var blob = new Blob([src], { type: "application/javascript" });
        state.workletUrl = URL.createObjectURL(blob);
      })();
      return state._prefetchPromise;
    }

    function ensureWorkletModule(ctx) {
      if (state._workletModuleReady) return Promise.resolve();
      if (state._workletModulePromise) return state._workletModulePromise;
      state._workletModulePromise = (async function () {
        try {
          await prefetchWorkletSource();
        } catch (ePref) {}
        var url = state.workletUrl || workletUrl(opts);
        await ctx.audioWorklet.addModule(url);
        state._workletModuleReady = true;
      })();
      return state._workletModulePromise;
    }

    state._warmPromise = (async function warmWorklet() {
      if (!hasAudioContext()) return;
      try {
        state.audioStage = "warming";
        await prefetchWorkletSource();
        if (!state._unlockStarted) state.audioStage = "waiting-gesture";
        console.log("[sound_bus] worklet source cached (addModule deferred until after resume)");
      } catch (eWarm) {
        console.warn("[sound_bus] worklet prefetch failed (will retry on gesture)", eWarm);
        if (!state._unlockStarted) state.audioStage = "waiting-gesture";
      }
    })();

    /* Device ownership is C-side (ssound_set_no_saudio). After App.wasm rebuild,
     * Sokol never creates _saudio_node. One-shot detach only covers older builds
     * that still called saudio_setup before the flag existed — not a watchdog. */
    try {
      if (typeof Module !== "undefined" && Module._saudio_node) {
        try { Module._saudio_node.disconnect(); } catch (e0) {}
        Module._saudio_node.onaudioprocess = null;
        Module._saudio_node = null;
        if (Module._saudio_context &&
            !(state.audioCtx && Module._saudio_context === state.audioCtx)) {
          try { Module._saudio_context.close(); } catch (e1) {}
          Module._saudio_context = null;
        }
        console.log("[sound_bus] one-shot: detached legacy Sokol saudio (rebuild App.wasm to skip)");
      }
    } catch (eDet) {}

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
      /* Start instruments even before AudioContext unlock — worker advances
       * voice clocks silently; unlock fade-in avoids a hard onset. */
      if (state.worker || (state.inlineSynth && state.worklet) || state._scriptPlay)
        return sendPlayReady(desc || {});
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
          sampleRate: state.sampleRate || state.synthRate || 44100,
          synthRate: state.synthRate,
          toneHz: state.toneHz
        },
        [port]
      );
    }

    function startScriptProcessorFallback(ctx) {
      /* HTTP Android often has no AudioWorklet. Keep the SAME desktop sound path:
       * worker synth @44.1k → resample → PCM FIFO → this ScriptProcessor sink.
       * (Callback still runs on the render thread — prefer HTTPS for Worklet.) */
      console.warn(
        "[sound_bus] ScriptProcessor PCM sink (config " +
          state.synthRate +
          " Hz → device). HTTPS → AudioWorklet recommended so FPS cannot starve audio."
      );

      if (!state.worker) {
        state.error = "script-pcm-needs-worker";
        throw new Error(state.error);
      }

      var blocks = [];
      var queuedFrames = 0;
      var current = null;
      var offset = 0;
      var underruns = 0;
      var primed = false;
      var needSent = false;
      var lastOutL = 0;
      var lastOutR = 0;
      var gapFrames = 0;
      var fadeFrames = 192;
      var xfadeLeft = 0;
      var xfadeFromL = 0;
      var xfadeFromR = 0;
      var unlockGain = 0;
      var unlockActive = state.unlockFadeSec > 0;
      var unlockStep =
        state.unlockFadeSec > 0
          ? 1.0 / (state.unlockFadeSec * (ctx.sampleRate || 48000))
          : 0;
      var channel = new MessageChannel();
      var audioPort = channel.port2;

      audioPort.onmessage = function (ev) {
        var a = ev.data || {};
        if (a.type === "pcm" && a.samples) {
          var samples =
            a.samples instanceof Float32Array
              ? a.samples
              : new Float32Array(a.samples);
          var frames = a.frames | 0;
          if (frames > 0) {
            blocks.push({ samples: samples, frames: frames });
            queuedFrames += frames;
            needSent = false;
            primed = true;
          }
        } else if (a.type === "flush") {
          blocks.length = 0;
          current = null;
          offset = 0;
          queuedFrames = 0;
          needSent = false;
          if (Math.max(Math.abs(lastOutL), Math.abs(lastOutR)) > 1e-4) {
            xfadeLeft = fadeFrames;
            xfadeFromL = lastOutL;
            xfadeFromR = lastOutR;
          }
        }
      };
      audioPort.start && audioPort.start();

      function requestFill(force) {
        if (queuedFrames >= state.needFrames) {
          needSent = false;
          return;
        }
        if (!force && needSent) return;
        needSent = true;
        audioPort.postMessage({
          type: "need",
          queuedFrames: queuedFrames | 0,
          needFrames: state.needFrames | 0,
          targetFrames: state.targetFrames | 0
        });
      }

      attachWorkerAudioPort(channel.port1);

      var bufSize = state.mobile ? 2048 : 2048;
      if (!ctx.createScriptProcessor) throw new Error("no-script-processor");
      var sp = ctx.createScriptProcessor(bufSize, 0, 2);
      sp.onaudioprocess = function (e) {
        var left = e.outputBuffer.getChannelData(0);
        var right = e.outputBuffer.getChannelData(1);
        var n = left.length;
        var i, si, rawL, rawR, fade, phase;
        /* Ask early in the callback so the worker can fill during this quantum. */
        requestFill(queuedFrames < state.needFrames);
        for (i = 0; i < n; i++) {
          if (!current || offset >= current.frames) {
            current = blocks.length ? blocks.shift() : null;
            offset = 0;
          }
          if (!current) {
            if (primed) {
              if (gapFrames === 0) underruns++;
              gapFrames++;
              fade = 1.0 - gapFrames / fadeFrames;
              if (fade < 0) fade = 0;
              left[i] = lastOutL * fade;
              right[i] = lastOutR * fade;
              lastOutL = left[i];
              lastOutR = right[i];
            } else {
              left[i] = 0;
              right[i] = 0;
              lastOutL = 0;
              lastOutR = 0;
            }
            continue;
          }
          si = offset * 2;
          rawL = current.samples[si];
          rawR = current.samples[si + 1];
          if (gapFrames > 0) {
            xfadeLeft = fadeFrames;
            xfadeFromL = lastOutL;
            xfadeFromR = lastOutR;
            gapFrames = 0;
          }
          if (xfadeLeft > 0) {
            phase = 1.0 - xfadeLeft / fadeFrames;
            left[i] = xfadeFromL * (1.0 - phase) + rawL * phase;
            right[i] = xfadeFromR * (1.0 - phase) + rawR * phase;
            xfadeLeft--;
          } else {
            left[i] = rawL > 1 ? 1 : rawL < -1 ? -1 : rawL;
            right[i] = rawR > 1 ? 1 : rawR < -1 ? -1 : rawR;
          }
          lastOutL = left[i];
          lastOutR = right[i];
          offset++;
          queuedFrames--;
          if (queuedFrames < 0) queuedFrames = 0;
          if (unlockActive) {
            unlockGain += unlockStep;
            if (unlockGain >= 1) {
              unlockGain = 1;
              unlockActive = false;
            } else {
              left[i] *= unlockGain;
              right[i] *= unlockGain;
              lastOutL = left[i];
              lastOutR = right[i];
            }
          }
        }
        state.stats.underruns = underruns;
        state.stats.queuedFrames = queuedFrames | 0;
        requestFill(true);
      };
      sp.connect(ctx.destination);
      state.scriptNode = sp;
      state.audioPath = "script-pcm";
      markAudioReadyIfRunning();
      requestFill(true);
      /* Plays stay on the worker (same as worklet-pcm / desktop). */
    }

    async function startWorkletPath(ctx) {
      var modStatus = await Promise.race([
        ensureWorkletModule(ctx).then(function () {
          return "ok";
        }),
        new Promise(function (resolve) {
          setTimeout(function () {
            resolve("timeout");
          }, 1500);
        })
      ]);
      if (modStatus !== "ok") {
        state._workletModulePromise = null;
        throw new Error("worklet-addModule-timeout");
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
          legacyTimeScale: state.legacyTimeScale,
          unlockFadeSec: state.unlockFadeSec
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
        markAudioReadyIfRunning();
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
      markAudioReadyIfRunning();
    }

    state.startAudio = function () {
      var resumePromise;
      var ctx;
      if (!audioSupported()) {
        state.error = "audio-unsupported";
        state.audioStage = "error";
        return Promise.reject(new Error(state.error));
      }
      if (!state._unlockStarted) state._unlockStarted = true;
      state._unlockAttempts++;

      /* Must stay synchronous in the gesture turn. */
      primeHtmlMedia();

      /* Stuck suspended context: destroy and recreate inside THIS gesture.
       * Retap used to no-op because audioReady was true while still suspended. */
      if (state.audioCtx && state.audioCtx.state !== "running") {
        console.warn(
          "[sound_bus] recreating AudioContext (was " + state.audioCtx.state + ")"
        );
        nukeAudioGraph();
      }

      ctx = ensureAudioContext();
      primeAudioGesture(ctx);
      state.sampleRate = ctx.sampleRate | 0;
      refreshConvertPath();
      console.log(
        "[sound_bus] AudioContext device=" +
          state.sampleRate +
          " Hz | config=" +
          state.synthRate +
          " Hz | " +
          state.convertPath +
          " | attempt=" +
          state._unlockAttempts
      );
      state.audioStage = "resume";
      try {
        resumePromise = ctx.state !== "running" ? ctx.resume() : Promise.resolve();
      } catch (resumeErr) {
        state.error =
          "resume:" + String(resumeErr && resumeErr.message ? resumeErr.message : resumeErr);
        state.audioStage = "error";
        state.audioReady = false;
        return Promise.reject(resumeErr);
      }

      /* Prefer ScriptProcessor on first unlock — sync, no addModule. Upgrade later. */
      if (!state.worklet && !state.scriptNode) {
        try {
          if (state._workletModuleReady && workletSupported(ctx)) {
            state.audioStage = "worklet";
            attachWorkletNodeSync(ctx);
          } else {
            state.audioStage = "fallback";
            startScriptProcessorFallback(ctx);
            if (workletSupported(ctx)) {
              ensureWorkletModule(ctx)
                .then(function () {
                  if (state.worklet || !state.scriptNode) return;
                  if (!state.audioCtx || state.audioCtx.state !== "running") return;
                  try {
                    try {
                      state.scriptNode.disconnect();
                    } catch (eDisc) {}
                    state.scriptNode = null;
                    attachWorkletNodeSync(state.audioCtx);
                    console.log("[sound_bus] upgraded ScriptProcessor → Worklet");
                  } catch (eUp) {
                    console.warn("[sound_bus] worklet upgrade failed", eUp);
                  }
                })
                .catch(function () {});
            }
          }
          markAudioReadyIfRunning();
          if (state.audioReady && typeof opts.onAudioReady === "function")
            opts.onAudioReady(state);
        } catch (eSink) {
          console.warn("[sound_bus] sync sink attach failed", eSink);
          state.audioStage = "error";
          state.error = String(eSink && eSink.message ? eSink.message : eSink);
          state.audioReady = false;
        }
      } else {
        markAudioReadyIfRunning();
      }

      flushPendingPlays();

      return Promise.resolve(resumePromise).then(
        function () {
          primeAudioGesture(ctx);
          markAudioReadyIfRunning();
          if (state.audioReady) flushPendingPlays();
          else
            console.warn(
              "[sound_bus] ctx still " +
                (ctx && ctx.state) +
                " after resume — next tap will recreate"
            );
          return state;
        },
        function (err) {
          state.audioStage = "resume-denied";
          state.audioReady = false;
          state.error = "resume:" + String(err && err.message ? err.message : err);
          throw err;
        }
      );
    };

    state.primeGesture = function () {
      primeHtmlMedia();
      if (state.audioCtx) primeAudioGesture(state.audioCtx);
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
