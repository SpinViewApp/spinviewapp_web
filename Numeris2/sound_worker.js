/* sound_worker.js — synth + PCM pump (SoundWorkerSsound inlined) — single file for blobconef audio.
 * Cache: andr36
 */
/* Proto 3 â€” SoundWorkerSsound: WASM tweet synth with JS fallback.
 * Tries createSoundWorkerModule (App.js) first; else CPU JS port of tweet.sound.
 */
(function (root) {
  "use strict";

  /* Engine clock = SSOUND_SAMPLE_RATE from C (-D). Device may differ:
   * synthesize on the config grid, then resample out if needed. */
  var CONFIG_SR = 44100;
  var SR = CONFIG_SR;
  var outputRate = CONFIG_SR;
  var voices = [];
  var nextId = 1;
  var audioFrame = 0;
  var master = 1.0;
  var backend = "js";
  var wasm = null;
  var loadPromise = null;
  var F32 = Math.fround;
  var jsLastPeak = 0.0;
  var echoBuffer = new Float32Array(CONFIG_SR * 2);
  var echoPos = 0;
  var echoQuietSamples = CONFIG_SR; /* bfx-style idle: skip flush while delay still rings */
  var ECHO_DELAY = (CONFIG_SR * 0.08) | 0; /* Numeris default: 80 ms */
  var ECHO_MIX = 0.3;
  var ECHO_FB = 0.4;
  var ECHO_QUIET_EPS = 1.0e-4;

  function applyConfigRate(sr) {
    sr = sr > 0 ? sr | 0 : 44100;
    if (sr === CONFIG_SR) return;
    CONFIG_SR = sr;
    SR = CONFIG_SR;
    ECHO_DELAY = (CONFIG_SR * 0.08) | 0;
    echoBuffer = new Float32Array(CONFIG_SR * 2);
    echoPos = 0;
    echoQuietSamples = CONFIG_SR;
    jsLastPeak = 0;
    resetOutput();
  }

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
  var PI2 = 6.28318530718;
  /* Approximate GPU .sound timbres for Numeris SFX (web has no GPU audio pump). */
  function sampleSound1(t, freqX, freqY, freqZ, freqW) {
    var hz = fmul(110.0, freqX > 0.25 ? freqX : 0.25);
    var harm = fadd(1.0, fmul(freqW < 0 ? 0 : freqW > 4 ? 4 : freqW, 0.25));
    var gain = fadd(6.0, fmul(Math.abs(freqY), 2.0));
    var env = fmul(fexp(fmul(-8.0, t)), smoothstep32(0.0, 0.002, t));
    var s0 = fmul(fsin(fmul(fmul(PI2, hz), t)), env);
    var s1 = fmul(fsin(fmul(fmul(PI2, fmul(hz, fmul(harm, 2.0))), t)), fmul(env, 0.35));
    return fmul(fadd(s0, s1), gain);
  }
  function sampleJoyHop(hz, t, decay, bright) {
    if (t < 0) return 0;
    var env = fmul(fexp(fmul(-decay, t)), smoothstep32(0.0, 0.0035, t));
    var body = fsin(fmul(fmul(PI2, hz), t));
    var ping = fmul(fsin(fmul(fmul(PI2, fmul(hz, fadd(2.0, fmul(bright, 0.35)))), t)), 0.32);
    return fmul(fadd(body, ping), fmul(env, 2.2));
  }
  function sampleJoy(t, freqX, freqY, freqZ, freqW) {
    var pitch = freqX > 0.35 ? freqX : 0.35;
    var sparkle = freqY < 0 ? 0 : freqY > 4 ? 4 : freqY;
    var bounce = freqW < 0 ? 0 : freqW > 4 ? 4 : freqW;
    var hz = fmul(246.0, pitch);
    var mono = 0.0;
    mono = fadd(mono, sampleJoyHop(hz, t, 10.0, sparkle));
    mono = fadd(mono, fmul(sampleJoyHop(fmul(hz, 1.125), fsub(t, 0.042), 11.0, sparkle), 0.88));
    mono = fadd(mono, fmul(sampleJoyHop(fmul(hz, 1.25), fsub(t, 0.084), 11.5, sparkle), 0.78));
    mono = fadd(mono, fmul(sampleJoyHop(fmul(hz, 1.5), fsub(t, 0.13), 10.5, sparkle), 0.92));
    if (bounce > 0.6) {
      mono = fadd(mono, fmul(sampleJoyHop(fmul(hz, 1.5), fsub(t, 0.195), 12.0, sparkle), fmul(0.55, bounce)));
      mono = fadd(mono, fmul(sampleJoyHop(fmul(hz, 2.0), fsub(t, 0.25), 9.5, sparkle), fmul(0.7, bounce > 2 ? 2 : bounce)));
    }
    return softClip(fmul(mono, fadd(3.8, fmul(sparkle, 0.35))));
  }
  function sampleMalice(t, freqX, freqY, freqZ, freqW) {
    var growl = freqX < 0.3 ? 0.3 : freqX > 4 ? 4 : freqX;
    var rasp = freqY < 0 ? 0 : freqY > 5 ? 5 : freqY;
    var bite = freqW < 0 ? 0 : freqW > 4 ? 4 : freqW;
    var hit = fmul(smoothstep32(0.0, 0.008, t), fsub(1.0, smoothstep32(0.12, 0.28, t)));
    var f0 = fadd(55.0, fmul(growl, 28.0));
    var body = fsin(fmul(fmul(PI2, f0), t));
    body = fadd(body, fmul(fsin(fmul(fmul(PI2, fmul(f0, 1.41)), t)), 0.7));
    body = fadd(body, fmul(fsin(fmul(fmul(PI2, fmul(f0, 1.89)), t)), 0.45));
    var grit = fmul(
      fsub(fmul(Hash1(fmul(t, fadd(900.0, fmul(rasp, 400.0)))), 2.0), 1.0),
      fmul(fexp(fmul(-t, fadd(10.0, fmul(bite, 4.0)))), fadd(0.35, fmul(rasp, 0.15)))
    );
    return softClip(fmul(fadd(fmul(body, hit), grit), fadd(3.0, fmul(bite, 0.4))));
  }
  function sampleElectric(t, freqX, freqY, freqZ, freqW) {
    var tone = freqX < 0.25 ? 0.25 : freqX > 3 ? 3 : freqX;
    var settle = freqW < 0 ? 0 : freqW > 1 ? 1 : freqW;
    var dur = 0.12;
    var hitLen = fmul(dur, fadd(1.0, fmul(fsub(0.35, 1.0), settle)));
    if (hitLen < 0.04) hitLen = 0.04;
    if (t > hitLen) return 0;
    var hitEnv = fmul(smoothstep32(0.0, 0.012, t), fsub(1.0, smoothstep32(fmul(hitLen, 0.65), hitLen, t)));
    var bright = fdiv(fsub(tone, 0.25), 2.75);
    var fHi = fadd(400.0, fmul(fmul(tone, tone), 2800.0));
    var bolt = fsin(fmul(fmul(PI2, fHi), t));
    var crack = fmul(
      fsub(fmul(Hash1(fmul(t, 11000.0)), 2.0), 1.0),
      fmul(fsin(fmul(fmul(PI2, fadd(900.0, fmul(bright, 2300.0))), t)), 0.35)
    );
    return softClip(fmul(fadd(bolt, crack), fmul(hitEnv, 2.8)));
  }

  /* CPU mirrors for the four Numeris GPU instruments.  They deliberately use
   * the same slot1 contract as the .sound shaders so native and Web keep the
   * same musical roles even when WebGL audio runs through this worker. */
  function sampleNumerisPulse(t, freqX, freqY, freqZ, freqW) {
    var ratio = freqX < 0.25 ? 0.25 : freqX > 8 ? 8 : freqX;
    var warmth = freqY < 0 ? 0 : freqY > 1 ? 1 : freqY;
    var click = freqW < 0 ? 0 : freqW > 1 ? 1 : freqW;
    var hz = 55.0 * ratio;
    var attack = smoothstep32(0.0, 0.004, t);
    var env = attack * Math.exp(-t * (8.0 + (3.0 - 8.0) * warmth));
    var bend = Math.exp(-28.0 * t) * (0.45 + click * 1.6);
    var phase = PI2 * hz * t + bend;
    var body = Math.sin(phase);
    body += Math.sin(phase * 0.5) * (0.28 + warmth * 0.22);
    body += Math.sin(phase * 2.01) * (0.20 - warmth * 0.10);
    body += Math.sin(PI2 * hz * (5.0 + click * 3.0) * t)
      * Math.exp(-32.0 * t) * click * 0.32;
    return body * env * 1.45 / (1.0 + Math.abs(body * env * 1.45));
  }

  function sampleNumerisOrbit(t, freqX, freqY, freqZ, freqW) {
    var ratio = freqX < 0.25 ? 0.25 : freqX > 8 ? 8 : freqX;
    var bright = freqY < 0 ? 0 : freqY > 1 ? 1 : freqY;
    var character = freqW < 0 ? 0 : freqW > 1 ? 1 : freqW;
    var hz = 110.0 * ratio;
    var attackEnd = 0.003 + (0.018 - 0.003) * character;
    var attack = smoothstep32(0.0, attackEnd, t);
    var env = attack * Math.exp(-t * (7.0 + (2.8 - 7.0) * character));
    var orbitRatio = 1.4983 + (2.0031 - 1.4983) * character;
    var modEnv = Math.exp(-t * (4.0 + bright * 3.0));
    var modulator = Math.sin(PI2 * hz * orbitRatio * t
      + Math.sin(PI2 * 0.37 * t) * 0.35);
    var carrier = Math.sin(PI2 * hz * t
      + modulator * (0.5 + bright * 3.0) * modEnv);
    var halo = Math.sin(PI2 * hz * 2.001 * t + 0.4)
      * (0.10 + bright * 0.20);
    var sub = Math.sin(PI2 * hz * 0.5 * t) * character * 0.18;
    var mono = (carrier + halo + sub) * env * 1.55;
    return mono / (1.0 + Math.abs(mono));
  }

  function sampleNumerisPrism(t, freqX, freqY, freqZ, freqW) {
    var ratio = freqX < 0.25 ? 0.25 : freqX > 8 ? 8 : freqX;
    var bright = freqY < 0 ? 0 : freqY > 1 ? 1 : freqY;
    var glass = freqW < 0 ? 0 : freqW > 1 ? 1 : freqW;
    var hz = 220.0 * ratio;
    var attack = smoothstep32(0.0, 0.0025, t);
    var e0 = attack * Math.exp(-t * (4.8 + (2.6 - 4.8) * glass));
    var e1 = attack * Math.exp(-t * (8.5 + (5.2 - 8.5) * bright));
    var e2 = attack * Math.exp(-t * 12.0);
    var r2 = 2.0 + 0.071 * glass;
    var r3 = 3.0 + 0.119 * glass;
    var r5 = 5.0 + 0.337 * glass;
    var mono = Math.sin(PI2 * hz * t) * e0;
    mono += Math.sin(PI2 * hz * r2 * t + 0.23) * e1 * (0.24 + bright * 0.24);
    mono += Math.sin(PI2 * hz * r3 * t + 0.61) * e1 * (0.10 + bright * 0.18);
    mono += Math.sin(PI2 * hz * r5 * t + 1.07) * e2 * bright * 0.12;
    mono *= 1.65;
    return mono / (1.0 + Math.abs(mono));
  }

  function sampleNumerisChimeNote(hz, age, bright) {
    if (age < 0) return 0;
    var env = smoothstep32(0.0, 0.0025, age)
      * Math.exp(-age * (5.6 + bright * 1.8));
    var value = Math.sin(PI2 * hz * age);
    value += Math.sin(PI2 * hz * 2.003 * age + 0.3) * (0.22 + bright * 0.18);
    value += Math.sin(PI2 * hz * 3.997 * age + 0.9) * bright * 0.10;
    return value * env;
  }

  function sampleNumerisChime(t, freqX, freqY, freqZ, freqW) {
    var ratio = freqX < 0.25 ? 0.25 : freqX > 8 ? 8 : freqX;
    var bright = freqY < 0 ? 0 : freqY > 1 ? 1 : freqY;
    var shape = freqW < 0 ? 0 : freqW > 1 ? 1 : freqW;
    var hz = 220.0 * ratio;
    var r1 = 1.125 + (1.20 - 1.125) * shape;
    var r2 = 1.25 + (1.3333333 - 1.25) * shape;
    var r3 = 1.50 + (1.60 - 1.50) * shape;
    var mono = sampleNumerisChimeNote(hz, t, bright);
    mono += sampleNumerisChimeNote(hz * r1, t - 0.060, bright) * 0.82;
    mono += sampleNumerisChimeNote(hz * r2, t - 0.122, bright) * 0.76;
    mono += sampleNumerisChimeNote(hz * r3, t - 0.190, bright) * 0.92;
    mono *= 1.45;
    return mono / (1.0 + Math.abs(mono));
  }

  function sampleVoice(v, t) {
    var ty = v.type || "tweet";
    if (ty === "tone")
      return fmul(fsin(fmul(fmul(PI2, v.freqX > 20 ? v.freqX : 440), t)), 0.15);
    if (ty === "sound1") return sampleSound1(t, v.freqX, v.freqY, v.freqZ, v.freqW);
    if (ty === "joy") return sampleJoy(t, v.freqX, v.freqY, v.freqZ, v.freqW);
    if (ty === "malice") return sampleMalice(t, v.freqX, v.freqY, v.freqZ, v.freqW);
    if (ty === "electric") return sampleElectric(t, v.freqX, v.freqY, v.freqZ, v.freqW);
    if (ty === "numeris_pulse") return sampleNumerisPulse(t, v.freqX, v.freqY, v.freqZ, v.freqW);
    if (ty === "numeris_orbit") return sampleNumerisOrbit(t, v.freqX, v.freqY, v.freqZ, v.freqW);
    if (ty === "numeris_prism") return sampleNumerisPrism(t, v.freqX, v.freqY, v.freqZ, v.freqW);
    if (ty === "numeris_chime") return sampleNumerisChime(t, v.freqX, v.freqY, v.freqZ, v.freqW);
    return sampleTweet(t, v.freqX, v.freqY);
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
    echoQuietSamples = CONFIG_SR;
  }
  function echoIsLive() {
    /* Match bfx_echo_is_idle inverse: keep ~3 delay periods before treating as dead. */
    var need = ECHO_DELAY * 3;
    if (need < 4096) need = 4096;
    if (need > CONFIG_SR) need = CONFIG_SR;
    return echoQuietSamples < need;
  }
  function processEcho(out, frames) {
    /* Exact bfx defaults: dry=1-mix, wet=mix, feedback, integer delay read. */
    var delay = ECHO_DELAY;
    var dry = 1.0 - ECHO_MIX;
    var wet = ECHO_MIX;
    var fb = ECHO_FB;
    var cap = CONFIG_SR;
    var peak = 0, i, ri, inL, inR, wetL, wetR, outL, outR, p;
    for (i = 0; i < frames; i++) {
      ri = echoPos - delay;
      if (ri < 0) ri += cap;
      inL = out[i * 2];
      inR = out[i * 2 + 1];
      wetL = echoBuffer[ri * 2];
      wetR = echoBuffer[ri * 2 + 1];
      outL = fadd(fmul(dry, inL), fmul(wet, wetL));
      outR = fadd(fmul(dry, inR), fmul(wet, wetR));
      echoBuffer[echoPos * 2] = softClip(fadd(inL, fmul(wetL, fb)));
      echoBuffer[echoPos * 2 + 1] = softClip(fadd(inR, fmul(wetR, fb)));
      out[i * 2] = outL;
      out[i * 2 + 1] = outR;
      /* Peak includes delayed wet (bfx) so quiet tails keep the line awake. */
      p = Math.abs(wetL);
      if (Math.abs(wetR) > p) p = Math.abs(wetR);
      if (Math.abs(inL) > p) p = Math.abs(inL);
      if (Math.abs(inR) > p) p = Math.abs(inR);
      if (p > peak) peak = p;
      echoPos++;
      if (echoPos >= cap) echoPos = 0;
    }
    jsLastPeak = peak;
    if (peak < ECHO_QUIET_EPS) echoQuietSamples += frames;
    else echoQuietSamples = 0;
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
    /* Idle: no voices and echo line quiet â€” skip tweet + bfx walk (bfx idle). */
    if (voices.length === 0 && !echoIsLive()) {
      audioFrame += frames;
      echoQuietSamples += frames;
      if (echoQuietSamples > CONFIG_SR) echoQuietSamples = CONFIG_SR;
      jsLastPeak = 0;
      return new Float32Array(frames * 2);
    }
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
        sig = sampleVoice(v, t);
        g = fmul(fmul(fmul(sig, v.volume), env), master);
        /* Centre most SFX; slight pan via freqZ for non-tweet. */
        if (v.type === "tweet" || v.type === "tone") {
          out[i * 2] = fadd(out[i * 2], g);
          out[i * 2 + 1] = fadd(out[i * 2 + 1], g);
        } else {
          var pan = v.freqZ * 0.12;
          if (pan > 0.7) pan = 0.7;
          if (pan < -0.7) pan = -0.7;
          out[i * 2] = fadd(out[i * 2], fmul(g, fsub(1.0, fmul(pan, 0.75))));
          out[i * 2 + 1] = fadd(out[i * 2 + 1], fmul(g, fadd(1.0, fmul(pan, 0.75))));
        }
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
      /* Reuse one scratch arena â€” malloc/free per 1024-frame block was GC noise. */
      if (!wasm._spinPcmScratch || wasm._spinPcmScratchFrames < frames) {
        if (wasm._spinPcmScratch) {
          try { wasm._free(wasm._spinPcmScratch); } catch (eFree) {}
        }
        wasm._spinPcmScratch = wasm._malloc(bytes);
        wasm._spinPcmScratchFrames = frames;
      }
      ptr = wasm._spinPcmScratch;
      if (!ptr) return jsGenerateBlock(frames);
      wasm._sound_worker_generate_block(ptr, frames);
      var out = new Float32Array(frames * 2);
      out.set(wasm.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + frames * 2));
      return out;
    } catch (eGen) {
      console.warn("[SoundWorkerSsound] generate failed, JS fallback", eGen);
      /* Permanent soft-fallback for this session if GPU path is broken. */
      if (backend.indexOf("wasm-gpu") === 0) backend = "wasm";
      return jsGenerateBlock(frames);
    }
  }

  /* Linear cache avoids join/slice allocations on every 1024-frame refill.
   * Only the generated transferable block is allocated in the worker hot path. */
  var RESAMPLE_CAP = 32768;
  var resampleSamples = new Float32Array(RESAMPLE_CAP * 2);
  var resampleHead = 0;
  var resampleFrames = 0;
  var resamplePos = 0.0;
  var outScratch = null;
  var outScratchFrames = 0;

  function acquireOutScratch(frames) {
    if (!outScratch || outScratchFrames < frames) {
      outScratch = new Float32Array(frames * 2);
      outScratchFrames = frames;
    }
    return outScratch;
  }

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
    if (outputRate === SR && resampleFrames === 0) {
      /* Copy into scratch so caller can transfer a pooled buffer without
       * relying on a fresh alloc from generateSourceBlock. */
      var src = generateSourceBlock(frames);
      var dstId = acquireOutScratch(frames);
      dstId.set(src);
      return dstId.subarray(0, frames * 2);
    }

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
    /* Retain one source frame before the next interpolation position. */
    drop = Math.floor(resamplePos) - 1;
    if (drop > 0) {
      resampleHead += drop;
      resampleFrames -= drop;
      resamplePos -= drop;
    }
    return out.subarray(0, frames * 2);
  }

  var loadError = "";

  var preferCpu = false;

  function tryLoadWasm() {
    loadError = "";
    try {
      if (typeof importScripts === "function") {
        var loaded = false;
        var names = [
          "SoundWorker.js?v=andr27",
          "./SoundWorker.js?v=andr27",
          "App.js?v=andr27",
          "./App.js?v=andr27"
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
      /* importScripts puts `var createSoundWorkerModule` on the worker global â€” not only root. */
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

      /* Sokol/emscripten may touch document during GL setup â€” stub it in workers. */
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
            u.searchParams.set("v", "andr27");
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
    /* preferCpu: JS tweet synth is the production path â€” do not block
     * synthReady on SoundWorker.wasm (can take seconds on mobile). */
    if (preferCpu) {
      backend = "js";
      loadPromise = Promise.resolve("js");
      return loadPromise;
    }
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
      desc = desc || {};
      var ty = desc.soundType || "tweet";
      /* WASM path only knows tweet/tone — Numeris SFX stay on JS synth. */
      if (ty !== "tweet" && ty !== "tone") return jsPlay(desc);
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
    echoLive: function () {
      if (backend.indexOf("wasm") === 0 && wasm && wasm._sound_worker_last_peak) {
        /* WASM bfx keeps ringing below voice peak; treat small peaks as live echo. */
        return +wasm._sound_worker_last_peak() > 1e-5;
      }
      return echoIsLive();
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
    setConfigRate: applyConfigRate,
    getConfigRate: function () { return CONFIG_SR; },
    getSynthesisRate: function () { return SR; },
    getOutputRate: function () { return outputRate; }
  };
})(typeof self !== "undefined" ? self : this);

/* ---- worker PCM pump ---- */
(function () {
  "use strict";

  /* SoundWorkerSsound inlined above */
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
  var targetFrames = 2048;
  var needFrames = 1024;
  var sampleRate = 44100;
  var toneHz = 440;
  var toneGain = 0.12;
  var phase = 0;
  var queuedEstimate = 0;
  var queuedWallMs = 0; /* performance.now() when queuedEstimate was last truth from sink */
  var pcmBlocksSent = 0;
  var filling = false;
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
  /* Reusable transferable PCM buffers â€” fresh alloc every block caused GC pauses
   * on the worker â†’ FIFO underruns â†’ random crackle even on HTTPS worklet. */
  var pcmPool = [];
  var pcmPoolBytes = 0;

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
      queued_est: estimatedQueued(),
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

  /* GPU work only â€” timing excludes async delay. Busy mode spins here. */
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

  function noteQueued(frames) {
    queuedEstimate = frames > 0 ? frames | 0 : 0;
    queuedWallMs = performance.now();
  }

  /* When the sink is starved (Android ScriptProcessor on a busy GL thread),
   * `need` messages stop arriving and queuedEstimate freezes HIGH â†’ underruns.
   * Subtract estimated device consumption since the last real report. */
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
    /* Proto timing GL is only for non-CPU experiments. Production preferCpu
     * has gl===null â€” skip the backend string check every block. */
    if (!preferCpu) {
      var be =
        typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.getBackend
          ? SoundWorkerSsound.getBackend()
          : "";
      if (be.indexOf("wasm-gpu") !== 0) gpuTick();
    }
    var frames = blockFrames;
    var bytes = frames * 2 * 4;
    var synthT0 = performance.now();
    var samples = makeToneBlock(frames);
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
    /* Advance local estimate from last known truth + this push. */
    queuedEstimate = estimatedQueued() + frames;
    queuedWallMs = performance.now();
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

  /* Audio is realtime â€” fill the FIFO synchronously on every `need` (no timers). */
  function fillToTarget(target) {
    if (!audioPort || !running || !synthReady) return;
    var want = target > 0 ? target : targetFrames;
    var guard = 0;
    var fillT0 = performance.now();
    /* Allow short interactive cushions (desktop ~2048); don't force 2048 floor. */
    if (want < 1024) want = 1024;
    while (running && audioPort && estimatedQueued() < want && guard < 64) {
      sendPcmBlock();
      guard++;
    }
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

  /* Advance synth clocks before the device sink exists so bounce instruments
   * are already mid-envelope when unlock fade-in begins. */
  function scheduleSilentPump() {
    clearSilentPump();
    if (!running || audioPort || !synthReady) return;
    silentPumpTimer = setTimeout(function () {
      silentPumpTimer = 0;
      if (!running || audioPort || !synthReady) return;
      try {
        if (typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.generateBlock)
          SoundWorkerSsound.generateBlock(blockFrames, sampleRate);
      } catch (eSilent) {}
      var live =
        typeof SoundWorkerSsound !== "undefined" &&
        ((SoundWorkerSsound.liveVoices && SoundWorkerSsound.liveVoices() > 0) ||
          (SoundWorkerSsound.echoLive && SoundWorkerSsound.echoLive()));
      if (live) scheduleSilentPump();
    }, tickDelayMs > 0 ? tickDelayMs : 16);
  }

  /* Keep topping up. Healthy FIFO still wakes often enough that a hitch cannot
   * drain past need before the next fill (40ms was too sleepy â†’ random ur). */
  function scheduleAudioPump() {
    clearAudioPump();
    if (!running || !audioPort) return;
    var q = estimatedQueued();
    var delay = q >= targetFrames ? 16 : q >= needFrames ? 8 : 4;
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
      noteQueued(msg.queuedFrames | 0);
      if (msg.needFrames > 0) needFrames = msg.needFrames | 0;
      if (msg.targetFrames > 0) targetFrames = msg.targetFrames | 0;
      if (targetFrames < 1024) targetFrames = 1024;
      if (needFrames < 512) needFrames = 512;
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
    if (synthReady) {
      /* Prime only to target — avoid force-pushing 8k frames of silence ahead. */
      fillToTarget(targetFrames);
    }
    scheduleAudioPump();
    postMessage({ type: "audio-attached", blockFrames: blockFrames, targetFrames: targetFrames });
  }

  function playSound(msg) {
    /* Latency = queuedFrames/sampleRate until a new voice's PCM reaches the sink.
     * Idle + deep FIFO: flush stale silence (worklet/script have soft xfade).
     * Always force-push at least one block so the attack isn't stuck waiting for
     * the sink to drain below needFrames before the next fill. */
    var hadAudio =
      SoundWorkerSsound.liveVoices() > 0 ||
      (SoundWorkerSsound.lastPeak && SoundWorkerSsound.lastPeak() > 1e-5) ||
      (SoundWorkerSsound.echoLive && SoundWorkerSsound.echoLive());
    var q = estimatedQueued();
    var deepIdle = !hadAudio && q > (needFrames > 0 ? needFrames : 1024);
    if (deepIdle && audioPort) {
      audioPort.postMessage({ type: "flush" });
      noteQueued(0);
      if (SoundWorkerSsound.resetOutput) SoundWorkerSsound.resetOutput();
    } else if (!hadAudio && SoundWorkerSsound.resetOutput) {
      SoundWorkerSsound.resetOutput();
    }
    var id = SoundWorkerSsound.play(msg);
    postMessage({ type: "played", id: id, voices: SoundWorkerSsound.liveVoices() });
    if (!audioPort) {
      scheduleSilentPump();
      return;
    }
    forcePushBlocks(hadAudio ? 1 : 2);
    scheduleAudioPump();
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
        targetFrames = msg.targetFrames > 0 ? msg.targetFrames | 0 : 2048;
        needFrames = msg.needFrames > 0 ? msg.needFrames | 0 : 1024;
        if (msg.synthRate > 0 &&
            typeof SoundWorkerSsound !== "undefined" &&
            SoundWorkerSsound.setConfigRate)
          SoundWorkerSsound.setConfigRate(msg.synthRate | 0);
        sampleRate = msg.sampleRate > 0 ? +msg.sampleRate : (
          typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.getConfigRate
            ? SoundWorkerSsound.getConfigRate() : 44100);
        toneHz = msg.toneHz > 0 ? +msg.toneHz : 440;
        preferCpu = msg.preferCpu !== false; /* default CPU â€” avoids GPU contention with scene */
        synthReady = false;
        pendingPlays.length = 0;
        if (targetFrames < 1024) targetFrames = 1024;
        if (needFrames < 512) needFrames = 512;
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
          /* Prefer native device rate for synth too â†’ skip resample path. */
          if (typeof SoundWorkerSsound !== "undefined") {
            if (SoundWorkerSsound.setConfigRate)
              SoundWorkerSsound.setConfigRate(sampleRate);
            if (SoundWorkerSsound.setSampleRate)
              SoundWorkerSsound.setSampleRate(sampleRate);
          }
        }
        if (msg.synthRate > 0 &&
            typeof SoundWorkerSsound !== "undefined" &&
            SoundWorkerSsound.setConfigRate &&
            !(msg.sampleRate > 0))
          SoundWorkerSsound.setConfigRate(msg.synthRate | 0);
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
          noteQueued(0);
          audioPort.postMessage({ type: "flush" });
          if (synthReady) forcePushBlocks(4);
        }
        postMessage({ type: "stopped_all" });
        return;
      }
      if (type === "shutdown_soft") {
        /* Window close: stop synth + pump but never hard-flush the worklet
         * FIFO — the bus master fade handles audibility. */
        pendingPlays.length = 0;
        running = false;
        clearAudioPump();
        if (typeof SoundWorkerSsound !== "undefined") SoundWorkerSsound.stopAll();
        postMessage({ type: "shutdown_soft" });
        return;
      }
      if (type === "resume_soft") {
        /* Tab/app return after background pause — restart pump, keep graph. */
        if (!running) running = true;
        if (synthReady && audioPort) {
          scheduleAudioPump();
          fillToTarget(needFrames > 0 ? needFrames : 768);
        }
        postMessage({ type: "resume_soft" });
        return;
      }
      if (type === "trim_latency") {
        /* Drop FIFO silence backlog after unlock / visibility resume.
         * Soft: only when deep, then pad with ~14 ms silence + mild refill so
         * the unlock fade-in does not start on a hard sample jump. */
        var soft = !!msg.soft;
        var q = estimatedQueued();
        var deep = (targetFrames > 0 ? targetFrames : 2048) * 1.35;
        if (deep < 1536) deep = 1536;
        if (soft && q <= deep) {
          /* Queue already short — skip flush (avoids first-tap click). */
          return;
        }
        noteQueued(0);
        if (audioPort) {
          audioPort.postMessage({ type: "flush" });
          var pad = Math.max(256, ((sampleRate > 0 ? sampleRate : 48000) * 0.014) | 0);
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
