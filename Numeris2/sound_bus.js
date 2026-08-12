/* Proto bus - worker PCM @44.1k â†’ resample â†’ AudioWorklet (desktop + Android).
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
  /* Embedded AudioWorklet processor (andr36) — no separate spin_audio_processor.js fetch. */
  var SPIN_AUDIO_PROCESSOR_SRC = "/* AudioWorklet: realtime tweet/tone synth (priority path).\n *\n * Envelope matches ssound/sbase.ginc (sustain + exp(-envelop*(t-duration))).\n * legacyTimeScale remains configurable for A/B tests; production uses 1.0 so\n * one device frame advances exactly one sample of tweet.sound time.\n */\nclass SpinAudioProcessor extends AudioWorkletProcessor {\n  constructor(options) {\n    super();\n    var opts = (options && options.processorOptions) || {};\n    this.mode = opts.mode === \"pcm\" ? \"pcm\" : \"inline\";\n    this.lightSynth = !!opts.lightSynth;\n    this.legacyTimeScale =\n      opts.legacyTimeScale > 0 ? +opts.legacyTimeScale : 1.0;\n    /* SOUND_UNLOCK_FADEIN_SEC \u2014 soft onset when device first becomes audible. */\n    this.unlockFadeSec =\n      opts.unlockFadeSec > 0 ? +opts.unlockFadeSec : 0.12;\n    this.unlockGain = 0;\n    this.unlockActive = this.unlockFadeSec > 0;\n    this.blocks = [];\n    this.queuedFrames = 0;\n    this.current = null;\n    this.offset = 0;\n    this.underruns = 0; /* gap events, not individual samples */\n    this.underrunFrames = 0;\n    this.maxGapFrames = 0;\n    this.gapFrames = 0;\n    this.gapStartL = 0;\n    this.gapStartR = 0;\n    this.lastOutL = 0;\n    this.lastOutR = 0;\n    this.crossfadeFrames = 768;\n    this.holdFrames = 256;\n    this.crossfadeLeft = 0;\n    this.crossfadeFromL = 0;\n    this.crossfadeFromR = 0;\n    this.recoveryLeft = 0;\n    this.recoveryFromL = 0;\n    this.recoveryFromR = 0;\n    this.minQueuedFrames = 0x7fffffff;\n    this.fillWaitLastFrames = 0;\n    this.fillWaitMaxFrames = 0;\n    this.renderFrames = 0;\n    this.needSentAtFrame = 0;\n    this.bufferBoostFrames = 0;\n    this.needThreshold = 4096;\n    this.targetFrames = 8192;\n    this.sourcePort = null;\n    this._tick = 0;\n    this._needSent = false;\n    this.primed = false;\n    this.master = 1.0;\n    this.voices = [];\n    this.nextId = 1;\n    this.frame = 0;\n    this.maxVoices = opts.maxVoices > 0 ? opts.maxVoices | 0 : 24;\n    if (this.maxVoices < 4) this.maxVoices = 4;\n    if (this.maxVoices > 48) this.maxVoices = 48;\n\n    this.port.onmessage = (event) => {\n      var msg = event.data || {};\n      if (msg.type === \"set-mode\") {\n        this.mode = msg.mode === \"pcm\" ? \"pcm\" : \"inline\";\n        return;\n      }\n      if (msg.type === \"play\") {\n        this.playVoice(msg);\n        return;\n      }\n      if (msg.type === \"stop_all\") {\n        this.voices.length = 0;\n        return;\n      }\n      if (msg.type === \"set_master\") {\n        this.master = msg.volume >= 0 ? +msg.volume : 1;\n        return;\n      }\n      if (msg.type === \"set-source-port\") {\n        this.sourcePort = msg.port;\n        this.needThreshold = msg.needFrames > 0 ? msg.needFrames | 0 : 2048;\n        this.targetFrames = msg.targetFrames > 0 ? msg.targetFrames | 0 : 4096;\n        this.sourcePort.onmessage = (audioEvent) => {\n          var a = audioEvent.data || {};\n          if (a.type === \"pcm\" && a.samples) {\n            var samples =\n              a.samples instanceof Float32Array\n                ? a.samples\n                : new Float32Array(a.samples);\n            var frames = a.frames | 0;\n            if (frames > 0) {\n              this.blocks.push({ samples: samples, frames: frames });\n              this.queuedFrames += frames;\n              if (this._needSent) {\n                this.fillWaitLastFrames =\n                  this.renderFrames - this.needSentAtFrame;\n                if (this.fillWaitLastFrames > this.fillWaitMaxFrames)\n                  this.fillWaitMaxFrames = this.fillWaitLastFrames;\n              }\n              this._needSent = false;\n              /* First PCM block \u2192 audible immediately (unlock fade covers onset).\n               * Waiting for a deep needThreshold caused multi-second silence on\n               * Android ScriptProcessor when the main thread was busy. */\n              this.primed = true;\n            }\n          } else if (a.type === \"flush\") {\n            /* Drop stale pre-buffered silence so a newly played bird starts at\n             * the next render quantum instead of behind ~170 ms of FIFO. */\n            this.blocks.length = 0;\n            this.current = null;\n            this.offset = 0;\n            this.queuedFrames = 0;\n            this._needSent = false;\n            this.bufferBoostFrames = 0;\n            /* An idle queue ends at zero, so the exact tweet attack can pass\n             * unchanged. Keep the de-zipper only for a real discontinuity. */\n            this.crossfadeLeft =\n              Math.max(Math.abs(this.lastOutL), Math.abs(this.lastOutR)) > 1e-4\n                ? this.crossfadeFrames\n                : 0;\n            this.crossfadeFromL = this.lastOutL;\n            this.crossfadeFromR = this.lastOutR;\n          }\n        };\n        this.sourcePort.start();\n        if (this.mode === \"pcm\") this.requestFill(true);\n        return;\n      }\n      if (msg.type === \"set-thresholds\") {\n        if (msg.needFrames > 0) this.needThreshold = msg.needFrames | 0;\n        if (msg.targetFrames > 0) this.targetFrames = msg.targetFrames | 0;\n        return;\n      }\n      if (msg.type === \"reset-latency\") {\n        this.blocks.length = 0;\n        this.current = null;\n        this.offset = 0;\n        this.queuedFrames = 0;\n        this._needSent = false;\n        this.bufferBoostFrames = 0;\n        this.gapFrames = 0;\n        this.crossfadeLeft = 0;\n        this.unlockGain = 0;\n        this.unlockActive = this.unlockFadeSec > 0;\n        this.primed = false;\n        if (this.mode === \"pcm\") this.requestFill(true);\n        return;\n      }\n    };\n  }\n\n  envelopDecaySeconds(envelop) {\n    if (!(envelop > 1e-6)) return 0.5;\n    var d = Math.log(0.001) / -envelop;\n    if (!isFinite(d) || d < 0) return 0.5;\n    if (d > 4) return 4;\n    return d;\n  }\n\n  playVoice(desc) {\n    if (this.voices.length >= this.maxVoices) this.voices.shift();\n    var fadein = desc.fadein >= 0 ? +desc.fadein : 0.0000006;\n    if (fadein < 0) fadein = 0;\n    var envelop = desc.envelop >= 0 ? +desc.envelop : 8.0;\n    var duration = desc.duration > 0 ? +desc.duration : 0.08;\n    var decay = this.envelopDecaySeconds(envelop);\n    this.voices.push({\n      id: this.nextId++,\n      start: this.frame + (desc.startOffsetFrames | 0),\n      duration: duration,\n      totalLife: duration + decay,\n      volume: desc.volume >= 0 ? +desc.volume : 0.6,\n      fadein: fadein,\n      envelop: envelop,\n      freqX: desc.freqX != null ? +desc.freqX : 2.0,\n      freqY: desc.freqY != null ? +desc.freqY : 4.0,\n      freqZ: desc.freqZ != null ? +desc.freqZ : 0.0,\n      type: desc.soundType === \"tone\" ? \"tone\" : \"tweet\",\n      phase: 0\n    });\n    this.primed = true;\n  }\n\n  hash1(p) {\n    var p2x = (p * 5.3983) % 1;\n    if (p2x < 0) p2x += 1;\n    var p2y = (p * 5.4427) % 1;\n    if (p2y < 0) p2y += 1;\n    var d = p2y * (p2x + 21.5351) + p2x * (p2y + 14.3137);\n    p2x += d;\n    p2y += d;\n    var r = (p2x * p2y * 95.4337) % 1;\n    return r < 0 ? r + 1 : r;\n  }\n  noise(n) {\n    var f = n - Math.floor(n);\n    n = Math.floor(n);\n    f = f * f * (3.0 - 2.0 * f);\n    return this.hash1(n) * (1 - f) + this.hash1(n + 1) * f - 0.5;\n  }\n  noiseSlope(n, loc) {\n    var f = n - Math.floor(n);\n    n = Math.floor(n);\n    if (loc <= 0) f = f >= 1 ? 1 : 0;\n    else {\n      f = f / loc;\n      if (f < 0) f = 0;\n      if (f > 1) f = 1;\n      f = f * f * (3 - 2 * f);\n    }\n    return this.hash1(n) * (1 - f) + this.hash1(n + 1) * f;\n  }\n  smoothstep(edge0, edge1, x) {\n    var t = (x - edge0) / (edge1 - edge0);\n    if (t < 0) t = 0;\n    if (t > 1) t = 1;\n    return t * t * (3 - 2 * t);\n  }\n  tweetVolume(t) {\n    var n1 = this.noiseSlope(t * 11.0, 0.3);\n    var n2 = this.smoothstep(0.0, 1.0, Math.abs(Math.sin(t * 14.0)));\n    var n3 = this.smoothstep(0.4, 0.9, this.noiseSlope(t * 0.5 + 4.0, 0.3));\n    var n = n1 * n2 * 0.2 * n3;\n    n = n * n;\n    if (n < 0) n = 0;\n    if (n > 1) n = 1;\n    return n;\n  }\n  /* Full Shadertoy FM - desktop. Aliases hard above ~Nyquist/4. */\n  tweetHeavy(t) {\n    t = t - 1.5;\n    var f =\n      Math.sin(6.2831 * 2.0 * t) * this.noise(t * 8.1 - 100.0) * 100.0 + 5000.0;\n    f += Math.cos(50.0 * 6.2831 * t);\n    return Math.sin(6.2831 * f * t);\n  }\n  sampleTweetHeavy(t, freqX, freqY) {\n    var volume = this.tweetVolume((t + freqY - 0.5) * 0.6) * 20.0;\n    /* Match tweet.sound exactly; final device mixing performs the clamp. */\n    return this.tweetHeavy((t + freqX) * 0.4) * volume;\n  }\n  /* Mobile: phase-accum chirp in bird range (1.8\u20134.5 kHz), same gate feel. */\n  sampleTweetLight(t, freqX, freqY, voice, dt) {\n    var gate = this.tweetVolume((t + freqY * 0.08) * 0.6);\n    if (gate < 1e-4) {\n      voice.phase = 0;\n      return 0;\n    }\n    /* Phrase offset without jumping into chaotic FM region. */\n    var phrase = (freqX * 0.015) % 0.4;\n    var tt = t + phrase;\n    var sweep =\n      1900 +\n      2200 * (0.5 + 0.5 * Math.sin(tt * 16.0 + freqX * 0.25)) +\n      350 * Math.sin(tt * 37.0);\n    if (sweep > 4500) sweep = 4500;\n    if (sweep < 1200) sweep = 1200;\n    voice.phase += sweep * dt;\n    if (voice.phase > 1e6) voice.phase -= 1e6;\n    var sig = Math.sin(6.28318530718 * voice.phase);\n    sig *= 0.6 + 0.4 * Math.sin(tt * 42.0);\n    return sig * gate * 0.55;\n  }\n  panSimple(pos) {\n    if (pos > 1.25) pos = 1.25;\n    if (pos < -1.25) pos = -1.25;\n    var e0 = 1 - pos,\n      e1 = 1 + pos;\n    var len = Math.sqrt(e0 * e0 + e1 * e1);\n    if (len < 1e-8) return [0.707, 0.707];\n    return [e0 / len, e1 / len];\n  }\n  envelope(t, v) {\n    if (t < 0 || t > v.totalLife) return 0;\n    var e = t < v.duration ? 1.0 : Math.exp(-v.envelop * (t - v.duration));\n    if (v.fadein > 1e-12 && t < v.fadein) e *= t / v.fadein;\n    return e < 0 ? 0 : e > 1 ? 1 : e;\n  }\n\n  requestFill(force) {\n    var effectiveNeed;\n    if (this.mode !== \"pcm\" || !this.sourcePort) return;\n    effectiveNeed = this.needThreshold + (this.bufferBoostFrames >> 1);\n    if (this.queuedFrames >= effectiveNeed) {\n      this._needSent = false;\n      return;\n    }\n    if (!force && this._needSent) return;\n    this._needSent = true;\n    this.needSentAtFrame = this.renderFrames;\n    this.sourcePort.postMessage({\n      type: \"need\",\n      queuedFrames: this.queuedFrames | 0,\n      needFrames: effectiveNeed | 0,\n      targetFrames: (this.targetFrames + this.bufferBoostFrames) | 0\n    });\n  }\n\n  processInline(left, right, n) {\n    var sr = sampleRate;\n    var dt = 1.0 / sr;\n    var i, vi, v, t, env, sig, pan, g, absFrame, endFrame;\n    var still = [];\n    for (i = 0; i < n; i++) {\n      left[i] = 0;\n      right[i] = 0;\n    }\n    for (vi = 0; vi < this.voices.length; vi++) {\n      v = this.voices[vi];\n      endFrame = v.start + Math.ceil(v.totalLife * sr);\n      if (this.frame >= endFrame) continue;\n      still.push(v);\n      /* Legacy tweet.sound writes the same signal to both channels and ignores\n       * freq.z. Keep panning only for tone/mobile voices. */\n      pan = v.type === \"tweet\" && !this.lightSynth ? [1.0, 1.0] : this.panSimple(v.freqZ);\n      for (i = 0; i < n; i++) {\n        absFrame = this.frame + i;\n        if (absFrame < v.start) continue;\n        t = (absFrame - v.start) * dt;\n        if (v.type === \"tweet\") t *= this.legacyTimeScale;\n        env = this.envelope(t, v);\n        if (env <= 1e-5) continue;\n        if (v.type === \"tone\")\n          sig = Math.sin(6.28318530718 * (v.freqX > 20 ? v.freqX : 440) * t) * 0.15;\n        else if (this.lightSynth)\n          sig = this.sampleTweetLight(t, v.freqX, v.freqY, v, dt);\n        else sig = this.sampleTweetHeavy(t, v.freqX, v.freqY);\n        g = sig * v.volume * env * this.master;\n        left[i] += g * pan[0];\n        right[i] += g * pan[1];\n      }\n    }\n    this.voices = still;\n    for (i = 0; i < n; i++) {\n      if (left[i] > 1) left[i] = 1;\n      else if (left[i] < -1) left[i] = -1;\n      if (right[i] > 1) right[i] = 1;\n      else if (right[i] < -1) right[i] = -1;\n    }\n    this.frame += n;\n  }\n\n  processPcm(left, right, n) {\n    var i, si, rawL, rawR, phase, fade;\n    for (i = 0; i < n; i++) {\n      if (!this.current || this.offset >= this.current.frames) {\n        this.current = this.blocks.length ? this.blocks.shift() : null;\n        this.offset = 0;\n      }\n      if (!this.current) {\n        if (this.primed) {\n          if (this.gapFrames === 0) {\n            this.underruns++;\n            this.gapStartL = this.lastOutL;\n            this.gapStartR = this.lastOutR;\n            /* Grow look-ahead only after a real starvation event. */\n            /* Cap — muted warm-up must not inflate to 16k. */\n            this.bufferBoostFrames += 512;\n            if (this.bufferBoostFrames > 2048) this.bufferBoostFrames = 2048;\n          }\n          this.gapFrames++;\n          this.underrunFrames++;\n          if (this.gapFrames > this.maxGapFrames)\n            this.maxGapFrames = this.gapFrames;\n          /* Hold last sample briefly then slow fade \u2014 avoids clicky fade-to-0. */\n          if (this.gapFrames <= this.holdFrames) {\n            left[i] = this.gapStartL;\n            right[i] = this.gapStartR;\n          } else {\n            fade = 1.0 - (this.gapFrames - this.holdFrames) / this.crossfadeFrames;\n            if (fade < 0) fade = 0;\n            left[i] = this.gapStartL * fade;\n            right[i] = this.gapStartR * fade;\n            this.lastOutL = left[i];\n            this.lastOutR = right[i];\n          }\n        } else {\n          left[i] = 0.0;\n          right[i] = 0.0;\n          this.lastOutL = 0.0;\n          this.lastOutR = 0.0;\n        }\n        continue;\n      }\n      si = this.offset * 2;\n      rawL = this.current.samples[si];\n      rawR = this.current.samples[si + 1];\n      if (this.gapFrames > 0) {\n        if (this.crossfadeLeft <= 0) {\n          this.recoveryLeft = this.crossfadeFrames;\n          this.recoveryFromL = this.lastOutL;\n          this.recoveryFromR = this.lastOutR;\n        } else this.recoveryLeft = 0;\n        this.gapFrames = 0;\n      }\n      if (this.crossfadeLeft > 0) {\n        phase = 1.0 - this.crossfadeLeft / this.crossfadeFrames;\n        left[i] = this.crossfadeFromL * (1.0 - phase) + rawL * phase;\n        right[i] = this.crossfadeFromR * (1.0 - phase) + rawR * phase;\n        this.crossfadeLeft--;\n      } else if (this.recoveryLeft > 0) {\n        phase = 1.0 - this.recoveryLeft / this.crossfadeFrames;\n        left[i] = this.recoveryFromL * (1.0 - phase) + rawL * phase;\n        right[i] = this.recoveryFromR * (1.0 - phase) + rawR * phase;\n        this.recoveryLeft--;\n      } else {\n        left[i] = rawL;\n        right[i] = rawR;\n      }\n      this.lastOutL = left[i];\n      this.lastOutR = right[i];\n      this.offset++;\n      this.queuedFrames--;\n      if (this.queuedFrames < 0) this.queuedFrames = 0;\n      if (this.primed && this.queuedFrames < this.minQueuedFrames)\n        this.minQueuedFrames = this.queuedFrames;\n    }\n  }\n\n  process(inputs, outputs) {\n    var output = outputs[0];\n    var left = output[0];\n    var right = output[1] || output[0];\n    var n = left.length;\n\n    if (this.mode === \"inline\") this.processInline(left, right, n);\n    else this.processPcm(left, right, n);\n\n    if (this.unlockActive) {\n      var step = 1.0 / (this.unlockFadeSec * sampleRate);\n      var i, g;\n      for (i = 0; i < n; i++) {\n        this.unlockGain += step;\n        if (this.unlockGain >= 1) {\n          this.unlockGain = 1;\n          this.unlockActive = false;\n          break;\n        }\n        g = this.unlockGain;\n        left[i] *= g;\n        right[i] *= g;\n      }\n    }\n\n    this.renderFrames += n;\n    if (this.mode === \"pcm\") {\n      /* Re-ask every quantum while below target \u2014 a single sticky _needSent\n       * left the FIFO draining during slow worker fills. */\n      if (this.queuedFrames < this.targetFrames + (this.bufferBoostFrames >> 1))\n        this.requestFill(this.queuedFrames < this.needThreshold * 2);\n    }\n    this._tick++;\n    if ((this._tick & 15) === 0) {\n      this.port.postMessage({\n        type: \"stats\",\n        underruns: this.underruns,\n        underrunFrames: this.underrunFrames,\n        maxGapMs: (this.maxGapFrames * 1000) / sampleRate,\n        minQueuedFrames:\n          this.minQueuedFrames === 0x7fffffff ? this.queuedFrames : this.minQueuedFrames,\n        fillWaitMs: (this.fillWaitLastFrames * 1000) / sampleRate,\n        fillWaitMaxMs: (this.fillWaitMaxFrames * 1000) / sampleRate,\n        bufferBoostFrames: this.bufferBoostFrames,\n        queuedFrames:\n          this.mode === \"inline\" ? this.voices.length : this.queuedFrames | 0,\n        blocks: this.blocks.length | 0,\n        mode: this.mode,\n        voices: this.voices.length | 0\n      });\n    }\n    return true;\n  }\n}\n\nregisterProcessor(\"spin-audio-processor\", SpinAudioProcessor);\n";

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
    /* Optional override still allowed for A/B; default is embedded blob. */
    if (opts && opts.workletUrl) return opts.workletUrl;
    return null;
  }

  function workletBlobUrl() {
    var blob = new Blob([SPIN_AUDIO_PROCESSOR_SRC], { type: "application/javascript" });
    return URL.createObjectURL(blob);
  }

  function createBus(opts) {
    opts = opts || {};
    var mobile = isMobileUa();
    /* Desktop-correct path (conversation start): worker synth @44.1k â†’ Worklet PCM.
     * Old App.wasm may still pass inlineSynth:true â€” ignore it. Use forceInlineSynth
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
      /* Look-ahead FIFO. Mobile keeps a deeper cushion (GL/ScriptProcessor hitches).
       * Desktop stays short so SFX are not buried behind ~170–250 ms of silence. */
      targetFrames: opts.targetFrames > 0 ? opts.targetFrames | 0 : (mobile ? 4608 : 1536),
      needFrames: opts.needFrames > 0 ? opts.needFrames | 0 : (mobile ? 1536 : 768),
      /* Engine clock (SSOUND_SAMPLE_RATE). Device rate filled after AudioContext. */
      synthRate: opts.synthRate > 0 ? opts.synthRate | 0 : 44100,
      /* 0 until unlock â€” then AudioContext.sampleRate (may differ â†’ resample). */
      sampleRate: opts.sampleRate > 0 ? opts.sampleRate | 0 : 0,
      convertPath: "pending",
      legacyTimeScale: opts.legacyTimeScale > 0 ? +opts.legacyTimeScale : 1.0,
      /* SOUND_UNLOCK_FADEIN_SEC â€” ramp when device first becomes audible. */
      unlockFadeSec: opts.unlockFadeSec > 0 ? +opts.unlockFadeSec : 0.04,
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
      var url = locate("sound_worker.js", opts.workerUrl);
      if (url.indexOf("?") < 0) url += "?v=andr50";
      else url += "&v=andr50";
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

    /* Soften / drop PCM backlog that built while suspended.
     * "unlock"/"gesture": prefer fade+silence — a hard flush clicks on first tap.
     * "visibility": allow a full flush when the queue is deep. */
    function trimAudioLatency(reason, forceHard) {
      var why = reason || "trim";
      /* Soft only when explicitly requested. Unlock / background / resume must
       * hard-flush or Android worklet warm-up boost sticks as latency. */
      var soft = !forceHard && why === "visibility-soft";
      var now =
        typeof performance !== "undefined" && performance.now
          ? performance.now()
          : Date.now();
      if (state._lastTrimMs > 0 && now - state._lastTrimMs < 180) return;
      state._lastTrimMs = now;
      try {
        if (soft && typeof state._scriptSoftTrimLatency === "function")
          state._scriptSoftTrimLatency();
        else if (typeof state._scriptTrimLatency === "function")
          state._scriptTrimLatency();
      } catch (e0) {}
      try {
        if (state.worklet && state.worklet.port && !soft)
          state.worklet.port.postMessage({ type: "reset-latency" });
      } catch (eW) {}
      try {
        if (state.worker)
          state.worker.postMessage({
            type: "trim_latency",
            soft: soft ? 1 : 0
          });
      } catch (e2) {}
      try {
        var ctx = state.audioCtx;
        if (ctx) {
          var bl = ctx.baseLatency > 0 ? ctx.baseLatency : 0;
          var ol = ctx.outputLatency > 0 ? ctx.outputLatency : 0;
          console.log(
            "[sound_bus] trim latency (" +
              why +
              (soft ? ", soft" : ", hard") +
              ") path=" +
              (state.audioPath || "?") +
              " base=" +
              Math.round(bl * 1000) +
              "ms out=" +
              Math.round(ol * 1000) +
              "ms"
          );
        } else {
          console.log("[sound_bus] trim latency (" + why + ")");
        }
      } catch (e3) {}
    }
    state.trimAudioLatency = trimAudioLatency;
    state._lastTrimMs = 0;
    state._outputAllowed = 1;
    state._backgroundMuted = 0;
    state._backgroundPausing = 0;
    state._backgroundFadeTimer = 0;
    state._unlockFadePending = 0;

    /* Desktop can wait for timers. Phone lock/screen-off freezes JS almost
     * immediately — any setTimeout fade is cut mid-way → pop. Mobile uses a
     * short AudioContext ramp + busy-wait so the audio thread finishes first. */
    var BACKGROUND_FADE_SEC = state.mobile ? 0.055 : 0.10;
    var BLUR_FADE_SEC = state.mobile ? 0.04 : 0.06;
    var PHONE_LOCK_FADE_SEC = 0.055;
    /* Tab/browser kill: timers never run — short ramp + busy-wait only. */
    var TERMINAL_LEAVE_FADE_SEC = 0.04;

    function isTerminalLeaveReason(reason) {
      return (
        reason === "pagehide" ||
        reason === "shutdown" ||
        reason === "stop" ||
        reason === "beforeunload"
      );
    }

    function silenceScriptSink() {
      try {
        if (typeof state._scriptSilenceForTeardown === "function")
          state._scriptSilenceForTeardown();
      } catch (eSc) {}
      try {
        if (state.worklet && state.worklet.port)
          state.worklet.port.postMessage({ type: "reset-latency" });
      } catch (eWl) {}
    }

    function nowMs() {
      return typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    }

    function busyWaitMs(ms) {
      var end = nowMs() + (ms > 0 ? ms : 0);
      while (nowMs() < end) {}
    }

    function isPageAudible() {
      /* Visibility only — document.hasFocus() is false during the tiny
       * bootstrap window / some WebViews and was killing polyphony early. */
      if (typeof document === "undefined") return true;
      if (document.visibilityState === "hidden") return false;
      return true;
    }

    function cancelBackgroundPause() {
      if (state._backgroundFadeTimer) {
        clearTimeout(state._backgroundFadeTimer);
        state._backgroundFadeTimer = 0;
      }
      state._backgroundPausing = 0;
    }

    function muteOutputNow() {
      try {
        if (state.outputGain && state.audioCtx) {
          var g = state.outputGain.gain;
          var t = state.audioCtx.currentTime;
          g.cancelScheduledValues(t);
          g.setValueAtTime(0, t);
        } else if (state.outputGain) state.outputGain.gain.value = 0;
      } catch (eG) {}
      state._outputFadedIn = 0;
    }

    function finishBackgroundMute(reason) {
      state._backgroundFadeTimer = 0;
      state._backgroundPausing = 0;
      if (state._shutdownBegun || state._tearingDown) return;
      if (isPageAudible() && reason !== "interrupted") return;
      state._backgroundMuted = 1;
      stopWorkerPumpSoft();
      try {
        if (state._pendingPlays) state._pendingPlays.length = 0;
      } catch (eP) {}
      try {
        var ctxP = state.audioCtx;
        if (ctxP && ctxP.state === "running") ctxP.suspend();
      } catch (eSus) {}
      try {
        console.log("[sound_bus] paused for background (" + (reason || "?") + ")");
      } catch (eLog) {}
    }

    function pauseForBackground(reason) {
      if (state._backgroundMuted || state._backgroundPausing) return;
      if (state._shutdownBegun || state._tearingDown) return;
      cancelBackgroundPause();
      state._backgroundPausing = 1;
      state._outputAllowed = 0;
      state._unlockFadePending = 0;
      state._warmupReadyCount = 0;
      var fadeSec =
        state.mobile || reason === "interrupted" || reason === "freeze"
          ? PHONE_LOCK_FADE_SEC
          : BACKGROUND_FADE_SEC;
      /* Fade first — instant mute + FIFO flush clicks on tab/page change. */
      var dur = fadeOutputOut(reason || "background", fadeSec, null);
      var waitMs = ((dur > 0 ? dur : fadeSec) * 1000 + 20) | 0;
      /* Phone lock: timers die; busy-wait so the audio thread plays the ramp
       * before suspend. Short (~55–75 ms) — better than a pop. */
      if (state.mobile || reason === "interrupted" || reason === "freeze") {
        busyWaitMs(waitMs);
        muteOutputNow();
        finishBackgroundMute(reason || "background");
        return;
      }
      state._backgroundFadeTimer = setTimeout(function () {
        finishBackgroundMute(reason || "background");
      }, waitMs);
    }

    function fadeOutputIfAudible(reason, durSec) {
      var ctx = state.audioCtx;
      if (!ctx || ctx.state !== "running" || !state.outputGain) return 0;
      if (state._backgroundMuted || state._shutdownBegun || state._tearingDown) return 0;
      try {
        if (state.outputGain.gain.value < 0.001) return 0;
      } catch (eV) {}
      return fadeOutputOut(reason || "blur", durSec > 0 ? durSec : BLUR_FADE_SEC, null);
    }

    state.isOutputAudible = function () {
      var ctx = state.audioCtx;
      return !!(
        state.audioReady &&
        state._outputFadedIn &&
        state._outputAllowed &&
        !state._backgroundMuted &&
        !state._backgroundPausing &&
        ctx &&
        ctx.state === "running"
      );
    };

    function resumeWorkerPump() {
      try {
        if (state.worker) state.worker.postMessage({ type: "resume_soft" });
      } catch (eRp) {}
    }

    function resumeFromForeground(reason) {
      cancelBackgroundPause();
      var wasMuted = state._backgroundMuted;
      state._backgroundMuted = 0;
      state._backgroundPausing = 0;
      if (!isPageAudible()) return;
      /* Background pause only — not a terminal teardown. */
      if (state._shutdownBegun && !state._tearingDown) state._shutdownBegun = 0;
      if (state._tearingDown) {
        if (!state.audioCtx || !state.outputGain || (!state.worklet && !state.scriptNode)) {
          state.audioStage = "waiting-gesture";
          return;
        }
        state._tearingDown = 0;
        state._shutdownBegun = 0;
      }
      state._outputAllowed = 1;
      state._outputFadedIn = 0;
      state._warmupReadyCount = 0;
      state._unlockFadePending = 1;
      var ctx = state.audioCtx;
      if (!ctx) return;
      Promise.resolve()
        .then(function () {
          return ctx.state !== "running" ? ctx.resume() : null;
        })
        .then(function () {
          if (ctx.state !== "running") {
            console.warn(
              "[sound_bus] foreground: still " + ctx.state + " — nuke for next gesture"
            );
            nukeAudioGraph();
            state.audioStage = "waiting-gesture";
            return;
          }
          markAudioReadyIfRunning();
          resumeWorkerPump();
          if (wasMuted) trimAudioLatency(reason || "foreground", true);
        })
        .catch(function () {
          nukeAudioGraph();
          state.audioStage = "waiting-gesture";
        });
    }

    function syncPageAudible(trigger) {
      if (isPageAudible()) resumeFromForeground(trigger || "sync");
      else pauseForBackground(trigger || "sync");
    }

    state.isPageAudible = isPageAudible;

    function isBackgroundInactive() {
      if (!isPageAudible()) return true;
      if (state._backgroundMuted || state._backgroundPausing) return true;
      /* Blur / soft mute: audio is fading out — slow the fractal clock too. */
      if (state.audioReady && state._outputFadedIn && !state._outputAllowed) return true;
      return false;
    }

    state.isBackgroundInactive = isBackgroundInactive;

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
      try {
        if (state.outputGain) state.outputGain.disconnect();
      } catch (eOg) {}
      state.worklet = null;
      state.scriptNode = null;
      state.outputGain = null;
      state.audioPort = null;
      state.audioReady = false;
      state._workletModuleReady = false;
      state._workletModulePromise = null;
      state._gesturePrimed = false;
      state._outputFadedIn = 0;
      try {
        if (state.audioCtx && state.audioCtx.state !== "closed") state.audioCtx.close();
      } catch (e2) {}
      state.audioCtx = null;
      state.audioPath = "";
    }

    /* Master gain before destination — mute soft on reload/teardown and hold
     * silence until the PCM FIFO is primed (avoids first-tap underrun clicks). */
    function ensureOutputGain(ctx) {
      if (state.outputGain && state.outputGain.context === ctx) return state.outputGain;
      var g = ctx.createGain();
      g.gain.value = 0;
      g.connect(ctx.destination);
      state.outputGain = g;
      state._outputFadedIn = 0;
      state._warmupReadyCount = 0;
      return g;
    }

    function connectAudioOut(node, ctx) {
      if (!node || !ctx) return;
      try {
        node.disconnect();
      } catch (e0) {}
      node.connect(ensureOutputGain(ctx));
    }

    function fadeOutputIn(reason) {
      var ctx = state.audioCtx;
      var gNode = state.outputGain;
      var g, t, dur;
      if (!ctx || !gNode || state._outputFadedIn) return;
      if (ctx.state !== "running") return;
      state._outputFadedIn = 1;
      g = gNode.gain;
      t = ctx.currentTime;
      dur = Math.max(0.06, state.unlockFadeSec > 0 ? state.unlockFadeSec : 0.08);
      try {
        g.cancelScheduledValues(t);
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(1, t + dur);
      } catch (eFade) {
        try {
          g.value = 1;
        } catch (e2) {}
      }
      try {
        console.log("[sound_bus] output fade-in (" + (reason || "primed") + ")");
      } catch (eLog) {}
    }

    function flattenLatencyBeforeOpen(reason) {
      /* While muted, worklet underruns still inflate FIFO/boost. Flatten before
       * opening the gain or the first audible touch rides a huge backlog. */
      try {
        if (state.worklet && state.worklet.port)
          state.worklet.port.postMessage({ type: "reset-latency" });
      } catch (e0) {}
      try {
        if (state.worker)
          state.worker.postMessage({ type: "trim_latency", soft: 0 });
      } catch (e1) {}
      try {
        if (typeof state._scriptTrimLatency === "function")
          state._scriptTrimLatency();
      } catch (e2) {}
      try {
        console.log("[sound_bus] flatten latency (" + (reason || "?") + ")");
      } catch (e3) {}
    }

    function maybeReleaseWarmup(queued) {
      var need = state.needFrames > 0 ? state.needFrames | 0 : 768;
      if (state._outputFadedIn) return;
      if (!state.audioReady) return;
      if (state._backgroundMuted || state._backgroundPausing || !state._outputAllowed) return;
      if ((queued | 0) < need) {
        state._warmupReadyCount = 0;
        return;
      }
      state._warmupReadyCount = (state._warmupReadyCount | 0) + 1;
      var required = state._unlockFadePending ? 1 : 2;
      if (state._warmupReadyCount === 1 && required > 1) {
        flattenLatencyBeforeOpen("pre-fade");
        return; /* wait one more healthy fill after flatten */
      }
      if (state._warmupReadyCount < required) return;
      state._unlockFadePending = 0;
      fadeOutputIn("fifo-ready");
    }

    /* Reload / tab kill: hard-close pops. Mute + disconnect sinks FIRST. */
    function fadeOutputOut(reason, durSec, done) {
      var ctx = state.audioCtx;
      var gNode = state.outputGain;
      var dur = durSec > 0 ? durSec : 0.20;
      if (!ctx || !gNode || ctx.state !== "running") {
        if (done) done();
        return dur;
      }
      state._outputFadedIn = 0;
      var g = gNode.gain;
      var t = ctx.currentTime;
      try {
        var cur = g.value;
        if (cur < 0.0001) cur = 0.0001;
        g.cancelScheduledValues(t);
        g.setValueAtTime(cur, t);
        /* Exponential decay — smoother than linear for shutdown. */
        g.exponentialRampToValueAtTime(0.0001, t + dur);
      } catch (eFade) {
        try {
          g.linearRampToValueAtTime(0, t + dur);
        } catch (eLin) {
          try {
            g.value = 0;
          } catch (e2) {}
        }
      }
      try {
        console.log("[sound_bus] output fade-out (" + (reason || "shutdown") + ")");
      } catch (eLog) {}
      if (done) setTimeout(done, (dur * 1000 + 40) | 0);
      return dur;
    }

    function stopWorkerPumpSoft() {
      try {
        if (state.worker) state.worker.postMessage({ type: "shutdown_soft" });
      } catch (e0) {}
    }

    function beginGracefulShutdown(reason) {
      if (state._tearingDown || state._shutdownBegun) return 0;
      state._shutdownBegun = 1;
      state._outputAllowed = 0;
      state._unlockFadePending = 0;
      try {
        if (state._pendingPlays) state._pendingPlays.length = 0;
      } catch (eP) {}
      /* Stop synth pump before the ramp — new PCM during fade clicks on close. */
      stopWorkerPumpSoft();
      var fadeSec = isTerminalLeaveReason(reason)
        ? TERMINAL_LEAVE_FADE_SEC
        : state.mobile
          ? PHONE_LOCK_FADE_SEC
          : 0.20;
      return fadeOutputOut(reason || "shutdown", fadeSec, null);
    }

    function finishGracefulShutdown(reason) {
      if (state._tearingDown) return;
      stopWorkerPumpSoft();
      var ctx = state.audioCtx;
      var detach = function () {
        softMuteTeardown(reason || "shutdown", { gentle: true });
      };
      if (ctx && ctx.state === "running") {
        Promise.resolve(ctx.suspend())
          .then(detach)
          .catch(detach);
      } else detach();
    }

    function gracefulTeardown(reason) {
      /* Phone navigation/lock: async finish never runs — go sync. */
      if (state.mobile) {
        gracefulTeardownSync(reason);
        return;
      }
      var dur = beginGracefulShutdown(reason);
      setTimeout(function () {
        finishGracefulShutdown(reason || "shutdown");
      }, ((dur > 0 ? dur : 0.20) * 1000 + 50) | 0);
    }

    function gracefulTeardownSync(reason) {
      cancelBackgroundPause();
      var dur = beginGracefulShutdown(reason);
      var fadeBase = isTerminalLeaveReason(reason)
        ? TERMINAL_LEAVE_FADE_SEC
        : state.mobile
          ? PHONE_LOCK_FADE_SEC
          : 0.20;
      var waitMs = ((dur > 0 ? dur : fadeBase) * 1000 + 15) | 0;
      if (isTerminalLeaveReason(reason)) {
        if (waitMs > 55) waitMs = 55;
      } else if (waitMs > 90) waitMs = 90;
      busyWaitMs(waitMs);
      silenceScriptSink();
      muteOutputNow();
      var ctx = state.audioCtx;
      if (ctx && ctx.state === "running") {
        try {
          var sus = ctx.suspend();
          if (sus && typeof sus.then === "function") {
            var done = false;
            sus.then(function () {
              done = true;
            });
            busyWaitMs(30);
            void done;
          }
        } catch (eSus) {}
      }
      stopWorkerPumpSoft();
      softMuteTeardown(reason || "shutdown", { gentle: true });
    }

    state.beginGracefulShutdown = beginGracefulShutdown;
    state.finishGracefulShutdown = finishGracefulShutdown;
    state.gracefulTeardown = gracefulTeardown;
    state.gracefulTeardownSync = gracefulTeardownSync;

    function softMuteTeardown(reason, opts) {
      var ctx = state.audioCtx;
      var gNode = state.outputGain;
      opts = opts || {};
      if (state._tearingDown) return;
      state._tearingDown = 1;
      if (!opts.gentle) {
        try {
          if (state.worker) state.worker.postMessage({ type: "stop_all" });
        } catch (e0) {}
        try {
          if (state.worklet && state.worklet.port)
            state.worklet.port.postMessage({ type: "stop_all" });
        } catch (e1) {}
      }
      try {
        if (state._silentAudio) {
          state._silentAudio.pause();
          state._silentAudio.removeAttribute("src");
          state._silentAudio.load();
        }
      } catch (eSa) {}
      try {
        if (gNode && ctx) {
          var g = gNode.gain;
          var t = ctx.currentTime;
          if (opts.gentle) g.setValueAtTime(0, t);
          else {
            g.cancelScheduledValues(t);
            g.setValueAtTime(0, t);
          }
        } else if (gNode) {
          gNode.gain.value = 0;
        }
      } catch (e2) {}
      /* Disconnect so DAC can't play the last residual quantum on kill. */
      try {
        if (state.worklet) state.worklet.disconnect();
      } catch (e3) {}
      try {
        if (state.scriptNode) {
          state.scriptNode.onaudioprocess = null;
          state.scriptNode.disconnect();
        }
      } catch (e4) {}
      try {
        if (gNode) gNode.disconnect();
      } catch (e5) {}
      state.worklet = null;
      state.scriptNode = null;
      state.outputGain = null;
      state._outputFadedIn = 0;
      try {
        console.log("[sound_bus] soft mute teardown (" + (reason || "?") + ")");
      } catch (e6) {}
    }
    state.softMuteTeardown = softMuteTeardown;

    function ensureAudioContext() {
      if (state.audioCtx) return state.audioCtx;
      var AC = global.AudioContext || global.webkitAudioContext;
      /* Prefer engine clock (44.1k) so worker can skip resample â†’ fewer clicks. */
      var acOpts = {
        latencyHint: "interactive",
        sampleRate: state.synthRate > 0 ? state.synthRate | 0 : 44100
      };
      var ctx;
      try {
        ctx = new AC(acOpts);
      } catch (eAc) {
        ctx = new AC({ latencyHint: "interactive" });
      }
      state.audioCtx = ctx;
      state.sampleRate = ctx.sampleRate | 0;
      refreshConvertPath();
      if (typeof state._bindAudioCtxLifecycle === "function")
        state._bindAudioCtxLifecycle(ctx);
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
          /* Minimal WAV â€” HTMLMediaElement.play() carries stronger gesture
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
        /* Route through muted master gain — never poke destination raw (pop). */
        var sink = ensureOutputGain(ctx);
        var buf = ctx.createBuffer(1, 1, ctx.sampleRate || 44100);
        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(sink);
        src.start(0);
        /* Mobile: skip oscillator buzz — HTML silent WAV + resume is enough. */
        if (!state.mobile) {
          try {
            var osc = ctx.createOscillator();
            var g = ctx.createGain();
            g.gain.value = 0.00001;
            osc.connect(g);
            g.connect(sink);
            osc.start(0);
            osc.stop(ctx.currentTime + 0.02);
          } catch (eOsc) {}
        }
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
          maybeReleaseWarmup(msg.queuedFrames | 0);
          if (typeof opts.onAudioStats === "function") opts.onAudioStats(state, msg);
        }
      };
      if (state.inlineSynth) {
        node.port.postMessage({ type: "set-mode", mode: "inline" });
        connectAudioOut(node, ctx);
        state.worklet = node;
        state.audioPath = "worklet-inline";
        markAudioReadyIfRunning();
        fadeOutputIn("inline");
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
      connectAudioOut(node, ctx);
      state.worklet = node;
      state.audioPath = "worklet-pcm";
      markAudioReadyIfRunning();
    }

    /* Prefetch worklet SOURCE only. Do NOT addModule on a suspended context —
     * Chrome Android can hang addModule for seconds until/after resume, and
     * unlock was awaiting that same hung promise (~4s silence after tap). */
    function prefetchWorkletSource() {
      if (state.workletUrl || state._prefetchPromise) return state._prefetchPromise;
      state._prefetchPromise = Promise.resolve().then(function () {
        var override = workletUrl(opts);
        if (override) {
          return fetch(override, { credentials: "same-origin", cache: "force-cache" }).then(
            function (r) {
              if (!r.ok) throw new Error("worklet-fetch");
              return r.text();
            }
          ).then(function (src) {
            var blob = new Blob([src], { type: "application/javascript" });
            state.workletUrl = URL.createObjectURL(blob);
          });
        }
        state.workletUrl = workletBlobUrl();
      });
      return state._prefetchPromise;
    }

    function ensureWorkletModule(ctx) {
      if (state._workletModuleReady) return Promise.resolve();
      if (state._workletModulePromise) return state._workletModulePromise;
      state._workletModulePromise = (async function () {
        try {
          await prefetchWorkletSource();
        } catch (ePref) {}
        var url = state.workletUrl || workletBlobUrl();
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
     * that still called saudio_setup before the flag existed â€” not a watchdog. */
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
        /* The emergency inline worklet intentionally stays tiny.  Preserve
         * Numeris pitch/voice roles with a clean sine fallback; the normal
         * worker path below renders the full GPU-inspired timbres. */
        var inlineMsg = msg;
        var inlineBase = 0;
        if (msg.soundType === "numeris_pulse") inlineBase = 55;
        else if (msg.soundType === "numeris_orbit") inlineBase = 110;
        else if (msg.soundType === "numeris_prism" || msg.soundType === "numeris_chime")
          inlineBase = 220;
        if (inlineBase > 0) {
          inlineMsg = {};
          for (k in msg)
            if (Object.prototype.hasOwnProperty.call(msg, k)) inlineMsg[k] = msg[k];
          inlineMsg.soundType = "tone";
          inlineMsg.freqX = inlineBase * (msg.freqX > 0 ? +msg.freqX : 1);
        }
        state.worklet.port.postMessage(inlineMsg);
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
      /* Drop SFX while tab/window is inactive — avoids ghost glitches on return. */
      if (state._backgroundMuted || state._backgroundPausing) return 0;
      /* Start instruments even before AudioContext unlock â€” worker advances
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
      /* Match synth clock to device when possible â†’ true identity, no cubic resample. */
      var dev = state.sampleRate | 0;
      var cfg = state.synthRate | 0;
      if (dev > 0 && cfg > 0 && dev !== cfg) {
        state.synthRate = dev;
        cfg = dev;
        refreshConvertPath();
      }
      state.worker.postMessage(
        {
          type: "set-audio-port",
          port: port,
          blockFrames: state.blockFrames,
          targetFrames: state.targetFrames,
          needFrames: state.needFrames,
          sampleRate: state.sampleRate || state.synthRate || 44100,
          synthRate: state.synthRate || state.sampleRate || 44100,
          toneHz: state.toneHz
        },
        [port]
      );
    }

    function startScriptProcessorFallback(ctx) {
      /* HTTP Android often has no AudioWorklet. Keep the SAME desktop sound path:
       * worker synth @44.1k â†’ resample â†’ PCM FIFO â†’ this ScriptProcessor sink.
       * (Callback still runs on the render thread â€” prefer HTTPS for Worklet.) */
      console.warn(
        "[sound_bus] ScriptProcessor PCM sink (config " +
          state.synthRate +
          " Hz â†’ device). HTTPS â†’ AudioWorklet recommended so FPS cannot starve audio."
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
      var bufferBoostFrames = 0;
      /* Soft underrun: hold last sample briefly, then slow fade — fast fade-to-0
       * is what the ear hears as random crackle when FPS hitch drains the FIFO. */
      var holdFrames = 256;
      var fadeFrames = 768;
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
      /* Cap cold-start boost — unbounded growth made first Android unlock lag
       * hundreds of ms until background recreate reset the graph. */
      var BUFFER_BOOST_MAX = 4096;
      var BUFFER_BOOST_STEP = 1024;
      var srOut = ctx.sampleRate || 48000;
      var silencePadFrames = Math.max(256, (srOut * 0.014) | 0); /* ~14 ms */

      function rearmUnlockFade() {
        unlockGain = 0;
        unlockActive = state.unlockFadeSec > 0;
        unlockStep =
          unlockActive && state.unlockFadeSec > 0
            ? 1.0 / (state.unlockFadeSec * srOut)
            : 0;
      }

      function softClearFifo(withSilencePad, rearmUnlock) {
        blocks.length = 0;
        current = null;
        offset = 0;
        queuedFrames = 0;
        needSent = false;
        bufferBoostFrames = 0;
        gapFrames = 0;
        if (Math.max(Math.abs(lastOutL), Math.abs(lastOutR)) > 1e-4) {
          xfadeLeft = fadeFrames;
          xfadeFromL = lastOutL;
          xfadeFromR = lastOutR;
        }
        if (rearmUnlock) rearmUnlockFade();
        primed = true; /* avoid underrun crackle while pad / refill lands */
        if (withSilencePad) {
          blocks.push({
            samples: new Float32Array(silencePadFrames * 2),
            frames: silencePadFrames
          });
          queuedFrames = silencePadFrames;
        }
        state.stats.bufferBoostFrames = 0;
        state.stats.queuedFrames = queuedFrames | 0;
      }

      state._scriptTrimLatency = function () {
        softClearFifo(true, true);
      };
      /* First unlock: only clear a deep backlog; otherwise just re-arm the
       * unlock fade so startup does not click through a hard flush. */
      state._scriptSoftTrimLatency = function () {
        var deep = (state.targetFrames | 0) * 1.35;
        if (deep < 1536) deep = 1536;
        bufferBoostFrames = 0;
        gapFrames = 0;
        rearmUnlockFade();
        if (queuedFrames > deep) softClearFifo(true, true);
        else state.stats.bufferBoostFrames = 0;
      };
      state._scriptSilenceForTeardown = function () {
        blocks.length = 0;
        current = null;
        offset = 0;
        queuedFrames = 0;
        needSent = false;
        gapFrames = 0;
        xfadeLeft = 0;
        lastOutL = 0;
        lastOutR = 0;
        bufferBoostFrames = 0;
        state.stats.queuedFrames = 0;
      };

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
          softClearFifo(false, false);
        }
      };
      audioPort.start && audioPort.start();

      function requestFill(force) {
        var need = (state.needFrames | 0) + (bufferBoostFrames >> 1);
        if (queuedFrames >= need) {
          needSent = false;
          return;
        }
        if (!force && needSent) return;
        needSent = true;
        audioPort.postMessage({
          type: "need",
          queuedFrames: queuedFrames | 0,
          needFrames: need | 0,
          targetFrames: ((state.targetFrames | 0) + bufferBoostFrames) | 0
        });
      }

      attachWorkerAudioPort(channel.port1);

      /* Mobile: mid quantum (4096 ≈85 ms@48k felt laggy on first unlock). */
      var bufSize = state.mobile ? 2048 : 1024;
      if (!ctx.createScriptProcessor) throw new Error("no-script-processor");
      var sp = ctx.createScriptProcessor(bufSize, 0, 2);
      sp.onaudioprocess = function (e) {
        var left = e.outputBuffer.getChannelData(0);
        var right = e.outputBuffer.getChannelData(1);
        var n = left.length;
        var i, si, rawL, rawR, fade, phase;
        /* Ask early in the callback so the worker can fill during this quantum. */
        requestFill(queuedFrames < state.needFrames + (bufferBoostFrames >> 1));
        for (i = 0; i < n; i++) {
          if (!current || offset >= current.frames) {
            current = blocks.length ? blocks.shift() : null;
            offset = 0;
          }
          if (!current) {
            if (primed) {
              if (gapFrames === 0) {
                underruns++;
                bufferBoostFrames += BUFFER_BOOST_STEP;
                if (bufferBoostFrames > BUFFER_BOOST_MAX)
                  bufferBoostFrames = BUFFER_BOOST_MAX;
              }
              gapFrames++;
              if (gapFrames <= holdFrames) {
                left[i] = lastOutL;
                right[i] = lastOutR;
              } else {
                fade = 1.0 - (gapFrames - holdFrames) / fadeFrames;
                if (fade < 0) fade = 0;
                left[i] = lastOutL * fade;
                right[i] = lastOutR * fade;
                lastOutL = left[i];
                lastOutR = right[i];
              }
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
        state.stats.bufferBoostFrames = bufferBoostFrames | 0;
        maybeReleaseWarmup(queuedFrames | 0);
        requestFill(true);
      };
      sp.connect(ensureOutputGain(ctx));
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
          maybeReleaseWarmup(msg.queuedFrames | 0);
          if (typeof opts.onAudioStats === "function") opts.onAudioStats(state, msg);
        }
      };

      if (state.inlineSynth) {
        node.port.postMessage({ type: "set-mode", mode: "inline" });
        connectAudioOut(node, ctx);
        state.worklet = node;
        state.audioPath = "worklet-inline";
        markAudioReadyIfRunning();
        fadeOutputIn("inline");
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

      connectAudioOut(node, ctx);
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
      state._tearingDown = 0;
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

      /* Secure (HTTPS/localhost): Worklet first. ScriptProcessor on the GL thread
       * causes rare crackles with ur=0 (browser glitch before our FIFO check).
       * Insecure HTTP: ScriptProcessor immediately, optional Worklet upgrade. */
      if (!state.worklet && !state.scriptNode) {
        try {
          if (workletSupported(ctx) && isSecureEnough()) {
            if (state._workletModuleReady) {
              state.audioStage = "worklet";
              attachWorkletNodeSync(ctx);
            } else {
              state.audioStage = "worklet-loading";
              ensureWorkletModule(ctx)
                .then(function () {
                  if (state.worklet) return;
                  if (!state.audioCtx || state.audioCtx !== ctx) return;
                  try {
                    if (state.scriptNode) {
                      try {
                        state.scriptNode.disconnect();
                      } catch (eDisc0) {}
                      state.scriptNode = null;
                    }
                    state.audioStage = "worklet";
                    attachWorkletNodeSync(ctx);
                    markAudioReadyIfRunning();
                    if (state.audioReady && typeof opts.onAudioReady === "function")
                      opts.onAudioReady(state);
                    console.log("[sound_bus] Worklet ready (HTTPS path)");
                  } catch (eWl) {
                    console.warn("[sound_bus] Worklet attach failed â†’ script-pcm", eWl);
                    state.error = "worklet-attach:" + (eWl && eWl.message ? eWl.message : eWl);
                    if (!state.scriptNode) startScriptProcessorFallback(ctx);
                    markAudioReadyIfRunning();
                  }
                })
                .catch(function (eMod) {
                  console.warn("[sound_bus] Worklet addModule failed â†’ script-pcm", eMod);
                  state.error = "worklet-module:" + (eMod && eMod.message ? eMod.message : eMod);
                  if (!state.worklet && !state.scriptNode) {
                    try {
                      startScriptProcessorFallback(ctx);
                      markAudioReadyIfRunning();
                    } catch (eFb) {}
                  }
                });
            }
          } else if (state._workletModuleReady && workletSupported(ctx)) {
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
                    console.log("[sound_bus] upgraded ScriptProcessor â†’ Worklet");
                  } catch (eUp) {
                    console.warn("[sound_bus] worklet upgrade failed", eUp);
                    state.error = "worklet-upgrade:" + (eUp && eUp.message ? eUp.message : eUp);
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
          if (state.audioReady) {
            /* Cut silence pre-buffered while suspended / warm-up. */
            state._outputFadedIn = 0;
            state._warmupReadyCount = 0;
            state._unlockFadePending = 1;
            trimAudioLatency("unlock", true);
            flattenLatencyBeforeOpen("unlock");
            flushPendingPlays();
          } else
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

    /* Background / screen-off suspends the context; on return Chrome often
     * keeps a fat backlog until the user sleeps the tab (which recreates).
     * Trim (or nuke if still suspended) so latency matches a warm session. */
    if (!state._visibilityBound && typeof document !== "undefined") {
      state._visibilityBound = 1;
      document.addEventListener("visibilitychange", function () {
        /* Capture: phone lock fires this then freezes JS — handle ASAP. */
        syncPageAudible("visibility");
      }, true);
    }

    if (!state._focusBound && typeof window !== "undefined") {
      state._focusBound = 1;
      /* Soft mute on blur only — do not stop voices / suspend (startup focus
       * flicker was leaving a single leftover note of the beat). */
      window.addEventListener("blur", function () {
        if (document.visibilityState === "hidden") return;
        state._outputAllowed = 0;
        /* Soft duck only — visibility/interrupted handle phone lock sync fade. */
        fadeOutputIfAudible("blur", BLUR_FADE_SEC);
      });
      window.addEventListener("focus", function () {
        if (document.visibilityState === "hidden") return;
        cancelBackgroundPause();
        if (state._backgroundMuted) {
          syncPageAudible("focus");
          return;
        }
        state._outputAllowed = 1;
        state._warmupReadyCount = 0;
        state._outputFadedIn = 0;
        state._unlockFadePending = 1;
      });
    }

    if (!state._freezeBound && typeof document !== "undefined") {
      state._freezeBound = 1;
      /* bfcache / back-forward / phone freeze */
      window.addEventListener("freeze", function () {
        pauseForBackground("freeze");
      }, true);
    }

    /* iOS / some Android: AudioContext → interrupted on screen lock. */
    function bindAudioCtxLifecycle(ctx) {
      if (!ctx || ctx._numerisLifecycleBound) return;
      ctx._numerisLifecycleBound = 1;
      try {
        ctx.addEventListener("statechange", function () {
          var st = ctx.state;
          if (st === "interrupted" || st === "suspended") {
            if (!state._backgroundMuted && !state._shutdownBegun)
              pauseForBackground(st === "interrupted" ? "interrupted" : "ctx-suspended");
          }
        });
      } catch (eLc) {}
    }
    state._bindAudioCtxLifecycle = bindAudioCtxLifecycle;
    if (state.audioCtx) bindAudioCtxLifecycle(state.audioCtx);

    if (!state._unloadBound && typeof window !== "undefined") {
      state._unloadBound = 1;
      var onPageHide = function (ev) {
        if (ev && ev.persisted) return;
        cancelBackgroundPause();
        /* Android app switch: recover on return — do not destroy the graph. */
        if (state.mobile) {
          pauseForBackground("pagehide");
          return;
        }
        gracefulTeardownSync("pagehide");
      };
      var onTerminalLeave = function (ev) {
        if (ev && ev.persisted) return;
        cancelBackgroundPause();
        gracefulTeardownSync("pagehide");
      };
      window.addEventListener("pagehide", onPageHide, true);
      document.addEventListener("pagehide", onPageHide, true);
      window.addEventListener("beforeunload", onTerminalLeave, true);
      window.addEventListener("unload", onTerminalLeave, true);
    }

    if (!state._pageshowBound && typeof window !== "undefined") {
      state._pageshowBound = 1;
      window.addEventListener(
        "pageshow",
        function (ev) {
          if (ev && ev.persisted) syncPageAudible("pageshow-bfcache");
          else if (isPageAudible()) syncPageAudible("pageshow");
        },
        true
      );
    }

    state.stop = function () {
      gracefulTeardownSync("stop");
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
      try {
        if (state.outputGain) state.outputGain.disconnect();
      } catch (eOg) {}
      state.outputGain = null;
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
  global.SoundBus = api;
  global.SoundBusProto = api; /* alias */
  if (typeof global.Module !== "undefined") {
    global.Module.SoundBus = api;
    global.Module.SoundBusProto = api;
  }
})(typeof self !== "undefined" ? self : this);
