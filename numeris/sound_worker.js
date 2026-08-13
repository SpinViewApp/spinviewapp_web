/* sound_worker.js — synth + PCM pump (SoundWorkerSsound inlined) — single file for blobconef audio.
 * Cache: shaderparity1
 */
/* Proto 3 â€” SoundWorkerSsound: WASM tweet synth with JS fallback.
 * Tries createSoundWorkerModule (App.js) first; else CPU JS port of tweet.sound.
 */
(function (root) {
  "use strict";

  /* Engine clock = SSOUND_SAMPLE_RATE from C (-D). Device may differ:
   * synthesize on the config grid, then resample out if needed. */
  var CONFIG_SR = 48000; /* SSOUND_SAMPLE_RATE; init overrides from C */
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
  /* Numeris defaults, kept in sync with g_numeris_echo_* / Rc/defaults/app.json. */
  var ECHO_DELAY_MS = 80.0;
  var ECHO_DELAY = (CONFIG_SR * ECHO_DELAY_MS * 0.001) | 0;
  var ECHO_MIX = 0.3;
  var ECHO_FB = 0.4;
  var ECHO_QUIET_EPS = 1.0e-4;

  function applyEchoSettings(delayMs, feedback, mix) {
    var d;
    if (delayMs > 0) {
      ECHO_DELAY_MS = delayMs < 1 ? 1 : delayMs > 1000 ? 1000 : delayMs;
      d = (CONFIG_SR * ECHO_DELAY_MS * 0.001) | 0;
      if (d < 1) d = 1;
      if (d > CONFIG_SR - 2) d = CONFIG_SR - 2;
      if (d !== ECHO_DELAY) {
        ECHO_DELAY = d;
        /* Delay length changed: the old tail no longer lines up. */
        echoBuffer.fill(0);
        echoPos = 0;
      }
    }
    if (feedback >= 0) ECHO_FB = feedback > 0.98 ? 0.98 : feedback;
    if (mix >= 0) ECHO_MIX = mix > 1 ? 1 : mix;
    echoQuietSamples = 0;
    /* The GPU module runs its own bfx echo on the mix — keep both in step so
     * a mid-session fallback to JS does not change the tail. */
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
    ECHO_DELAY = (CONFIG_SR * ECHO_DELAY_MS * 0.001) | 0;
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

  /* ---- 1:1 transcriptions of soundsys/sound/*.sound ----
   * These used to be loose approximations, which is why Web and desktop did
   * not sound alike: the mirrors dropped the per-voice clamp the shaders apply
   * on their render target, used one shared soft knee instead of the three
   * distinct softclips, panned with a linear law instead of the equal-power
   * normalize(), and omitted whole partials. Every instrument now follows its
   * shader line for line, writes stereo (the shaders pan internally) and ends
   * on the same clamp. Keep them in sync with the .sound files.
   */
  var voiceL = 0.0;
  var voiceR = 0.0;
  var panL = 0.70710678;
  var panR = 0.70710678;

  function clampf(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function clamp1(x) { return x < -1 ? -1 : x > 1 ? 1 : x; }
  /* pan_simple / numeris_pan: normalize(vec2(1-p, 1+p)) — 0.707 at centre. */
  function panNormalize(pos) {
    var e0 = 1.0 - pos;
    var e1 = 1.0 + pos;
    var len = Math.sqrt(e0 * e0 + e1 * e1);
    if (len < 1e-8) { panL = 0.70710678; panR = 0.70710678; return; }
    panL = e0 / len;
    panR = e1 / len;
  }
  /* The shaders use three different soft knees: x/(1+|x|) in joy and the
   * numeris_* set, x/(1+1.4|x|) in malice, x/(1+1.35|x|) in electric. */
  function scDiv(x, k) { return x / (1.0 + Math.abs(x) * k); }
  /* GLSL Noise1 returns 0..1; the worker's Noise() is the tweet variant that
   * subtracts 0.5, so malice and electric need this one. */
  function Noise1(n) {
    var f = fract32(n);
    n = Math.floor(F32(n));
    f = f * f * (3.0 - 2.0 * f);
    return mix32(Hash1(n), Hash1(n + 1), f);
  }
  function NoiseSigned(n) { return Noise1(n) * 2.0 - 1.0; }

  function sinPluck(f, t) {
    return Math.sin(PI2 * f * t) * Math.exp(-8.0 * t) * smoothstep32(0.0, 0.002, t);
  }
  function voiceSound1(t, freqX, freqY, freqZ, freqW) {
    var hz = 110.0 * Math.max(freqX, 0.25);
    var harm = 1.0 + clampf(freqW, 0.0, 4.0) * 0.25;
    var gain = 6.0 + Math.abs(freqY) * 2.0;
    var pan = clampf(freqZ * 0.15, -1.0, 1.0);
    var a = sinPluck(hz, t) * gain;
    var b = sinPluck(hz * harm * 2.0, t) * (gain * 0.35);
    var l, r;
    panNormalize(pan);
    l = a * panL;
    r = a * panR;
    /* The second partial sits at half the pan offset — a touch of width. */
    panNormalize(pan * 0.5);
    voiceL = clamp1(l + b * panL);
    voiceR = clamp1(r + b * panR);
  }
  function joyHop(hz, t, decay, bright) {
    var env = Math.exp(-decay * t) * smoothstep32(0.0, 0.0035, t);
    var body = Math.sin(PI2 * hz * t);
    var ping = Math.sin(PI2 * hz * (2.0 + bright * 0.35) * t) * 0.32;
    var air = Math.sin(PI2 * hz * (3.0 + bright) * t) * 0.12
      * Math.exp(-decay * 1.4 * t);
    return scDiv((body + ping + air) * env * 2.4, 1.0);
  }
  function voiceJoy(t, freqX, freqY, freqZ, freqW) {
    var pitch = Math.max(freqX, 0.35);
    var sparkle = clampf(freqY, 0.0, 4.0);
    var pan = clampf(freqZ * 0.22, -1.0, 1.0);
    var bounce = clampf(freqW, 0.0, 4.0);
    var hz = 246.0 * pitch;
    var mono = joyHop(hz, t, 10.0, sparkle);
    mono += joyHop(hz * 1.125, Math.max(t - 0.042, 0.0), 11.0, sparkle) * 0.88;
    mono += joyHop(hz * 1.25, Math.max(t - 0.084, 0.0), 11.5, sparkle) * 0.78;
    mono += joyHop(hz * 1.5, Math.max(t - 0.130, 0.0), 10.5, sparkle) * 0.92;
    if (bounce > 0.6) {
      mono += joyHop(hz * 1.5, Math.max(t - 0.195, 0.0), 12.0, sparkle) * 0.55 * bounce;
      mono += joyHop(hz * 2.0, Math.max(t - 0.250, 0.0), 9.5, sparkle) * 0.70
        * clampf(bounce, 0.0, 2.0);
    }
    /* Confetti shimmer. */
    mono += Math.sin(PI2 * hz * (4.0 + sparkle * 0.8) * t)
      * Math.exp(-16.0 * t) * smoothstep32(0.0, 0.002, t)
      * (0.12 + sparkle * 0.06);
    mono = scDiv(mono * (3.8 + sparkle * 0.35), 1.0);
    panNormalize(pan);
    voiceL = clamp1(mono * panL);
    voiceR = clamp1(mono * panR);
  }
  function voiceMalice(t, freqX, freqY, freqZ, freqW) {
    var growl = clampf(freqX, 0.3, 4.0);
    var rasp = clampf(freqY, 0.0, 5.0);
    var pan = clampf(freqZ * 0.25, -1.0, 1.0);
    var bite = clampf(freqW, 0.0, 4.0);
    var hit = smoothstep32(0.0, 0.008, t) * (1.0 - smoothstep32(0.12, 0.28, t));
    var f0 = 55.0 + growl * 28.0;
    var f1 = f0 * 1.41; /* tritone-ish dissonance */
    var f2 = f0 * 1.89;
    /* Each partial is driven into its own soft knee — that grit is the sound. */
    var body = scDiv(Math.sin(PI2 * f0 * t) * 2.4, 1.4);
    body += scDiv(Math.sin(PI2 * f1 * t + 0.7) * 1.8, 1.4) * 0.7;
    body += scDiv(Math.sin(PI2 * f2 * t + 1.3) * 1.2, 1.4) * 0.45;
    var grit = (Noise1(t * (900.0 + rasp * 400.0)) * 2.0 - 1.0)
      * Math.exp(-t * (10.0 + bite * 4.0)) * (0.35 + rasp * 0.15);
    var mono = (body * hit + grit) * (3.0 + bite * 0.4);
    voiceL = clamp1(mono * (1.0 - pan * 0.7));
    voiceR = clamp1(mono * (1.0 + pan * 0.7));
  }
  /* electric reads slot0 too: its length follows the host duration and it
   * folds the host volume in as gain_env (so volume is applied twice, once
   * here and once in the envelope wrapper — that is what the shader does). */
  function voiceElectric(t, v) {
    var tone = clampf(v.freqX, 0.25, 3.0);
    var rate = clampf(v.freqY, 0.5, 24.0);
    var arc = clampf(v.freqZ, 0.0, 3.0);
    var settle = clampf(v.freqW, 0.0, 1.0);
    var gainEnv = Math.max(v.volume, 0.05);
    var dur = clampf(v.duration, 0.05, 8.0);
    /* in_instance_id is a GPU slot index with no Web equivalent; the voice id
     * gives the same spread of seeds. */
    var seed = fract32(v.id * 0.19 + tone * 0.07);
    var hitLen = Math.max(dur * mix32(1.0, 0.35, settle), 0.04);
    var hitEnv = smoothstep32(0.0, Math.min(0.012, hitLen * 0.15), t)
      * (1.0 - smoothstep32(hitLen * 0.65, hitLen, t));
    if (t > hitLen || hitEnv <= 0.0001) { voiceL = 0; voiceR = 0; return; }

    var flutter = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(PI2 * rate * t + seed * 6.28));
    flutter *= 0.88 + 0.12 * Noise1(t * (rate * 0.7) + seed * 4.0);
    flutter = mix32(1.0, flutter, 0.55);

    var bright = clampf((tone - 0.25) / 2.75, 0.0, 1.0);
    var fLo = 55.0 + tone * 40.0;
    var fHi = 400.0 + tone * tone * 2800.0;
    var grow = scDiv(Math.sin(PI2 * fLo * t) * 2.6, 1.35);
    grow += scDiv(Math.sin(PI2 * fLo * 2.05 * t) * 1.9, 1.35) * 0.4;
    var bolt = scDiv(Math.sin(PI2 * fHi * t) * 2.0, 1.35);
    bolt += scDiv(Math.sin(PI2 * fHi * 1.37 * t + 0.7) * 1.6, 1.35) * 0.3;
    var body = mix32(grow, bolt, bright * bright) * flutter;

    var zapRate = 6.0 + arc * 40.0;
    var fire = smoothstep32(0.78 - arc * 0.05, 0.92, Noise1(t * zapRate + seed * 11.0));
    var zapEnv = Math.exp(-fract32(t * zapRate) * (28.0 + arc * 22.0)) * fire * flutter;
    var zapF = mix32(800.0, 3800.0, bright) + arc * 500.0;
    var zap = Math.sin(PI2 * zapF * t)
      * scDiv(NoiseSigned(t * 9000.0) * 2.0, 1.35) * zapEnv;

    var bloom = Math.exp(-fract32(t * rate * 0.5 + seed) * 12.0)
      * (0.15 + arc * 0.25) * flutter;
    var crack = scDiv(NoiseSigned(t * 11000.0) * 1.8, 1.35)
      * Math.sin(PI2 * mix32(900.0, 3200.0, bright) * t) * bloom;

    var wBody = 1.0 - clampf(arc / 3.0, 0.0, 1.0) * 0.55;
    var wZap = 0.2 + clampf(arc / 3.0, 0.0, 1.0) * 0.95;
    var mono = (body * wBody + zap * wZap + crack) * hitEnv * gainEnv * 3.2;

    var pan = clampf((seed - 0.5) * 0.85, -0.65, 0.65);
    voiceL = clamp1(mono * (1.0 - pan * 0.75));
    voiceR = clamp1(mono * (1.0 + pan * 0.75));
  }

  /* CPU mirrors for the four Numeris GPU instruments.  They deliberately use
   * the same slot1 contract as the .sound shaders so native and Web keep the
   * same musical roles even when WebGL audio runs through this worker. */
  function voiceNumerisPulse(t, freqX, freqY, freqZ, freqW) {
    var ratio = freqX < 0.25 ? 0.25 : freqX > 8 ? 8 : freqX;
    var warmth = freqY < 0 ? 0 : freqY > 1 ? 1 : freqY;
    var click = freqW < 0 ? 0 : freqW > 1 ? 1 : freqW;
    var pan = clampf(freqZ, -1.0, 1.0) * 0.55;
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
    var mono = scDiv(body * env * 1.45, 1.0);
    panNormalize(pan);
    voiceL = clamp1(mono * panL);
    voiceR = clamp1(mono * panR);
  }

  function voiceNumerisOrbit(t, freqX, freqY, freqZ, freqW, id) {
    var ratio = freqX < 0.25 ? 0.25 : freqX > 8 ? 8 : freqX;
    var bright = freqY < 0 ? 0 : freqY > 1 ? 1 : freqY;
    var character = freqW < 0 ? 0 : freqW > 1 ? 1 : freqW;
    var pan = clampf(freqZ, -1.0, 1.0) * 0.65;
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
    var mono = scDiv((carrier + halo + sub) * env * 1.55, 1.0);
    var drift = Math.sin(PI2 * 0.23 * t + id * 0.17) * 0.08 * character;
    panNormalize(pan + drift);
    voiceL = clamp1(mono * panL);
    voiceR = clamp1(mono * panR);
  }

  function voiceNumerisPrism(t, freqX, freqY, freqZ, freqW) {
    var ratio = freqX < 0.25 ? 0.25 : freqX > 8 ? 8 : freqX;
    var bright = freqY < 0 ? 0 : freqY > 1 ? 1 : freqY;
    var glass = freqW < 0 ? 0 : freqW > 1 ? 1 : freqW;
    var pan = clampf(freqZ, -1.0, 1.0) * 0.72;
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
    mono = scDiv(mono * 1.65, 1.0);
    var shimmer = Math.sin(PI2 * 0.31 * t) * 0.06 * glass;
    panNormalize(pan + shimmer);
    voiceL = clamp1(mono * panL);
    voiceR = clamp1(mono * panR);
  }

  function numerisChimeNote(hz, age, bright) {
    if (age < 0) return 0;
    var env = smoothstep32(0.0, 0.0025, age)
      * Math.exp(-age * (5.6 + bright * 1.8));
    var value = Math.sin(PI2 * hz * age);
    value += Math.sin(PI2 * hz * 2.003 * age + 0.3) * (0.22 + bright * 0.18);
    value += Math.sin(PI2 * hz * 3.997 * age + 0.9) * bright * 0.10;
    return value * env;
  }

  function voiceNumerisChime(t, freqX, freqY, freqZ, freqW) {
    var ratio = freqX < 0.25 ? 0.25 : freqX > 8 ? 8 : freqX;
    var bright = freqY < 0 ? 0 : freqY > 1 ? 1 : freqY;
    var shape = freqW < 0 ? 0 : freqW > 1 ? 1 : freqW;
    var pan = clampf(freqZ, -1.0, 1.0) * 0.55;
    var hz = 220.0 * ratio;
    var r1 = 1.125 + (1.20 - 1.125) * shape;
    var r2 = 1.25 + (1.3333333 - 1.25) * shape;
    var r3 = 1.50 + (1.60 - 1.50) * shape;
    var mono = numerisChimeNote(hz, t, bright);
    mono += numerisChimeNote(hz * r1, t - 0.060, bright) * 0.82;
    mono += numerisChimeNote(hz * r2, t - 0.122, bright) * 0.76;
    mono += numerisChimeNote(hz * r3, t - 0.190, bright) * 0.92;
    mono = scDiv(mono * 1.45, 1.0);
    var motion = Math.sin(PI2 * 0.7 * t) * 0.14;
    panNormalize(pan + motion);
    voiceL = clamp1(mono * panL);
    voiceR = clamp1(mono * panR);
  }

  /* Writes the voice's stereo pair into voiceL / voiceR. The shaders pan and
   * clamp internally, so the caller must not add a pan of its own. */
  function sampleVoiceStereo(v, t) {
    var ty = v.type || "tweet";
    var mono;
    if (ty === "sound1") { voiceSound1(t, v.freqX, v.freqY, v.freqZ, v.freqW); return; }
    if (ty === "joy") { voiceJoy(t, v.freqX, v.freqY, v.freqZ, v.freqW); return; }
    if (ty === "malice") { voiceMalice(t, v.freqX, v.freqY, v.freqZ, v.freqW); return; }
    if (ty === "electric") { voiceElectric(t, v); return; }
    if (ty === "numeris_pulse") { voiceNumerisPulse(t, v.freqX, v.freqY, v.freqZ, v.freqW); return; }
    if (ty === "numeris_orbit") { voiceNumerisOrbit(t, v.freqX, v.freqY, v.freqZ, v.freqW, v.id); return; }
    if (ty === "numeris_prism") { voiceNumerisPrism(t, v.freqX, v.freqY, v.freqZ, v.freqW); return; }
    if (ty === "numeris_chime") { voiceNumerisChime(t, v.freqX, v.freqY, v.freqZ, v.freqW); return; }
    /* tone and tweet are mono in the shader and carry no pan. */
    if (ty === "tone") mono = fmul(fsin(fmul(fmul(PI2, v.freqX > 20 ? v.freqX : 440), t)), 0.15);
    else mono = sampleTweet(t, v.freqX, v.freqY);
    voiceL = mono;
    voiceR = mono;
  }
  function softClip(x) {
    x = F32(x);
    if (x > -1 && x < 1) return x;
    var a = x < 0 ? F32(-x) : x;
    return x > 0
      ? fadd(1, fmul(0.2, fsub(a, 1)))
      : fsub(-1, fmul(0.2, fsub(a, 1)));
  }
  /* ---- master bus: 1:1 port of soundsys/bfx.h + ssound.h ----
   * Desktop runs voices -> echo -> bfx_bus_normalize -> master fader. The Web
   * worker had neither stage, which is why it sounded thinner than desktop and
   * hard-clipped when several SFX overlapped. Same constants, same order. */
  var NORM_ENABLED = 1;
  var NORM_TARGET = 0.85;
  /* Duck only. Boosting made the gain chase 1/peak with the 500 ms release,
   * so it climbed all through a note (measured 1.06 -> 2.34 on one chime) and
   * inflated the decay instead of letting it die. Mirrors bfx.h. */
  var NORM_MAX_BOOST = 1.0;
  var NORM_FLOOR = 0.02;
  var NORM_ATTACK_MS = 50.0;
  var NORM_RELEASE_MS = 500.0;
  var NORM_ENV_MS = 400.0;
  var busGain = 1.0;
  var busPeakEnv = 0.0;
  /* ssound_master_volume_smooth: starts at 0 so the very first block ramps. */
  var MASTER_EASE_SPEED = 8.0;
  var masterSmooth = 0.0;

  /* Pass out=null to advance the envelope/gain state over a silent block —
   * desktop still runs both stages while idle, so the recovery must match. */
  function busNormalize(out, frames) {
    var peak = 0.0;
    var sr = CONFIG_SR > 1 ? CONFIG_SR : 48000;
    var attackS = NORM_ATTACK_MS * 0.001;
    var releaseS = NORM_RELEASE_MS * 0.001;
    var envS = NORM_ENV_MS * 0.001;
    var i, ax, ay, desired, g, envFall, gainFast, gainSlow;
    if (frames <= 0) return;
    if (out) {
      for (i = 0; i < frames; i++) {
        ax = out[i * 2];
        ay = out[i * 2 + 1];
        if (ax < 0) ax = -ax;
        if (ay < 0) ay = -ay;
        if (ax > peak) peak = ax;
        if (ay > peak) peak = ay;
      }
    }
    if (peak >= busPeakEnv) busPeakEnv = peak;
    else {
      envFall = 1.0 - Math.exp(-frames / (envS * sr));
      busPeakEnv += (peak - busPeakEnv) * envFall;
    }
    if (!NORM_ENABLED) {
      busGain = 1.0;
      return;
    }
    if (busPeakEnv < NORM_FLOOR) desired = 1.0; /* noise floor — don't amplify */
    else {
      desired = NORM_TARGET / busPeakEnv;
      if (desired > NORM_MAX_BOOST) desired = NORM_MAX_BOOST;
      if (desired * busPeakEnv > 1.0) desired = 1.0 / busPeakEnv;
    }
    gainFast = 1.0 - Math.exp(-frames / (attackS * sr));
    gainSlow = 1.0 - Math.exp(-frames / (releaseS * sr));
    if (desired < busGain) busGain += (desired - busGain) * gainFast;
    else busGain += (desired - busGain) * gainSlow;
    g = busGain;
    if (!out || (g > 0.999 && g < 1.001)) return;
    for (i = 0; i < frames * 2; i++) out[i] = F32(out[i] * g);
  }

  function applyMasterVolume(out, frames) {
    var sr = CONFIG_SR > 1 ? CONFIG_SR : 48000;
    var dt = frames / sr;
    var t = 1.0 - Math.exp(-MASTER_EASE_SPEED * dt);
    var g, i;
    if (frames <= 0) return;
    masterSmooth += (master - masterSmooth) * t;
    if (Math.abs(masterSmooth - master) < 1.0e-5) masterSmooth = master;
    g = masterSmooth;
    if (!out || (g > 0.9999 && g < 1.0001)) return;
    for (i = 0; i < frames * 2; i++) out[i] = F32(out[i] * g);
  }

  /* True-peak ceiling. Bit-identical to desktop below -0.45 dBFS; above that it
   * curves to 1.0 instead of letting the device hard-clip (audible crackle). */
  function busCeiling(out, frames) {
    var n = frames * 2;
    var i, x, a, over, y;
    for (i = 0; i < n; i++) {
      x = out[i];
      a = x < 0 ? -x : x;
      if (a <= 0.95) continue;
      over = a - 0.95;
      y = 0.95 + 0.05 * (over / (over + 0.05));
      out[i] = x < 0 ? -y : y;
    }
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
  /* One reusable source block. A fresh Float32Array per refill was ~170 KB/s of
   * worker garbage; the resulting GC pauses starved the FIFO (random crackle). */
  var srcScratch = null;
  var srcScratchFrames = 0;
  var srcView = null;
  var srcViewFrames = 0;
  function acquireSrcScratch(frames) {
    if (!srcScratch || srcScratchFrames < frames) {
      srcScratch = new Float32Array(frames * 2);
      srcScratchFrames = frames;
      srcView = null;
    }
    if (!srcView || srcViewFrames !== frames) {
      srcView = srcScratch.subarray(0, frames * 2);
      srcViewFrames = frames;
    }
    return srcView;
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
      var quiet = acquireSrcScratch(frames);
      quiet.fill(0);
      /* Silence still advances the bus envelope and the master ease, exactly
       * like desktop — otherwise the gain would be frozen at the next attack. */
      busNormalize(null, frames);
      applyMasterVolume(null, frames);
      return quiet;
    }
    var out = acquireSrcScratch(frames);
    out.fill(0);
    var i, vi, v, t, env, gain;
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
        /* Same order as sbase.ginc: signal * volume * envelop * fadeInFactor.
         * No master here — it is a post-normalizer fader, as on desktop. */
        sampleVoiceStereo(v, t);
        gain = fmul(v.volume, env);
        out[i * 2] = fadd(out[i * 2], fmul(voiceL, gain));
        out[i * 2 + 1] = fadd(out[i * 2 + 1], fmul(voiceR, gain));
      }
    }
    voices = still;
    audioFrame += frames;
    processEcho(out, frames);
    busNormalize(out, frames);
    applyMasterVolume(out, frames);
    busCeiling(out, frames);
    return out;
  }

  /* name → ssound pipeline index, read once from the module so no string
   * crosses the WASM boundary on the play path. */
  var gpuVariants = null;

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

  function fallbackToJs(reason) {
    if (backend === "js") return;
    console.warn("[SoundWorkerSsound] " + reason + " — switching to JS synth");
    loadError = reason;
    backend = "js";
    wasm = null;
    gpuVariants = null;
  }

  function wasmPlay(desc) {
    desc = desc || {};
    var variant = gpuVariantIndex(desc.soundType);
    if (variant < 0) return jsPlay(desc);
    var vol = desc.volume >= 0 ? +desc.volume : 0.6;
    var dur = desc.duration > 0 ? +desc.duration : 0.35;
    var fadein = Math.max(0, desc.fadein >= 0 ? +desc.fadein : 0.0000006);
    var envelop = desc.envelop >= 0 ? +desc.envelop : 8.0;
    var fx = desc.freqX != null ? +desc.freqX : 2.0;
    var fy = desc.freqY != null ? +desc.freqY : 4.0;
    var fz = desc.freqZ != null ? +desc.freqZ : 0.0;
    var fw = desc.freqW != null ? +desc.freqW : 1.0;
    var toff = desc.timeOffset != null ? +desc.timeOffset : 0.0;
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
      var out = acquireSrcScratch(frames);
      out.set(wasm.HEAPF32.subarray(ptr >> 2, (ptr >> 2) + frames * 2));
      return out;
    } catch (eGen) {
      console.warn("[SoundWorkerSsound] generate failed", eGen);
      fallbackToJs("wasm generate threw");
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
    /* Identity rate: hand the pooled source block straight back — the pump
     * copies it into the transferable, so no intermediate buffer is needed. */
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
        /* Never probe App.js here: next to Numeris that name is the scene
         * module, and importing it into the audio worker would boot the game. */
        var names = [
          "SoundWorker.js?v=gpu1",
          "./SoundWorker.js?v=gpu1"
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
            u.searchParams.set("v", "gpu1");
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
          /* v20 is the Numeris GPU worker: full .soundlist, play-by-variant,
           * no CPU synth inside the module. Older builds only knew tweet, so
           * refuse them and keep the JS transcription instead. */
          try {
            if (
              typeof wasm._sound_worker_version !== "function" ||
              (wasm._sound_worker_version() | 0) < 20
            ) {
              loadError = "SoundWorker.wasm predates the Numeris GPU worker (v20); using JS worker";
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
            console.warn("[SoundWorkerSsound] init error", eInit);
          }
          /* The module is GPU-only. Without a working WebGL2 context there is
           * nothing to synthesise with, so hand the session back to JS. */
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
              loadError = "gpu init failed code=" + code + "; using JS worker";
              wasm = null;
              backend = "js";
              return false;
            }
          } catch (eGpu) {
            loadError = "gpu: " + (eGpu && eGpu.message ? eGpu.message : eGpu);
            console.warn("[SoundWorkerSsound] gpu init error; using JS worker", eGpu);
            wasm = null;
            backend = "js";
            return false;
          }
          buildGpuVariantMap();
          if (!gpuVariants) {
            loadError = "gpu variant table empty; using JS worker";
            wasm = null;
            backend = "js";
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
      /* The module reports a dead readback the block after it happens; drop to
       * the JS synth rather than keep pumping silence. */
      if ((backend.indexOf("wasm") === 0) && wasm) {
        try {
          if (
            typeof wasm._sound_worker_gpu_pcm_ok === "function" &&
            !(wasm._sound_worker_gpu_pcm_ok() | 0)
          )
            fallbackToJs("GPU readback went silent");
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
  var blockFrames = 256;
  var targetFrames = 1536;
  var needFrames = 768;
  var sampleRate = 48000;
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
    /* ~1 post per 350 ms whatever the block size — small blocks must not turn
     * the HUD feed into main-thread message spam. */
    if (!force && (pcmBlocksSent & 63) !== 0) return;
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
    /* Honour short interactive cushions; only guard against a zero target. */
    if (want < blockFrames * 2) want = blockFrames * 2;
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
      if (targetFrames < 512) targetFrames = 512;
      if (needFrames < 256) needFrames = 256;
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
     * When idle that look-ahead is pure silence, so shrink it — but *trim* to a
     * cushion instead of flushing to zero. A hard flush raced the next render
     * quantum, and every lost race cost an underrun (click + a permanent
     * look-ahead boost), which is exactly the random crackle we heard. */
    var hadAudio =
      SoundWorkerSsound.liveVoices() > 0 ||
      (SoundWorkerSsound.lastPeak && SoundWorkerSsound.lastPeak() > 1e-5) ||
      (SoundWorkerSsound.echoLive && SoundWorkerSsound.echoLive());
    var q = estimatedQueued();
    var keep = (needFrames > 0 ? needFrames : 1024) >> 1;
    if (keep < blockFrames * 2) keep = blockFrames * 2;
    if (!hadAudio) {
      if (audioPort && q > keep + blockFrames) {
        audioPort.postMessage({ type: "trim", keepFrames: keep });
        noteQueued(keep);
      }
      if (SoundWorkerSsound.resetOutput) SoundWorkerSsound.resetOutput();
    }
    var id = SoundWorkerSsound.play(msg);
    postMessage({ type: "played", id: id, voices: SoundWorkerSsound.liveVoices() });
    if (!audioPort) {
      scheduleSilentPump();
      return;
    }
    /* Get the attack into the FIFO now, then restore the cushion the trim
     * just gave up so the very next quantum cannot starve. */
    forcePushBlocks(hadAudio ? 1 : 2);
    fillToTarget(needFrames);
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
        blockFrames = msg.blockFrames > 0 ? msg.blockFrames | 0 : 256;
        targetFrames = msg.targetFrames > 0 ? msg.targetFrames | 0 : 1536;
        needFrames = msg.needFrames > 0 ? msg.needFrames | 0 : 768;
        if (msg.synthRate > 0 &&
            typeof SoundWorkerSsound !== "undefined" &&
            SoundWorkerSsound.setConfigRate)
          SoundWorkerSsound.setConfigRate(msg.synthRate | 0);
        sampleRate = msg.sampleRate > 0 ? +msg.sampleRate : (
          typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.getConfigRate
            ? SoundWorkerSsound.getConfigRate() : 48000);
        toneHz = msg.toneHz > 0 ? +msg.toneHz : 440;
        preferCpu = msg.preferCpu !== false; /* default CPU â€” avoids GPU contention with scene */
        synthReady = false;
        pendingPlays.length = 0;
        if (targetFrames < 512) targetFrames = 512;
        if (needFrames < 256) needFrames = 256;
        /* No GL here: SoundWorkerSsound owns its own OffscreenCanvas context
         * for the .sound pipelines. The old proto timing shader is gone. */
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
        if (typeof SoundWorkerSsound !== "undefined")
          SoundWorkerSsound.setMaster(msg.volume);
        return;
      }
      if (type === "set_echo") {
        if (typeof SoundWorkerSsound !== "undefined" && SoundWorkerSsound.setEcho)
          SoundWorkerSsound.setEcho(msg.delayMs, msg.feedback, msg.mix);
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
