/* AudioWorklet: realtime tweet/tone synth (priority path).
 *
 * Envelope matches ssound/sbase.ginc (sustain + exp(-envelop*(t-duration))).
 * legacyTimeScale remains configurable for A/B tests; production uses 1.0 so
 * one device frame advances exactly one sample of tweet.sound time.
 */
class SpinAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var opts = (options && options.processorOptions) || {};
    this.mode = opts.mode === "pcm" ? "pcm" : "inline";
    this.lightSynth = !!opts.lightSynth;
    this.legacyTimeScale =
      opts.legacyTimeScale > 0 ? +opts.legacyTimeScale : 1.0;
    this.blocks = [];
    this.queuedFrames = 0;
    this.current = null;
    this.offset = 0;
    this.underruns = 0; /* gap events, not individual samples */
    this.underrunFrames = 0;
    this.maxGapFrames = 0;
    this.gapFrames = 0;
    this.gapStartL = 0;
    this.gapStartR = 0;
    this.lastOutL = 0;
    this.lastOutR = 0;
    this.crossfadeFrames = 128;
    this.crossfadeLeft = 0;
    this.crossfadeFromL = 0;
    this.crossfadeFromR = 0;
    this.recoveryLeft = 0;
    this.recoveryFromL = 0;
    this.recoveryFromR = 0;
    this.minQueuedFrames = 0x7fffffff;
    this.fillWaitLastFrames = 0;
    this.fillWaitMaxFrames = 0;
    this.renderFrames = 0;
    this.needSentAtFrame = 0;
    this.bufferBoostFrames = 0;
    this.needThreshold = 2048;
    this.targetFrames = 4096;
    this.sourcePort = null;
    this._tick = 0;
    this._needSent = false;
    this.primed = false;
    this.master = 1.0;
    this.voices = [];
    this.nextId = 1;
    this.frame = 0;
    this.maxVoices = opts.maxVoices > 0 ? opts.maxVoices | 0 : 24;
    if (this.maxVoices < 4) this.maxVoices = 4;
    if (this.maxVoices > 48) this.maxVoices = 48;

    this.port.onmessage = (event) => {
      var msg = event.data || {};
      if (msg.type === "set-mode") {
        this.mode = msg.mode === "pcm" ? "pcm" : "inline";
        return;
      }
      if (msg.type === "play") {
        this.playVoice(msg);
        return;
      }
      if (msg.type === "stop_all") {
        this.voices.length = 0;
        return;
      }
      if (msg.type === "set_master") {
        this.master = msg.volume >= 0 ? +msg.volume : 1;
        return;
      }
      if (msg.type === "set-source-port") {
        this.sourcePort = msg.port;
        this.needThreshold = msg.needFrames > 0 ? msg.needFrames | 0 : 2048;
        this.targetFrames = msg.targetFrames > 0 ? msg.targetFrames | 0 : 4096;
        this.sourcePort.onmessage = (audioEvent) => {
          var a = audioEvent.data || {};
          if (a.type === "pcm" && a.samples) {
            var samples =
              a.samples instanceof Float32Array
                ? a.samples
                : new Float32Array(a.samples);
            var frames = a.frames | 0;
            if (frames > 0) {
              this.blocks.push({ samples: samples, frames: frames });
              this.queuedFrames += frames;
              if (this._needSent) {
                this.fillWaitLastFrames =
                  this.renderFrames - this.needSentAtFrame;
                if (this.fillWaitLastFrames > this.fillWaitMaxFrames)
                  this.fillWaitMaxFrames = this.fillWaitLastFrames;
              }
              this._needSent = false;
              if (this.queuedFrames >= this.needThreshold) this.primed = true;
            }
          } else if (a.type === "flush") {
            /* Drop stale pre-buffered silence so a newly played bird starts at
             * the next render quantum instead of behind ~170 ms of FIFO. */
            this.blocks.length = 0;
            this.current = null;
            this.offset = 0;
            this.queuedFrames = 0;
            this._needSent = false;
            /* An idle queue ends at zero, so the exact tweet attack can pass
             * unchanged. Keep the de-zipper only for a real discontinuity. */
            this.crossfadeLeft =
              Math.max(Math.abs(this.lastOutL), Math.abs(this.lastOutR)) > 1e-4
                ? this.crossfadeFrames
                : 0;
            this.crossfadeFromL = this.lastOutL;
            this.crossfadeFromR = this.lastOutR;
          }
        };
        this.sourcePort.start();
        if (this.mode === "pcm") this.requestFill(true);
        return;
      }
      if (msg.type === "set-thresholds") {
        if (msg.needFrames > 0) this.needThreshold = msg.needFrames | 0;
        if (msg.targetFrames > 0) this.targetFrames = msg.targetFrames | 0;
      }
    };
  }

  envelopDecaySeconds(envelop) {
    if (!(envelop > 1e-6)) return 0.5;
    var d = Math.log(0.001) / -envelop;
    if (!isFinite(d) || d < 0) return 0.5;
    if (d > 4) return 4;
    return d;
  }

  playVoice(desc) {
    if (this.voices.length >= this.maxVoices) this.voices.shift();
    var fadein = desc.fadein >= 0 ? +desc.fadein : 0.0000006;
    if (fadein < 0) fadein = 0;
    var envelop = desc.envelop >= 0 ? +desc.envelop : 8.0;
    var duration = desc.duration > 0 ? +desc.duration : 0.08;
    var decay = this.envelopDecaySeconds(envelop);
    this.voices.push({
      id: this.nextId++,
      start: this.frame + (desc.startOffsetFrames | 0),
      duration: duration,
      totalLife: duration + decay,
      volume: desc.volume >= 0 ? +desc.volume : 0.6,
      fadein: fadein,
      envelop: envelop,
      freqX: desc.freqX != null ? +desc.freqX : 2.0,
      freqY: desc.freqY != null ? +desc.freqY : 4.0,
      freqZ: desc.freqZ != null ? +desc.freqZ : 0.0,
      type: desc.soundType === "tone" ? "tone" : "tweet",
      phase: 0
    });
    this.primed = true;
  }

  hash1(p) {
    var p2x = (p * 5.3983) % 1;
    if (p2x < 0) p2x += 1;
    var p2y = (p * 5.4427) % 1;
    if (p2y < 0) p2y += 1;
    var d = p2y * (p2x + 21.5351) + p2x * (p2y + 14.3137);
    p2x += d;
    p2y += d;
    var r = (p2x * p2y * 95.4337) % 1;
    return r < 0 ? r + 1 : r;
  }
  noise(n) {
    var f = n - Math.floor(n);
    n = Math.floor(n);
    f = f * f * (3.0 - 2.0 * f);
    return this.hash1(n) * (1 - f) + this.hash1(n + 1) * f - 0.5;
  }
  noiseSlope(n, loc) {
    var f = n - Math.floor(n);
    n = Math.floor(n);
    if (loc <= 0) f = f >= 1 ? 1 : 0;
    else {
      f = f / loc;
      if (f < 0) f = 0;
      if (f > 1) f = 1;
      f = f * f * (3 - 2 * f);
    }
    return this.hash1(n) * (1 - f) + this.hash1(n + 1) * f;
  }
  smoothstep(edge0, edge1, x) {
    var t = (x - edge0) / (edge1 - edge0);
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return t * t * (3 - 2 * t);
  }
  tweetVolume(t) {
    var n1 = this.noiseSlope(t * 11.0, 0.3);
    var n2 = this.smoothstep(0.0, 1.0, Math.abs(Math.sin(t * 14.0)));
    var n3 = this.smoothstep(0.4, 0.9, this.noiseSlope(t * 0.5 + 4.0, 0.3));
    var n = n1 * n2 * 0.2 * n3;
    n = n * n;
    if (n < 0) n = 0;
    if (n > 1) n = 1;
    return n;
  }
  /* Full Shadertoy FM - desktop. Aliases hard above ~Nyquist/4. */
  tweetHeavy(t) {
    t = t - 1.5;
    var f =
      Math.sin(6.2831 * 2.0 * t) * this.noise(t * 8.1 - 100.0) * 100.0 + 5000.0;
    f += Math.cos(50.0 * 6.2831 * t);
    return Math.sin(6.2831 * f * t);
  }
  sampleTweetHeavy(t, freqX, freqY) {
    var volume = this.tweetVolume((t + freqY - 0.5) * 0.6) * 20.0;
    /* Match tweet.sound exactly; final device mixing performs the clamp. */
    return this.tweetHeavy((t + freqX) * 0.4) * volume;
  }
  /* Mobile: phase-accum chirp in bird range (1.8–4.5 kHz), same gate feel. */
  sampleTweetLight(t, freqX, freqY, voice, dt) {
    var gate = this.tweetVolume((t + freqY * 0.08) * 0.6);
    if (gate < 1e-4) {
      voice.phase = 0;
      return 0;
    }
    /* Phrase offset without jumping into chaotic FM region. */
    var phrase = (freqX * 0.015) % 0.4;
    var tt = t + phrase;
    var sweep =
      1900 +
      2200 * (0.5 + 0.5 * Math.sin(tt * 16.0 + freqX * 0.25)) +
      350 * Math.sin(tt * 37.0);
    if (sweep > 4500) sweep = 4500;
    if (sweep < 1200) sweep = 1200;
    voice.phase += sweep * dt;
    if (voice.phase > 1e6) voice.phase -= 1e6;
    var sig = Math.sin(6.28318530718 * voice.phase);
    sig *= 0.6 + 0.4 * Math.sin(tt * 42.0);
    return sig * gate * 0.55;
  }
  panSimple(pos) {
    if (pos > 1.25) pos = 1.25;
    if (pos < -1.25) pos = -1.25;
    var e0 = 1 - pos,
      e1 = 1 + pos;
    var len = Math.sqrt(e0 * e0 + e1 * e1);
    if (len < 1e-8) return [0.707, 0.707];
    return [e0 / len, e1 / len];
  }
  envelope(t, v) {
    if (t < 0 || t > v.totalLife) return 0;
    var e = t < v.duration ? 1.0 : Math.exp(-v.envelop * (t - v.duration));
    if (v.fadein > 1e-12 && t < v.fadein) e *= t / v.fadein;
    return e < 0 ? 0 : e > 1 ? 1 : e;
  }

  requestFill(force) {
    var effectiveNeed;
    if (this.mode !== "pcm" || !this.sourcePort) return;
    effectiveNeed = this.needThreshold + (this.bufferBoostFrames >> 1);
    if (this.queuedFrames >= effectiveNeed) {
      this._needSent = false;
      return;
    }
    if (!force && this._needSent) return;
    this._needSent = true;
    this.needSentAtFrame = this.renderFrames;
    this.sourcePort.postMessage({
      type: "need",
      queuedFrames: this.queuedFrames | 0,
      needFrames: effectiveNeed | 0,
      targetFrames: (this.targetFrames + this.bufferBoostFrames) | 0
    });
  }

  processInline(left, right, n) {
    var sr = sampleRate;
    var dt = 1.0 / sr;
    var i, vi, v, t, env, sig, pan, g, absFrame, endFrame;
    var still = [];
    for (i = 0; i < n; i++) {
      left[i] = 0;
      right[i] = 0;
    }
    for (vi = 0; vi < this.voices.length; vi++) {
      v = this.voices[vi];
      endFrame = v.start + Math.ceil(v.totalLife * sr);
      if (this.frame >= endFrame) continue;
      still.push(v);
      /* Legacy tweet.sound writes the same signal to both channels and ignores
       * freq.z. Keep panning only for tone/mobile voices. */
      pan = v.type === "tweet" && !this.lightSynth ? [1.0, 1.0] : this.panSimple(v.freqZ);
      for (i = 0; i < n; i++) {
        absFrame = this.frame + i;
        if (absFrame < v.start) continue;
        t = (absFrame - v.start) * dt;
        if (v.type === "tweet") t *= this.legacyTimeScale;
        env = this.envelope(t, v);
        if (env <= 1e-5) continue;
        if (v.type === "tone")
          sig = Math.sin(6.28318530718 * (v.freqX > 20 ? v.freqX : 440) * t) * 0.15;
        else if (this.lightSynth)
          sig = this.sampleTweetLight(t, v.freqX, v.freqY, v, dt);
        else sig = this.sampleTweetHeavy(t, v.freqX, v.freqY);
        g = sig * v.volume * env * this.master;
        left[i] += g * pan[0];
        right[i] += g * pan[1];
      }
    }
    this.voices = still;
    for (i = 0; i < n; i++) {
      if (left[i] > 1) left[i] = 1;
      else if (left[i] < -1) left[i] = -1;
      if (right[i] > 1) right[i] = 1;
      else if (right[i] < -1) right[i] = -1;
    }
    this.frame += n;
  }

  processPcm(left, right, n) {
    var i, si, rawL, rawR, phase, fade;
    for (i = 0; i < n; i++) {
      if (!this.current || this.offset >= this.current.frames) {
        this.current = this.blocks.length ? this.blocks.shift() : null;
        this.offset = 0;
      }
      if (!this.current) {
        if (this.primed) {
          if (this.gapFrames === 0) {
            this.underruns++;
            this.gapStartL = this.lastOutL;
            this.gapStartR = this.lastOutR;
            /* Grow look-ahead only after a real starvation event. */
            this.bufferBoostFrames += 1024;
            if (this.bufferBoostFrames > 8192) this.bufferBoostFrames = 8192;
          }
          this.gapFrames++;
          this.underrunFrames++;
          if (this.gapFrames > this.maxGapFrames)
            this.maxGapFrames = this.gapFrames;
          /* A missing block cannot be reconstructed safely. Fade the last
           * continuous sample to zero instead of inserting a hard edge. */
          fade = 1.0 - this.gapFrames / this.crossfadeFrames;
          if (fade < 0) fade = 0;
          left[i] = this.gapStartL * fade;
          right[i] = this.gapStartR * fade;
          this.lastOutL = left[i];
          this.lastOutR = right[i];
        } else {
          left[i] = 0.0;
          right[i] = 0.0;
          this.lastOutL = 0.0;
          this.lastOutR = 0.0;
        }
        continue;
      }
      si = this.offset * 2;
      rawL = this.current.samples[si];
      rawR = this.current.samples[si + 1];
      if (this.gapFrames > 0) {
        if (this.crossfadeLeft <= 0) {
          this.recoveryLeft = this.crossfadeFrames;
          this.recoveryFromL = this.lastOutL;
          this.recoveryFromR = this.lastOutR;
        } else this.recoveryLeft = 0;
        this.gapFrames = 0;
      }
      if (this.crossfadeLeft > 0) {
        phase = 1.0 - this.crossfadeLeft / this.crossfadeFrames;
        left[i] = this.crossfadeFromL * (1.0 - phase) + rawL * phase;
        right[i] = this.crossfadeFromR * (1.0 - phase) + rawR * phase;
        this.crossfadeLeft--;
      } else if (this.recoveryLeft > 0) {
        phase = 1.0 - this.recoveryLeft / this.crossfadeFrames;
        left[i] = this.recoveryFromL * (1.0 - phase) + rawL * phase;
        right[i] = this.recoveryFromR * (1.0 - phase) + rawR * phase;
        this.recoveryLeft--;
      } else {
        left[i] = rawL;
        right[i] = rawR;
      }
      this.lastOutL = left[i];
      this.lastOutR = right[i];
      this.offset++;
      this.queuedFrames--;
      if (this.queuedFrames < 0) this.queuedFrames = 0;
      if (this.primed && this.queuedFrames < this.minQueuedFrames)
        this.minQueuedFrames = this.queuedFrames;
    }
  }

  process(inputs, outputs) {
    var output = outputs[0];
    var left = output[0];
    var right = output[1] || output[0];
    var n = left.length;

    if (this.mode === "inline") this.processInline(left, right, n);
    else this.processPcm(left, right, n);

    this.renderFrames += n;
    if (this.mode === "pcm") this.requestFill(false);
    this._tick++;
    if ((this._tick & 15) === 0) {
      this.port.postMessage({
        type: "stats",
        underruns: this.underruns,
        underrunFrames: this.underrunFrames,
        maxGapMs: (this.maxGapFrames * 1000) / sampleRate,
        minQueuedFrames:
          this.minQueuedFrames === 0x7fffffff ? this.queuedFrames : this.minQueuedFrames,
        fillWaitMs: (this.fillWaitLastFrames * 1000) / sampleRate,
        fillWaitMaxMs: (this.fillWaitMaxFrames * 1000) / sampleRate,
        bufferBoostFrames: this.bufferBoostFrames,
        queuedFrames:
          this.mode === "inline" ? this.voices.length : this.queuedFrames | 0,
        blocks: this.blocks.length | 0,
        mode: this.mode,
        voices: this.voices.length | 0
      });
    }
    return true;
  }
}

registerProcessor("spin-audio-processor", SpinAudioProcessor);
