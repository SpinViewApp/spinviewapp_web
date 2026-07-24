/* Boot sound next to the scene App.
 * Device ownership: C-side ssound_set_no_saudio(1) — no JS saudio watchdog.
 */
(function () {
  "use strict";

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = url;
      s.onload = function () {
        resolve();
      };
      s.onerror = function () {
        reject(new Error("load " + url));
      };
      document.head.appendChild(s);
    });
  }

  function loc(name) {
    try {
      return Module.locateFile ? Module.locateFile(name) : name;
    } catch (e) {
      return name;
    }
  }

  async function bootInlineSound() {
    if (!window.SoundBusProto) await loadScript(loc("sound_bus_proto.js"));
    var api = window.SoundBusProto || (Module && Module.SoundBusProto);
    if (!api || !api.create) {
      console.error("[snd-boot] SoundBusProto missing — copy sound_bus_proto.js next to App.html");
      return null;
    }
    if (Module.sound_worker_proto && Module.sound_worker_proto.bus) {
      console.info("[snd-boot] bus already present");
      return Module.sound_worker_proto.bus;
    }
    Module.sound_worker_proto = Module.sound_worker_proto || {
      ready: 0,
      ok: 0,
      audio_ready: 0,
      error: "",
      stats: {}
    };
    var bus = api.create({
      width: 64,
      height: 1,
      preferCpu: true,
      inlineSynth: true,
      blockFrames: 1024,
      targetFrames: 8192,
      needFrames: 4096,
      onReady: function (st, msg) {
        Module.sound_worker_proto.ready = 1;
        Module.sound_worker_proto.ok = 1;
        console.info(
          "[snd-boot] WORKLET bus ready backend=" + (msg.backend || "?")
        );
      },
      onAudioReady: function () {
        Module.sound_worker_proto.audio_ready = 1;
        console.info("[snd-boot] audio path=" + bus.audioPath);
      },
      onError: function (st, msg) {
        Module.sound_worker_proto.error = (msg && msg.reason) || "error";
        console.error("[snd-boot]", Module.sound_worker_proto.error);
      }
    });
    Module.sound_worker_proto.bus = bus;
    Module.__spin_inline_bus = bus;

    function unlock() {
      if (!bus || !bus.startAudio) return;
      bus
        .startAudio()
        .then(function () {
          Module.sound_worker_proto.audio_ready = 1;
          console.info("[snd-boot] unlocked path=" + bus.audioPath);
        })
        .catch(function (err) {
          console.error("[snd-boot] unlock", err);
        });
    }
    window.addEventListener("pointerdown", unlock, { capture: true, once: true });
    window.addEventListener("touchstart", unlock, { capture: true, once: true });
    window.addEventListener("keydown", unlock, { capture: true, once: true });

    /* If C glue play_tweet exists later, also expose a global test. */
    window.spinPlayTweet = function () {
      if (bus && bus.play)
        bus.play({
          soundType: "tweet",
          volume: 0.7,
          duration: 0.4,
          envelop: 0.08,
          freqX: 4,
          freqY: 8
        });
    };
    console.info("[snd-boot] tap once, then spinPlayTweet() or in-game bounce");
    return bus;
  }

  function arm() {
    var prev = Module.onRuntimeInitialized;
    Module.onRuntimeInitialized = function () {
      if (typeof prev === "function") prev.apply(this, arguments);
      bootInlineSound().catch(function (e) {
        console.error("[snd-boot] failed", e);
      });
    };
  }

  if (window.Module) arm();
  else {
    Object.defineProperty(window, "Module", {
      configurable: true,
      set: function (m) {
        Object.defineProperty(window, "Module", {
          configurable: true,
          writable: true,
          value: m
        });
        arm();
      },
      get: function () {
        return undefined;
      }
    });
  }
})();
