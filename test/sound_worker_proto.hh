/* Proto 1+2 — WebGL2 worker readPixels + optional AudioWorklet PCM.
 * Web-only. Desktop stubs keep Wake/JIT builds clean.
 * Prefers web/sound_bus_proto.js (+ worker / worklet). Blob fallbacks if 404.
 */
#ifndef SOUND_WORKER_PROTO_HH
#define SOUND_WORKER_PROTO_HH

typedef struct SoundWorkerProtoStats {
   int ready;
   int ok;
   int audio_ready;
   int n;
   float last_ms;
   float avg_ms;
   float max_ms;
   float stall_ms;
   int sample0;
   int pcm_blocks;
   int underruns;
   int underrun_frames;
   int queued_frames;
   int min_queued_frames;
   int buffer_boost_frames;
   int voices;
   int sample_rate;
   int synth_rate;
   int output_rate;
   int pending_plays;
   int unlock_attempts;
   int secure_context;
   int worklet_supported;
   int mobile;
   int start_pending;
   float max_gap_ms;
   float fill_wait_ms;
   float fill_wait_max_ms;
   float synth_last_ms;
   float synth_avg_ms;
   float synth_max_ms;
   float worker_fill_last_ms;
   float worker_fill_max_ms;
   char audio_path[32];
   char context_state[16];
   char unlock_event[16];
   char audio_stage[24];
   char backend[24];
   char error[96];
} SoundWorkerProtoStats;

static int sound_worker_proto_wanted = 0;
static int sound_worker_proto_started = 0;
static int sound_worker_proto_stall_ms = 0;
static int sound_worker_proto_audio_wanted = 1;
static SoundWorkerProtoStats sound_worker_proto_stats;

#if defined(__EMSCRIPTEN__)
#include <emscripten.h>

EM_JS(int, sound_worker_proto_js_start, (int stall_ms, int width), {
  if (Module.sound_worker_proto && Module.sound_worker_proto.bus) return 1;
  Module.sound_worker_proto = {
    ready: 0, ok: 0, audio_ready: 0, error: "", starting: 1,
    stats: { n:0, last_ms:0, avg_ms:0, max_ms:0, stall_ms:0, sample0:0, pcm_blocks:0, underruns:0, queued_frames:0 }
  };
  function loc(name) {
    try { return (Module.locateFile ? Module.locateFile(name) : name); } catch (e) { return name; }
  }
  function loadScript(url) {
    return new Promise(function(resolve, reject) {
      var s = document.createElement("script");
      s.src = url;
      s.onload = function(){ resolve(); };
      s.onerror = function(){ reject(new Error("load " + url)); };
      document.head.appendChild(s);
    });
  }
  function bindBus(bus) {
    var st = Module.sound_worker_proto;
    st.bus = bus;
    st.ok = bus.ok ? 1 : 0;
    if (bus.error) st.error = bus.error;
    /* First gesture resumes AudioContext + attaches worklet (browser policy). */
    if (!st._gestureBound) {
      st._gestureBound = 1;
      var unlock = function(ev) {
        if (st.audio_ready || (bus && bus.audioReady)) return;
        st.last_unlock_event = (ev && ev.type) ? ev.type : "gesture";
        if (!bus || !bus.startAudio) return;
        bus.startAudio().then(function() {
          st.audio_ready = 1;
          console.log("[sound_proto2] audio ready");
        }).catch(function(err) {
          st.error = String(err && err.message ? err.message : err);
          console.error("[sound_proto2] audio", st.error);
        });
      };
      /* Keep listeners until audio is really ready. Android may reject or park
       * the first resume; a later touch must remain able to retry it. */
      window.addEventListener("pointerdown", unlock, { capture: true });
      window.addEventListener("touchstart", unlock, { capture: true, passive: true });
      window.addEventListener("touchend", unlock, { capture: true, passive: true });
      window.addEventListener("click", unlock, { capture: true });
      window.addEventListener("keydown", unlock, { capture: true });
    }
  }
  function onReady(bus, msg) {
    var st = Module.sound_worker_proto;
    st.ready = 1; st.ok = 1;
    st.renderer = (msg && msg.renderer) || bus.renderer || "";
    console.log("[sound_proto2] worker ready", st.renderer);
  }
  function onStats(bus) {
    var st = Module.sound_worker_proto;
    var s = bus.stats || {};
    st.stats.n = s.n|0;
    st.stats.last_ms = +s.last_ms || 0;
    st.stats.avg_ms = +s.avg_ms || 0;
    st.stats.max_ms = +s.max_ms || 0;
    st.stats.stall_ms = +s.stall_ms || 0;
    st.stats.sample0 = s.sample0|0;
   st.stats.pcm_blocks = s.pcm_blocks|0;
    if (s.backend != null) st.stats.backend = String(s.backend);
    /* Keep FIFO frames and live voices separate: the old HUD accidentally
     * displayed voice count as q, hiding real starvation. */
    if (s.underruns != null) st.stats.underruns = s.underruns|0;
    if (s.underrunFrames != null) st.stats.underrun_frames = s.underrunFrames|0;
    if (s.maxGapMs != null) st.stats.max_gap_ms = +s.maxGapMs||0;
    if (s.minQueuedFrames != null) st.stats.min_queued_frames = s.minQueuedFrames|0;
    if (s.fillWaitMs != null) st.stats.fill_wait_ms = +s.fillWaitMs||0;
    if (s.fillWaitMaxMs != null) st.stats.fill_wait_max_ms = +s.fillWaitMaxMs||0;
    if (s.bufferBoostFrames != null) st.stats.buffer_boost_frames = s.bufferBoostFrames|0;
    if (s.voices != null) st.stats.voices = s.voices|0;
    if (s.queuedFrames != null) st.stats.queued_frames = s.queuedFrames|0;
    else if (s.queued_est != null && !(bus.audioPath && bus.audioPath.indexOf("worklet") === 0))
      st.stats.queued_frames = s.queued_est|0;
    if (s.synthRate != null) st.stats.synth_rate = s.synthRate|0;
    if (s.outputRate != null) st.stats.output_rate = s.outputRate|0;
    if (s.synthLastMs != null) st.stats.synth_last_ms = +s.synthLastMs||0;
    if (s.synthAvgMs != null) st.stats.synth_avg_ms = +s.synthAvgMs||0;
    if (s.synthMaxMs != null) st.stats.synth_max_ms = +s.synthMaxMs||0;
    if (s.workerFillLastMs != null) st.stats.worker_fill_last_ms = +s.workerFillLastMs||0;
    if (s.workerFillMaxMs != null) st.stats.worker_fill_max_ms = +s.workerFillMaxMs||0;
  }
  function onError(bus, msg) {
    var st = Module.sound_worker_proto;
    st.ok = 0; st.ready = 0;
    st.error = (msg && msg.reason) ? msg.reason : (bus.error || "error");
    console.error("[sound_proto2]", st.error);
  }

  (async function() {
    var st = Module.sound_worker_proto;
    try {
      if (!Module.SoundBusProto) await loadScript(loc("sound_bus_proto.js"));
      var api = Module.SoundBusProto || (typeof SoundBusProto !== "undefined" ? SoundBusProto : null);
      if (!api || !api.create) throw new Error("SoundBusProto missing");
      var bus = api.create({
        width: width > 0 ? width : 1024,
        height: 1,
        stallMs: stall_ms > 0 ? stall_ms : 0,
        /* Alongside the raytracer: CPU synth + deeper FIFO (less underrun). */
        preferCpu: true,
        /* Android: worklet-inline (proto3-stable under scene lag).
         * Desktop web: worker PCM so heavy FM stays off the audio callback. */
        inlineSynth: /Android|iPhone|iPad|iPod|Mobile/i.test(
          (typeof navigator !== "undefined" && navigator.userAgent) || ""
        ),
        blockFrames: 1024,
        targetFrames: 8192,
        needFrames: 4096,
        onReady: onReady,
        onStats: onStats,
        onAudioStats: onStats,
        onError: onError,
        onAudioReady: function(){ Module.sound_worker_proto.audio_ready = 1; }
      });
      bindBus(bus);
      /* As soon as the worker bus exists, detach Sokol's main-thread ScriptProcessor
       * so render FPS cannot pace audio (even before the user unlocks Worklet). */
      try {
        if (Module._saudio_node) {
          try { Module._saudio_node.disconnect(); } catch (e0) {}
          Module._saudio_node.onaudioprocess = null;
          Module._saudio_node = null;
        }
        if (Module._saudio_context) {
          try { Module._saudio_context.close(); } catch (e1) {}
          Module._saudio_context = null;
        }
        console.log("[sound_proto2] main saudio detached — worker owns audio");
      } catch (eDet) {}
      if (bus.error) throw new Error(bus.error);
      st.starting = 0;
      console.log("[sound_proto2] bus started; click/tap to unlock audio");
    } catch (err) {
      st.starting = 0;
      st.error = String(err && err.message ? err.message : err);
      console.error("[sound_proto2] start failed", st.error);
    }
  })();
  return 1;
});

EM_JS(void, sound_worker_proto_js_set_stall, (int stall_ms, int busy_mode), {
  var st = Module.sound_worker_proto;
  if (!st || !st.bus || !st.bus.setStall) return;
  st.bus.setStall(stall_ms > 0 ? stall_ms : 0, busy_mode ? "busy" : "async");
});

EM_JS(void, sound_worker_proto_js_play_tweet, (
   float volume, float duration, float fadein, float envelop,
   float freq_x, float freq_y, float freq_z, float freq_w), {
  var st = Module.sound_worker_proto;
  if (!st || !st.bus || !st.bus.play) {
    console.warn("[sound_proto2] play dropped — no bus");
    return;
  }
  st.bus.play({
    soundType: "tweet",
    volume: volume,
    duration: duration,
    fadein: fadein,
    envelop: envelop,
    freqX: freq_x,
    freqY: freq_y,
    freqZ: freq_z,
    freqW: freq_w
  });
});

EM_JS(void, sound_worker_proto_js_stop_all, (void), {
  var st = Module.sound_worker_proto;
  if (st && st.bus && st.bus.stopAll) st.bus.stopAll();
});

EM_JS(int, sound_worker_proto_js_audio_ready, (void), {
  var st = Module.sound_worker_proto;
  return (st && st.audio_ready) ? 1 : 0;
});

EM_JS(int, sound_worker_proto_js_has_bus, (void), {
  var st = Module.sound_worker_proto;
  return (st && st.bus) ? 1 : 0;
});

EM_JS(void, sound_worker_proto_js_start_audio, (void), {
   var st = Module.sound_worker_proto;
   if (!st || !st.bus || !st.bus.startAudio) return;
   st.last_unlock_event = "hud";
   st.bus.startAudio().then(function(){ st.audio_ready = 1; })
    .catch(function(err){ st.error = String(err && err.message ? err.message : err); });
});

EM_JS(void, sound_worker_proto_js_stop, (void), {
  var st = Module.sound_worker_proto;
  if (!st) return;
  if (st.bus && st.bus.stop) st.bus.stop();
  st.bus = null;
  st.ready = 0;
  st.ok = 0;
  st.audio_ready = 0;
});

EM_JS(int, sound_worker_proto_js_poll, (
   float* out29, char* err_buf, int err_cap,
   char* path_buf, int path_cap, char* ctx_buf, int ctx_cap,
   char* event_buf, int event_cap, char* stage_buf, int stage_cap,
   char* backend_buf, int backend_cap), {
   var st = Module.sound_worker_proto;
   if (!st) return 0;
   var s = st.stats || {};
   var bus = st.bus || {};
   var ctx = bus.audioCtx || null;
   function put_ascii(ptr, cap, value) {
     if (!ptr || cap <= 0) return;
     value = String(value || "");
     var count = Math.min(cap - 1, value.length);
     for (var i = 0; i < count; i++) HEAPU8[ptr + i] = value.charCodeAt(i) & 255;
     HEAPU8[ptr + count] = 0;
   }
   HEAPF32[(out29>>2)+0] = s.last_ms || 0;
   HEAPF32[(out29>>2)+1] = s.avg_ms || 0;
   HEAPF32[(out29>>2)+2] = s.max_ms || 0;
   HEAPF32[(out29>>2)+3] = s.stall_ms || 0;
   HEAPF32[(out29>>2)+4] = s.n || 0;
   HEAPF32[(out29>>2)+5] = s.sample0 || 0;
   HEAPF32[(out29>>2)+6] = s.underruns || 0;
   HEAPF32[(out29>>2)+7] = s.queued_frames || 0;
   HEAPF32[(out29>>2)+8] = bus.sampleRate || (ctx ? ctx.sampleRate : 0) || 0;
   HEAPF32[(out29>>2)+9] = bus._pendingPlays ? bus._pendingPlays.length : 0;
   HEAPF32[(out29>>2)+10] = bus._unlockAttempts || 0;
   HEAPF32[(out29>>2)+11] = self.isSecureContext ? 1 : 0;
   HEAPF32[(out29>>2)+12] =
      (ctx && ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") ? 1 : 0;
   HEAPF32[(out29>>2)+13] = bus.mobile ? 1 : 0;
   HEAPF32[(out29>>2)+14] = bus._startPromise ? 1 : 0;
   HEAPF32[(out29>>2)+15] = s.underrun_frames || 0;
   HEAPF32[(out29>>2)+16] = s.max_gap_ms || 0;
   HEAPF32[(out29>>2)+17] = s.min_queued_frames || 0;
   HEAPF32[(out29>>2)+18] = s.fill_wait_ms || 0;
   HEAPF32[(out29>>2)+19] = s.fill_wait_max_ms || 0;
   HEAPF32[(out29>>2)+20] = s.buffer_boost_frames || 0;
   HEAPF32[(out29>>2)+21] = s.synth_rate || 0;
   HEAPF32[(out29>>2)+22] = s.output_rate || 0;
   HEAPF32[(out29>>2)+23] = s.synth_last_ms || 0;
   HEAPF32[(out29>>2)+24] = s.synth_avg_ms || 0;
   HEAPF32[(out29>>2)+25] = s.synth_max_ms || 0;
   HEAPF32[(out29>>2)+26] = s.worker_fill_last_ms || 0;
   HEAPF32[(out29>>2)+27] = s.worker_fill_max_ms || 0;
   HEAPF32[(out29>>2)+28] = s.voices || 0;
   put_ascii(path_buf, path_cap, bus.audioPath || "none");
   put_ascii(ctx_buf, ctx_cap, ctx ? ctx.state : "none");
   put_ascii(event_buf, event_cap, st.last_unlock_event || "none");
   put_ascii(stage_buf, stage_cap, bus.audioStage || "none");
   put_ascii(backend_buf, backend_cap, s.backend || "none");
   if (err_buf && err_cap > 1 && st.error) {
     var e = String(st.error);
    var n = Math.min(err_cap - 1, e.length);
    for (var i = 0; i < n; i++) HEAPU8[err_buf + i] = e.charCodeAt(i) & 255;
    HEAPU8[err_buf + n] = 0;
  } else if (err_buf && err_cap > 0) {
    HEAPU8[err_buf] = 0;
  }
  return (st.ready ? 2 : 0) | (st.ok ? 1 : 0) | (st.error ? 4 : 0) | (st.audio_ready ? 8 : 0);
});

static void sound_worker_proto_poll(void) {
   float buf[29];
   int flags;
   /* Bus may appear asynchronously (JS boot) — adopt it even if C start raced. */
   if (!sound_worker_proto_started && sound_worker_proto_js_has_bus())
      sound_worker_proto_started = 1;
   if (!sound_worker_proto_started) return;
   flags = sound_worker_proto_js_poll(
      buf, sound_worker_proto_stats.error, (int)sizeof(sound_worker_proto_stats.error),
      sound_worker_proto_stats.audio_path, (int)sizeof(sound_worker_proto_stats.audio_path),
      sound_worker_proto_stats.context_state, (int)sizeof(sound_worker_proto_stats.context_state),
      sound_worker_proto_stats.unlock_event, (int)sizeof(sound_worker_proto_stats.unlock_event),
      sound_worker_proto_stats.audio_stage, (int)sizeof(sound_worker_proto_stats.audio_stage),
      sound_worker_proto_stats.backend, (int)sizeof(sound_worker_proto_stats.backend));
   sound_worker_proto_stats.ready = (flags & 2) ? 1 : 0;
   sound_worker_proto_stats.ok = (flags & 1) ? 1 : 0;
   sound_worker_proto_stats.audio_ready = (flags & 8) ? 1 : 0;
   sound_worker_proto_stats.last_ms = buf[0];
   sound_worker_proto_stats.avg_ms = buf[1];
   sound_worker_proto_stats.max_ms = buf[2];
   sound_worker_proto_stats.stall_ms = buf[3];
   sound_worker_proto_stats.n = (int)buf[4];
   sound_worker_proto_stats.sample0 = (int)buf[5];
   sound_worker_proto_stats.underruns = (int)buf[6];
   sound_worker_proto_stats.queued_frames = (int)buf[7];
   sound_worker_proto_stats.sample_rate = (int)buf[8];
   sound_worker_proto_stats.pending_plays = (int)buf[9];
   sound_worker_proto_stats.unlock_attempts = (int)buf[10];
   sound_worker_proto_stats.secure_context = (int)buf[11];
   sound_worker_proto_stats.worklet_supported = (int)buf[12];
   sound_worker_proto_stats.mobile = (int)buf[13];
   sound_worker_proto_stats.start_pending = (int)buf[14];
   sound_worker_proto_stats.underrun_frames = (int)buf[15];
   sound_worker_proto_stats.max_gap_ms = buf[16];
   sound_worker_proto_stats.min_queued_frames = (int)buf[17];
   sound_worker_proto_stats.fill_wait_ms = buf[18];
   sound_worker_proto_stats.fill_wait_max_ms = buf[19];
   sound_worker_proto_stats.buffer_boost_frames = (int)buf[20];
   sound_worker_proto_stats.synth_rate = (int)buf[21];
   sound_worker_proto_stats.output_rate = (int)buf[22];
   sound_worker_proto_stats.synth_last_ms = buf[23];
   sound_worker_proto_stats.synth_avg_ms = buf[24];
   sound_worker_proto_stats.synth_max_ms = buf[25];
   sound_worker_proto_stats.worker_fill_last_ms = buf[26];
   sound_worker_proto_stats.worker_fill_max_ms = buf[27];
   sound_worker_proto_stats.voices = (int)buf[28];
   if (!(flags & 4)) sound_worker_proto_stats.error[0] = 0;
}

static void sound_worker_proto_start(int stall_ms) {
   sound_worker_proto_stall_ms = stall_ms > 0 ? stall_ms : 0;
   if (sound_worker_proto_js_start(sound_worker_proto_stall_ms, 1024)) {
      sound_worker_proto_started = 1;
      sound_worker_proto_wanted = 1;
   }
}

static void sound_worker_proto_stop(void) {
   sound_worker_proto_js_stop();
   sound_worker_proto_started = 0;
   sound_worker_proto_stats.ready = 0;
   sound_worker_proto_stats.ok = 0;
   sound_worker_proto_stats.audio_ready = 0;
}

static int sound_worker_proto_busy_stall = 0;

static void sound_worker_proto_set_stall(int stall_ms) {
   sound_worker_proto_stall_ms = stall_ms > 0 ? stall_ms : 0;
   if (sound_worker_proto_started)
      sound_worker_proto_js_set_stall(sound_worker_proto_stall_ms, sound_worker_proto_busy_stall);
}

static void sound_worker_proto_draw_ui(void) {
   bool on = sound_worker_proto_wanted != 0;
   bool busy = sound_worker_proto_busy_stall != 0;
   int stall = sound_worker_proto_stall_ms;
   sound_worker_proto_poll();
   if (igCheckbox("Sound worker proto##bc_swp", &on)) {
      sound_worker_proto_wanted = on ? 1 : 0;
      if (on) sound_worker_proto_start(sound_worker_proto_stall_ms);
      else sound_worker_proto_stop();
   }
   if (igIsItemHovered(0))
      igSetTooltip("Worker WebGL2 + AudioWorklet. Delay=async pause; Busy=CPU spin (hurts Android FPS).");
   if (sound_worker_proto_started) {
      if (igSliderInt("Proto delay ms##bc_swp", &stall, 0, 30))
         sound_worker_proto_set_stall(stall);
      if (igCheckbox("Busy-wait stall (Android FPS killer)##bc_swp", &busy)) {
         sound_worker_proto_busy_stall = busy ? 1 : 0;
         sound_worker_proto_set_stall(sound_worker_proto_stall_ms);
      }
      if (igButton("Unlock audio##bc_swp"))
         sound_worker_proto_js_start_audio();
      igSameLine();
      if (igButton("Play tweet##bc_swp"))
         sound_worker_proto_js_play_tweet(0.7f, 0.4f, 0.0000006f, 8.f, 4.f, 8.f, 0.f, 1.f);
      igSameLine();
      if (igButton("Stop all##bc_swp"))
         sound_worker_proto_js_stop_all();
      if (sound_worker_proto_stats.error[0])
         igText("proto err: %s", sound_worker_proto_stats.error);
      else if (!sound_worker_proto_stats.ready)
         igTextDisabled("proto: starting...");
      else {
         igText("audio %s | ctx=%s | %d Hz | %s",
            sound_worker_proto_stats.audio_path,
            sound_worker_proto_stats.context_state,
            sound_worker_proto_stats.sample_rate,
            sound_worker_proto_stats.mobile ? "Android/mobile" : "desktop");
         igText("secure=%s | worklet=%s | unlock=%s/%d | stage=%s | start=%s | pending=%d",
            sound_worker_proto_stats.secure_context ? "yes" : "NO",
            sound_worker_proto_stats.worklet_supported ? "yes" : "NO",
            sound_worker_proto_stats.unlock_event,
            sound_worker_proto_stats.unlock_attempts,
            sound_worker_proto_stats.audio_stage,
            sound_worker_proto_stats.start_pending ? "pending" : "idle",
            sound_worker_proto_stats.pending_plays);
         igText("backend=%s | synth %d -> %d Hz | block %.2f/%.2f ms avg/max",
            sound_worker_proto_stats.backend,
            sound_worker_proto_stats.synth_rate,
            sound_worker_proto_stats.output_rate,
            (double)sound_worker_proto_stats.synth_avg_ms,
            (double)sound_worker_proto_stats.synth_max_ms);
         igText("FIFO q=%d min=%d boost=%d | wait %.1f/%.1f ms | fill max %.1f ms",
            sound_worker_proto_stats.queued_frames,
            sound_worker_proto_stats.min_queued_frames,
            sound_worker_proto_stats.buffer_boost_frames,
            (double)sound_worker_proto_stats.fill_wait_ms,
            (double)sound_worker_proto_stats.fill_wait_max_ms,
            (double)sound_worker_proto_stats.worker_fill_max_ms);
         igText("underrun events=%d frames=%d max-gap=%.1f ms | voices=%d |%s%s",
            sound_worker_proto_stats.underruns,
            sound_worker_proto_stats.underrun_frames,
            (double)sound_worker_proto_stats.max_gap_ms,
            sound_worker_proto_stats.voices,
            sound_worker_proto_stats.audio_ready ? " audio ready" : " LOCKED",
            sound_worker_proto_busy_stall ? " BUSY" : "");
         if (!sound_worker_proto_stats.secure_context &&
             !sound_worker_proto_stats.worklet_supported)
            igText("HTTP fallback: ScriptProcessor runs on the render thread.");
      }
   }
}

#else /* !__EMSCRIPTEN__ */

static void sound_worker_proto_poll(void) {}
static void sound_worker_proto_start(int stall_ms) { (void)stall_ms; }
static void sound_worker_proto_stop(void) {}
static void sound_worker_proto_set_stall(int stall_ms) { (void)stall_ms; }
static int sound_worker_proto_js_has_bus(void) { return 0; }
static void sound_worker_proto_js_play_tweet(
   float volume, float duration, float fadein, float envelop,
   float fx, float fy, float fz, float fw) {
   (void)volume; (void)duration; (void)fadein; (void)envelop;
   (void)fx; (void)fy; (void)fz; (void)fw;
}
static void sound_worker_proto_js_stop_all(void) {}
static void sound_worker_proto_draw_ui(void) {
   igTextDisabled("Sound worker proto: web/emsc only");
}

#endif /* __EMSCRIPTEN__ */

#endif /* SOUND_WORKER_PROTO_HH */
