/* Proto 1+2+3 — GPU worker proof + PCM → AudioWorklet/ScriptProcessor.
 * Proto3: SoundWorkerSsound (tweet.sound port) via importScripts.
 */
(function () {
  "use strict";

  try {
    importScripts("sound_worker_ssound.js?v=desk16");
  } catch (e1) {
    try {
      importScripts("./sound_worker_ssound.js?v=desk16");
    } catch (e2) {
      /* Host may inject SoundWorkerSsound before worker runs. */
    }
  }
  var gl = null;
  var canvas = null;
  var program = null;
  var uFrame = null;
  var pixels = null;
  var width = 1024;
  var height = 1;
  var running = false;
  var frame = 0;
  var artificialStallMs = 0;
  var stallMode = "async"; /* "async" | "busy" */
  var tickDelayMs = 16; /* ~1 block cadence; was 2 and hammered mobile */
  var tickTimer = 0;
  var audioPort = null;
  var blockFrames = 1024;
  var targetFrames = 4096;
  var needFrames = 2048;
  var sampleRate = 44100;
  var toneHz = 440;
  var toneGain = 0.12;
  var phase = 0;
  var queuedEstimate = 0;
  var pcmBlocksSent = 0;
  var filling = false;
  var preferCpu = false;
  var synthBlocks = 0;
  var synthLastMs = 0;
  var synthSumMs = 0;
  var synthMaxMs = 0;
  var fillLastMs = 0;
  var fillMaxMs = 0;
  var synthReady = false;
  var pendingPlays = [];
  var stats = {
    n: 0,
    last_ms: 0,
    avg_ms: 0,
    max_ms: 0,
    sum_ms: 0,
    sample0: 0
  };

  function fail(reason, detail) {
    postMessage({
      type: "error",
      reason: reason || "unknown",
      detail: detail ? String(detail) : ""
    });
  }

  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(log || "shader compile failed");
    }
    return sh;
  }

  function initGL(offscreen) {
    canvas = offscreen;
    canvas.width = width;
    canvas.height = height;
    gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power"
    });
    if (!gl) {
      fail("worker-webgl2-unavailable");
      return false;
    }

    var vs = compile(
      gl.VERTEX_SHADER,
      "#version 300 es\n" +
        "const vec2 P[3]=vec2[3](vec2(-1.,-1.),vec2(3.,-1.),vec2(-1.,3.));\n" +
        "void main(){gl_Position=vec4(P[gl_VertexID],0.,1.);}\n"
    );
    var fs = compile(
      gl.FRAGMENT_SHADER,
      "#version 300 es\n" +
        "precision highp float;\n" +
        "uniform float u_frame;\n" +
        "out vec4 o;\n" +
        "void main(){\n" +
        "  float x=floor(gl_FragCoord.x);\n" +
        "  float v=fract((x+u_frame)*0.001953125);\n" +
        "  o=vec4(v, fract(u_frame*0.01), 0.25, 1.0);\n" +
        "}\n"
    );
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      fail("worker-shader-link", gl.getProgramInfoLog(program));
      return false;
    }
    uFrame = gl.getUniformLocation(program, "u_frame");
    pixels = new Uint8Array(width * height * 4);
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
    return true;
  }

  function busyWait(ms) {
    if (!(ms > 0)) return;
    var until = performance.now() + ms;
    while (performance.now() < until) {}
  }

  function nextDelayMs() {
    var base = tickDelayMs > 0 ? tickDelayMs : 16;
    if (stallMode === "async" && artificialStallMs > 0)
      return Math.max(base, artificialStallMs | 0);
    return base;
  }

  function record(dt) {
    stats.n += 1;
    stats.last_ms = dt;
    stats.sum_ms += dt;
    stats.avg_ms = stats.sum_ms / stats.n;
    if (dt > stats.max_ms) stats.max_ms = dt;
    stats.sample0 = pixels ? pixels[0] : 0;
  }

  function emitStats(force) {
    if (!force && (pcmBlocksSent & 15) !== 0) return;
    postMessage({
      type: "stats",
      n: stats.n,
      last_ms: stats.last_ms,
      avg_ms: stats.avg_ms,
      max_ms: stats.max_ms,
      width: width,
      height: height,
      frame: frame,
      stall_ms: artificialStallMs,
      stall_mode: stallMode,
      sample0: stats.sample0,
      pcm_blocks: pcmBlocksSent,
      queued_est: queuedEstimate,
      synth_rate:
        typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.getSynthesisRate
          ? SoundWorkerSsound.getSynthesisRate() : 44100,
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
        ? SoundWorkerSsound.getBackend() : "js",
      peak: typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.lastPeak
        ? SoundWorkerSsound.lastPeak() : 0
    });
  }

  /* GPU work only — timing excludes async delay. Busy mode spins here. */
  function gpuTick() {
    if (!gl) return 0;
    var t0 = performance.now();
    gl.uniform1f(uFrame, frame);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    if (stallMode === "busy") busyWait(artificialStallMs);
    var dt = performance.now() - t0;
    frame += 1;
    record(dt);
    return dt;
  }

  function makeToneBlock(frames) {
    if (typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.generateBlock) {
      return SoundWorkerSsound.generateBlock(frames, sampleRate);
    }
    var buf = new Float32Array(frames * 2);
    var step = (2 * Math.PI * toneHz) / sampleRate;
    var i, s;
    for (i = 0; i < frames; i++) {
      s = Math.sin(phase) * toneGain;
      phase += step;
      if (phase > 1e9) phase = phase % (2 * Math.PI);
      buf[i * 2] = s;
      buf[i * 2 + 1] = s;
    }
    return buf;
  }

  function sendPcmBlock() {
    if (!audioPort) return false;
    /* Do not touch the proto timing GL while Sokol owns another OffscreenCanvas —
     * switching WebGL contexts mid-tick aborts the worker on play/generate. */
    var be =
      typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.getBackend
        ? SoundWorkerSsound.getBackend()
        : "";
    if (be.indexOf("wasm-gpu") !== 0) gpuTick();
    var frames = blockFrames;
    var synthT0 = performance.now();
    var samples = makeToneBlock(frames);
    synthLastMs = performance.now() - synthT0;
    synthBlocks++;
    synthSumMs += synthLastMs;
    if (synthLastMs > synthMaxMs) synthMaxMs = synthLastMs;
    audioPort.postMessage(
      { type: "pcm", frames: frames, samples: samples.buffer },
      [samples.buffer]
    );
    queuedEstimate += frames;
    pcmBlocksSent += 1;
    emitStats(false);
    return true;
  }

  /* Push N blocks now even if prebuffer is full (needed so play isn't stuck behind silence). */
  function forcePushBlocks(n) {
    var i;
    if (!audioPort || !running) return;
    n = n > 0 ? n | 0 : 2;
    for (i = 0; i < n; i++) sendPcmBlock();
  }

  /* Audio is realtime — fill the FIFO synchronously on every `need` (no timers). */
  function fillToTarget(target) {
    if (!audioPort || !running || !synthReady) return;
    var want = target > 0 ? target : targetFrames;
    var guard = 0;
    var fillT0 = performance.now();
    if (want < 8192) want = 8192;
    while (running && audioPort && queuedEstimate < want && guard < 32) {
      sendPcmBlock();
      guard++;
    }
    fillLastMs = performance.now() - fillT0;
    if (fillLastMs > fillMaxMs) fillMaxMs = fillLastMs;
  }

  function onAudioMessage(ev) {
    var msg = ev.data || {};
    if (msg.type === "need") {
      queuedEstimate = msg.queuedFrames | 0;
      if (msg.needFrames > 0) needFrames = msg.needFrames | 0;
      if (msg.targetFrames > 0) targetFrames = msg.targetFrames | 0;
      if (targetFrames < 8192) targetFrames = 8192;
      if (needFrames < 4096) needFrames = 4096;
      fillToTarget(targetFrames);
    }
  }

  function attachAudioPort(port) {
    audioPort = port;
    audioPort.onmessage = onAudioMessage;
    audioPort.start && audioPort.start();
    queuedEstimate = 0;
    if (synthReady) fillToTarget(targetFrames);
    postMessage({ type: "audio-attached", blockFrames: blockFrames, targetFrames: targetFrames });
  }

  function playSound(msg) {
    /* Only queued silence may be discarded safely. Flushing every play
     * skipped the already-buffered tail of live birds and transformed
     * overlapping bounce notes. */
    var hadAudio =
      SoundWorkerSsound.liveVoices() > 0 ||
      (SoundWorkerSsound.lastPeak && SoundWorkerSsound.lastPeak() > 1e-4);
    if (!hadAudio && SoundWorkerSsound.resetOutput)
      SoundWorkerSsound.resetOutput();
    var id = SoundWorkerSsound.play(msg);
    postMessage({ type: "played", id: id, voices: SoundWorkerSsound.liveVoices() });
    if (audioPort && !hadAudio) {
      queuedEstimate = 0;
      audioPort.postMessage({ type: "flush" });
      forcePushBlocks(4);
    } else {
      fillToTarget(targetFrames);
    }
  }

  function clearTick() {
    if (tickTimer) {
      clearTimeout(tickTimer);
      tickTimer = 0;
    }
  }

  /* Proto1-only pump when no audio port yet */
  function tickNoAudio() {
    if (!running) return;
    if (audioPort) return;
    gpuTick();
    emitStats(false);
    clearTick();
    tickTimer = setTimeout(tickNoAudio, nextDelayMs());
  }

  onmessage = function (ev) {
    var msg = ev.data || {};
    var type = msg.type;
    try {
      if (type === "init") {
        width = msg.width > 0 ? msg.width | 0 : 1024;
        height = msg.height > 0 ? msg.height | 0 : 1;
        artificialStallMs = msg.stall_ms > 0 ? +msg.stall_ms : 0;
        stallMode = msg.stall_mode === "busy" ? "busy" : "async";
        tickDelayMs = msg.tick_ms > 0 ? msg.tick_ms | 0 : 16;
        blockFrames = msg.blockFrames > 0 ? msg.blockFrames | 0 : 1024;
        targetFrames = msg.targetFrames > 0 ? msg.targetFrames | 0 : 4096;
        needFrames = msg.needFrames > 0 ? msg.needFrames | 0 : 2048;
        sampleRate = msg.sampleRate > 0 ? +msg.sampleRate : 44100;
        toneHz = msg.toneHz > 0 ? +msg.toneHz : 440;
        preferCpu = msg.preferCpu !== false; /* default CPU — avoids GPU contention with scene */
        synthReady = false;
        pendingPlays.length = 0;
        if (targetFrames < 8192) targetFrames = 8192;
        if (needFrames < 4096) needFrames = 4096;
        if (!preferCpu) {
          if (!msg.canvas) {
            fail("missing-canvas");
            return;
          }
          if (!initGL(msg.canvas)) return;
        }
        running = true;
        if (msg.audioPort) attachAudioPort(msg.audioPort);
        function postReady(backend) {
          var err =
            typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.getLoadError
              ? SoundWorkerSsound.getLoadError()
              : "";
          synthReady = true;
          postMessage({
            type: "ready",
            width: width,
            height: height,
            renderer: gl ? (gl.getParameter(gl.RENDERER) || "") : "cpu-worker",
            vendor: gl ? (gl.getParameter(gl.VENDOR) || "") : "",
            audio: !!audioPort,
            stall_mode: stallMode,
            ssound: typeof SoundWorkerSsound !== "undefined" ? 1 : 0,
            wasm: backend && backend.indexOf("wasm") === 0 ? 1 : 0,
            gpu: backend && backend.indexOf("wasm-gpu") === 0 ? 1 : 0,
            backend: backend || "js",
            load_error: err || ""
          });
          if (pendingPlays.length) {
            var q = pendingPlays.splice(0, pendingPlays.length);
            for (var qi = 0; qi < q.length; qi++) playSound(q[qi]);
          } else if (audioPort) {
            fillToTarget(targetFrames);
          }
          if (!audioPort) tickNoAudio();
        }
        if (typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.load) {
          SoundWorkerSsound.load({ preferCpu: preferCpu })
            .then(postReady)
            .catch(function () { postReady("js"); });
        } else {
          postReady("js");
        }
        return;
      }
      if (type === "set-audio-port") {
        if (msg.blockFrames > 0) blockFrames = msg.blockFrames | 0;
        if (msg.targetFrames > 0) targetFrames = msg.targetFrames | 0;
        if (msg.needFrames > 0) needFrames = msg.needFrames | 0;
        if (msg.sampleRate > 0) {
          sampleRate = +msg.sampleRate;
          if (typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.setSampleRate)
            SoundWorkerSsound.setSampleRate(sampleRate);
        }
        if (msg.toneHz > 0) toneHz = +msg.toneHz;
        if (!msg.port) {
          fail("missing-audio-port");
          return;
        }
        attachAudioPort(msg.port);
        return;
      }
      if (type === "play") {
        if (typeof SoundWorkerSsound === "undefined") {
          fail("ssound-missing");
          return;
        }
        try {
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
        if (typeof SoundWorkerSsound !== "undefined") {
          SoundWorkerSsound.stopAll();
          if (SoundWorkerSsound.resetOutput) SoundWorkerSsound.resetOutput();
        }
        if (audioPort) {
          queuedEstimate = 0;
          audioPort.postMessage({ type: "flush" });
          if (synthReady) forcePushBlocks(4);
        }
        postMessage({ type: "stopped_all" });
        return;
      }
      if (type === "set_master") {
        if (typeof SoundWorkerSsound !== "undefined")
          SoundWorkerSsound.setMaster(msg.volume);
        return;
      }
      if (type === "set_stall") {
        artificialStallMs = msg.ms > 0 ? +msg.ms : 0;
        if (msg.mode === "busy" || msg.mode === "async") stallMode = msg.mode;
        return;
      }
      if (type === "set_tone") {
        if (msg.hz > 0) toneHz = +msg.hz;
        if (msg.gain >= 0) toneGain = +msg.gain;
        return;
      }
      if (type === "set_tick") {
        tickDelayMs = msg.ms > 0 ? msg.ms | 0 : 16;
        return;
      }
      if (type === "ping") {
        emitStats(true);
        return;
      }
      if (type === "stop") {
        running = false;
        audioPort = null;
        clearTick();
        postMessage({ type: "stopped", n: stats.n, pcm_blocks: pcmBlocksSent });
        return;
      }
    } catch (err) {
      fail("worker-exception", err && err.message ? err.message : err);
      running = false;
      clearTick();
    }
  };
})();
