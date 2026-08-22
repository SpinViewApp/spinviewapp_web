/* Proto bus - worker PCM @48k â†’ optional resample â†’ AudioWorklet (desktop + Android).
 *
 * Production uses App.wasm's Sokol GPU and creates no Worker or second WebGL
 * context. When AudioWorklet is unavailable Numeris selects Sokol WebAudio.
 */
(function (global) {
  "use strict";

  /* Old App.wasm EM_JS may reference SSOUND_SAMPLE_RATE as a bare JS id
   * (C macros are not expanded inside EM_JS string bodies). */
  if (typeof global.SSOUND_SAMPLE_RATE !== "number")
    global.SSOUND_SAMPLE_RATE = 48000;

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

  /* Firefox keeps Sokol's ScriptProcessor alive in background tabs (throttled
   * callbacks = lagged tails). Mute the callback + suspend that context even
   * after the worker bus has been torn down (Safari / main-thread GPU path). */
  function sokolSilenceProcess(e) {
    var out = e.outputBuffer;
    var c, ch, i, n = out.length;
    for (c = 0; c < out.numberOfChannels; c++) {
      ch = out.getChannelData(c);
      for (i = 0; i < n; i++) ch[i] = 0;
    }
  }

  function pauseSokolSaudio() {
    var M, node, ctx;
    try {
      M = global.Module;
    } catch (eM) {
      return;
    }
    if (!M) return;
    M._numerisSaudioPaused = 1;
    node = M._saudio_node;
    ctx = M._saudio_context;
    if (node && node.onaudioprocess !== sokolSilenceProcess) {
      if (!node._numerisSavedProcess) node._numerisSavedProcess = node.onaudioprocess;
      node.onaudioprocess = sokolSilenceProcess;
      try {
        node.disconnect();
      } catch (e0) {}
    }
    if (ctx && ctx.state === "running") {
      try {
        ctx.suspend();
      } catch (e1) {}
    }
  }

  function resumeSokolSaudio() {
    var M, node, ctx, p;
    try {
      M = global.Module;
    } catch (eM) {
      return;
    }
    if (!M) return;
    /* Numeris owns the device through its Worklet bus. A stale App.wasm may
     * still expose Sokol's ScriptProcessor; reconnecting it on pointerdown or
     * pageshow bypasses outputGain and is heard as an un-ramped pop. */
    if (global._numerisSoundBusOwnsDevice) {
      node = M._saudio_node;
      if (node) {
        try { node.disconnect(); } catch (eOwn0) {}
        node.onaudioprocess = sokolSilenceProcess;
      }
      M._numerisSaudioPaused = 1;
      return;
    }
    if (!M._numerisSaudioPaused) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden")
      return;
    M._numerisSaudioPaused = 0;
    ctx = M._saudio_context;
    node = M._saudio_node;
    if (node && node._numerisSavedProcess) {
      node.onaudioprocess = node._numerisSavedProcess;
      node._numerisSavedProcess = null;
    }
    if (ctx && ctx.state !== "closed") {
      try {
        p = ctx.resume();
        if (p && typeof p.catch === "function") p.catch(function () {});
      } catch (e0) {}
    }
    if (node && ctx && ctx.destination) {
      try {
        node.connect(ctx.destination);
      } catch (e1) {}
    }
  }

  function bindSokolPageMute() {
    if (global._numerisSokolVisBound) return;
    global._numerisSokolVisBound = 1;
    if (typeof document !== "undefined") {
      document.addEventListener(
        "visibilitychange",
        function () {
          if (document.visibilityState === "hidden") {
            pauseSokolSaudio();
            var tick = function () {
              if (document.visibilityState !== "hidden") return;
              pauseSokolSaudio();
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          } else resumeSokolSaudio();
        },
        true
      );
    }
    if (typeof window !== "undefined") {
      window.addEventListener(
        "pagehide",
        function () {
          pauseSokolSaudio();
        },
        true
      );
      document.addEventListener(
        "pointerdown",
        function () {
          if (typeof document !== "undefined" && document.visibilityState === "visible")
            resumeSokolSaudio();
        },
        true
      );
    }
  }
  bindSokolPageMute();

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
  /* Embedded AudioWorklet processor (andr40) — no separate spin_audio_processor.js fetch. */
  var SPIN_AUDIO_PROCESSOR_SRC = "/* AudioWorklet: realtime tweet/tone synth (priority path).\n *\n * Envelope matches ssound/sbase.ginc (sustain + exp(-envelop*(t-duration))).\n * legacyTimeScale remains configurable for A/B tests; production uses 1.0 so\n * one device frame advances exactly one sample of tweet.sound time.\n */\nclass SpinAudioProcessor extends AudioWorkletProcessor {\n  constructor(options) {\n    super();\n    var opts = (options && options.processorOptions) || {};\n    this.mode = opts.mode === \"pcm\" ? \"pcm\" : \"inline\";\n    this.lightSynth = !!opts.lightSynth;\n    this.legacyTimeScale =\n      opts.legacyTimeScale > 0 ? +opts.legacyTimeScale : 1.0;\n    /* SOUND_UNLOCK_FADEIN_SEC \u2014 soft onset when device first becomes audible. */\n    this.unlockFadeSec =\n      opts.unlockFadeSec > 0 ? +opts.unlockFadeSec : 0.12;\n    this.unlockGain = 0;\n    this.unlockActive = this.unlockFadeSec > 0;\n    this.blocks = [];\n    this.queuedFrames = 0;\n    this.current = null;\n    this.offset = 0;\n    this.underruns = 0; /* gap events, not individual samples */\n    this.underrunFrames = 0;\n    this.maxGapFrames = 0;\n    this.gapFrames = 0;\n    this.gapStartL = 0;\n    this.gapStartR = 0;\n    this.lastOutL = 0;\n    this.lastOutR = 0;\n    this.crossfadeFrames = 192;\n    this.holdFrames = 64;\n    this.healthyQuanta = 0;\n    this.crossfadeLeft = 0;\n    this.crossfadeFromL = 0;\n    this.crossfadeFromR = 0;\n    this.recoveryLeft = 0;\n    this.recoveryFromL = 0;\n    this.recoveryFromR = 0;\n    this.minQueuedFrames = 0x7fffffff;\n    this.fillWaitLastFrames = 0;\n    this.fillWaitMaxFrames = 0;\n    this.renderFrames = 0;\n    this.needSentAtFrame = 0;\n    this.bufferBoostFrames = 0;\n    this.needThreshold = 4096;\n    this.targetFrames = 8192;\n    this.sourcePort = null;\n    this._tick = 0;\n    this._needSent = false;\n    this.primed = false;\n    this.master = 1.0;\n    /* Anti-zipper : le volume maitre sautait d un bloc a l autre. Une marche de\n     * gain est un clic, exactement comme une marche de signal. On glisse donc\n     * vers la cible sur ~15 ms, echantillon par echantillon. */\n    this.masterTarget = 1.0;\n    this.masterSlew = 1.0 / (0.015 * sampleRate);\n    this.masterRamp = null;\n\n    /* ===================== FILTRE D ANOMALIES =========================\n     * Dernier etage avant le DAC. Il ne fait pas confiance a ce qui arrive :\n     * quelle que soit la cause en amont (famine du FIFO, re-ancrage de la\n     * source apres une suspension, changement de page, flush), la sortie doit\n     * rester continue en VALEUR et en PENTE. Une marche de signal est un clic ;\n     * une cassure de pente est un \u00ab thump \u00bb.\n     *\n     * Deux mecanismes :\n     *   1. Trou de donnees -> on ne se tait pas, on PROLONGE la forme d onde en\n     *      repetant sa derniere periode (detectee par autocorrelation), avec une\n     *      decroissance douce. L oreille entend une continuation, pas un trou.\n     *   2. Rupture DANS le flux -> impossible au milieu d un bloc (le producteur\n     *      ecrit des echantillons contigus), donc on ne teste qu au JOINT entre\n     *      deux blocs. C est exactement la ou tombe la couture quand la source\n     *      se re-ancre : la file contient encore la fin de l ancien signal et le\n     *      bloc suivant repart d ailleurs. Zero faux positif sur une vraie\n     *      attaque percussive, qui elle vit a l interieur d un bloc. */\n    this.histLen = 2048;\n    this.histL = new Float32Array(this.histLen);\n    this.histR = new Float32Array(this.histLen);\n    this.histW = 0;\n    this.prevOutL = 0;\n    this.prevOutR = 0;\n    this.meanDelta = 0;          /* EMA de |x[n]-x[n-1]| : echelle du signal */\n    this.concealOn = 0;          /* dissimulation active */\n    this.concealPeriod = 0;      /* periode detectee, en frames */\n    this.concealPeriodF = 256;   /* la meme, au sous-echantillon pres */\n    this.concealPos = 0;         /* avancement dans la periode */\n    this.concealFrames = 0;      /* frames dissimulees depuis le debut */\n    this.concealDecay = 0;       /* gain courant de la dissimulation */\n    this.spliceLeft = 0;         /* frames restantes de raccord */\n    this.spliceFrames = 240;     /* 5 ms @48k - mesure : meilleur compromis\n                                    entre cassure de pente en sortie de trou et\n                                    etalement de la couture (96 / 240 / 384 testes) */\n    /* 80 ms de boucle sur une periode DETECTEE, c est assez long pour etre\n     * entendu comme une hauteur \u2014 une note qui n a jamais existe. 30 ms\n     * couvrent un vrai trou sans jamais devenir un son. */\n    this.concealFadeLong  = 1440;  /* 30 ms : signal franchement periodique */\n    this.concealFadeShort = 384;   /* 8 ms : extinction douce, aucune synthese */\n    this.concealFadeFrames = this.concealFadeLong;\n    this.concealScore = 0;\n    this.concealTonal = 0;\n    /* Total de frames RECUES depuis le debut. Compteur monotone : il permet\n     * au bus de savoir exactement combien de ce qu il a envoye n est pas encore\n     * arrive ici. Sans lui, un bloc pousse entre la mesure du worklet et la\n     * reception du message cote principal disparaissait de l estimation. */\n    this.rxFrames = 0;\n    /* Marque de vidage : tout bloc dont la position de depart precede cette\n     * valeur a ete produit AVANT le dernier reset. Le jouer recollerait du\n     * signal d avant le vidage devant du signal d apres \u2014 une marche. */\n    this.acceptAfter = -1;\n    /* Rearmement du detecteur de couture apres un vidage. Voir forgetHistory. */\n    this.seamWarm = 0;\n    /* LE PUITS NE VOIT PAS LE GAIN DE SORTIE. Le GainNode vit dans le graphe,\n     * pas ici : le worklet emettait donc a plein niveau et comptait des famines\n     * alors que la sortie etait a zero. Chaque famine inaudible faisait tomber\n     * le rendu a 1/2, puis la qualite auto au plancher. Le bus nous dit\n     * maintenant quand la sortie est fermee. */\n    this.outMuted = 1;\n    /* RAMPE D OUVERTURE ACCROCHEE AU SIGNAL, PAS A L HORLOGE.\n     * Mesure a l enveloppe : apres un re-ancrage la file se remplit d abord de\n     * blocs de SILENCE. La rampe de 180 ms se consommait donc entierement sur\n     * du silence, et quand la musique arrivait enfin le gain valait deja 1 :\n     * l attaque reelle entrait en MARCHE, sans aucun fondu. On arme donc une\n     * rampe qui ne commence a monter qu au premier echantillon non nul. */\n    this.reopenArmed = 0;\n    this.reopenStarted = 0;\n    this.reopenLeft = 0;\n    this.reopenSpan = 1;\n    /* DOUCEUR DE REPRISE APRES TOUT SILENCE, QUELLE QU EN SOIT LA CAUSE.\n     * Mesure a l enveloppe, au demarrage : 65 ms de signal faible, puis 400 ms\n     * de silence TOTAL (des blocs vides produits par la source, pas une\n     * famine : underruns=+0/0), puis la musique qui repart d un coup a\n     * gain=0.700 deja ouvert. La rampe d ouverture avait ete consommee par le\n     * signal faible d avant le trou \u2014 il ne restait rien pour couvrir la vraie\n     * attaque.\n     * On ne raisonne donc plus par evenement de cycle de vie. Regle unique et\n     * permanente : apres 150 ms de silence franc, le premier son qui revient\n     * est fondu sur 12 ms. 150 ms, c est un TROU, pas une respiration\n     * musicale ; 12 ms suffisent a supprimer un claquement et restent dans le\n     * temps d attaque de n importe quel son, donc inaudibles sur un vrai\n     * transitoire. Ne se declenche jamais sur un flux continu. */\n    this.simple = 0;\n    /* ============ SINUS GENERE SUR LE FIL AUDIO ============\n     * Le contenu est fabrique ICI, dans process(), sur le fil audio du\n     * navigateur. Le fil principal n a plus rien a livrer a temps : ni bloc,\n     * ni message, ni minuterie. Toute la plomberie reste en place (file,\n     * gain, fondus) \u2014 seul le CONTENU cesse de dependre du fil principal.\n     * C est le seul test qui separe \u00ab le fil principal est bloque \u00bb de\n     * \u00ab le peripherique cale \u00bb. */\n    this.selfTest = 0;\n    this.selfPhase = 0;\n    this.selfInc = 0;\n    this.quietRun = 0;\n    this.quietArm = (sampleRate * 0.150) | 0;\n    /* DEUX FONDUS DISTINCTS, QUI NE DOIVENT PAS SE MARCHER DESSUS.\n     * - softSpan (12 ms) : un trou A L INTERIEUR d un flux qui tourne. Court\n     *   par obligation : plus long emousserait l attaque des sons percussifs.\n     * - longSpan (250 ms) : le PREMIER son apres une ouverture (premier\n     *   toucher, reprise de veille). La, il n y a aucune attaque musicale a\n     *   preserver \u2014 c est le debut de tout \u2014 et un vrai fondu est ce qu on\n     *   veut.\n     * Le defaut precedent : le re-armement apres silence ecrasait la rampe\n     * longue par la courte. Mesure a l enveloppe du premier toucher :\n     *     1 3 3 3 5 5 5 4 ...   -> niveau 1 a 5 en 4 cases = 20 ms\n     * alors qu une reprise reussie donne :\n     *     1 1 1 1 1 1 1 1 1 2 2 2 2 3 2 1 2 3 3 4 4 5 5 ...  -> ~150 ms\n     * reopenLong marque qu une ouverture est en cours : le re-armement garde\n     * alors la duree longue. */\n    this.softSpan = (sampleRate * 0.012) | 0;\n    this.longSpan = (sampleRate * 0.250) | 0;\n    this.reopenLong = 0;\n    this.silenceLeft = 0;      /* extinction commandee (veille, changement de page) */\n    this.silenceSpan = 1;\n    this.silenced = 0;\n    /* Pourquoi une dissimulation a demarre. Un seul compteur global ne dit pas\n     * si le flux a manque (famine du FIFO) ou s il a saute (le producteur est\n     * reparti ailleurs). Les deux s entendent pareil, se corrigent autrement. */\n    this.concealUnderruns = 0;\n    this.concealSeams = 0;\n    this.lastPeriod = 0;\n    this.lastScore = 0;\n    this.anomalies = 0;          /* coutures reparees, remonte dans les stats */\n    this.dcxL = 0; this.dcyL = 0;\n    this.dcxR = 0; this.dcyR = 0;\n    this.dcR = 1 - 6.2831853 * 12 / sampleRate; /* passe-haut ~12 Hz */\n    this.voices = [];\n    this.nextId = 1;\n    this.frame = 0;\n    this.maxVoices = opts.maxVoices > 0 ? opts.maxVoices | 0 : 24;\n    if (this.maxVoices < 4) this.maxVoices = 4;\n    if (this.maxVoices > 48) this.maxVoices = 48;\n\n    this.port.onmessage = (event) => {\n      var msg = event.data || {};\n      if (msg.type === \"set-mode\") {\n        this.mode = msg.mode === \"pcm\" ? \"pcm\" : \"inline\";\n        return;\n      }\n      if (msg.type === \"play\") {\n        this.playVoice(msg);\n        return;\n      }\n      if (msg.type === \"stop_all\") {\n        this.voices.length = 0;\n        return;\n      }\n      if (msg.type === \"set_master\") {\n        this.masterTarget = msg.volume >= 0 ? +msg.volume : 1;\n        /* Avant le premier son, aucune raison de glisser : on cale. */\n        if (!this.primed) this.master = this.masterTarget;\n        return;\n      }\n      if (msg.type === \"set-source-port\") {\n        this.sourcePort = msg.port;\n        this.needThreshold = msg.needFrames > 0 ? msg.needFrames | 0 : 2048;\n        this.targetFrames = msg.targetFrames > 0 ? msg.targetFrames | 0 : 4096;\n        this.sourcePort.onmessage = (audioEvent) => {\n          var a = audioEvent.data || {};\n          if (a.type === \"pcm\" && a.samples) {\n            var samples =\n              a.samples instanceof Float32Array\n                ? a.samples\n                : new Float32Array(a.samples);\n            var frames = a.frames | 0;\n            /* Eteint : on ne consomme pas, donc empiler ferait grossir la file\n             * sans fin pendant toute la veille, pour la rejouer au reveil. */\n            /* Jete, mais COMPTE comme recu : sinon le bus le croirait encore\n             * en route et surestimerait sa file pendant toute la veille. */\n            if (this.silenced) { this.rxFrames += frames; return; }\n            /* Perime : compte comme RECU (sinon le bus le croirait encore en\n             * route et surestimerait sa file) mais ne le joue pas. */\n            if (this.acceptAfter >= 0 && (a.at | 0) < this.acceptAfter) {\n              this.rxFrames += frames; return;\n            }\n            if (frames > 0) {\n              this.blocks.push({ samples: samples, frames: frames });\n              this.queuedFrames += frames;\n              this.rxFrames += frames;\n              if (this._needSent) {\n                this.fillWaitLastFrames =\n                  this.renderFrames - this.needSentAtFrame;\n                if (this.fillWaitLastFrames > this.fillWaitMaxFrames)\n                  this.fillWaitMaxFrames = this.fillWaitLastFrames;\n              }\n              this._needSent = false;\n              /* First PCM block \u2192 audible immediately (unlock fade covers onset).\n               * Waiting for a deep needThreshold caused multi-second silence on\n               * Android ScriptProcessor when the main thread was busy. */\n              this.primed = true;\n            }\n          } else if (a.type === \"flush\") {\n            /* Drop stale pre-buffered silence so a newly played bird starts at\n             * the next render quantum instead of behind ~170 ms of FIFO. */\n            this.blocks.length = 0;\n            this.current = null;\n            this.offset = 0;\n            this.queuedFrames = 0;\n            this._needSent = false;\n            this.bufferBoostFrames = 0;\n            /* An idle queue ends at zero, so the exact tweet attack can pass\n             * unchanged. Keep the de-zipper only for a real discontinuity. */\n            this.crossfadeLeft =\n              Math.max(Math.abs(this.lastOutL), Math.abs(this.lastOutR)) > 1e-4\n                ? this.crossfadeFrames\n                : 0;\n            this.crossfadeFromL = this.lastOutL;\n            this.crossfadeFromR = this.lastOutR;\n          } else if (a.type === \"trim\") {\n            /* Idle look-ahead is stale silence. Drop the tail but keep a\n             * cushion, so latency collapses without starving the sink. */\n            this.trimQueue(a.keepFrames | 0);\n          }\n        };\n        this.sourcePort.start();\n        if (this.mode === \"pcm\") this.requestFill(true);\n        return;\n      }\n      /* EXTINCTION FRANCHE POUR LA MISE EN VEILLE.\n       *\n       * Au verrouillage du telephone, le bus lance une rampe de gain de 55 ms\n       * puis attend. Mais pendant ces 55 ms le producteur, lui, est deja en\n       * train de se faire geler : le FIFO se vide, la dissimulation demarre, et\n       * c est CA qu on entend au moment ou l ecran s eteint. Le puits doit\n       * pouvoir se taire tout seul, sans dependre de ce qui se passe en amont.\n       * Une fois eteint il emet du silence franc \u2014 pas de dissimulation, pas de\n       * famine comptee. reset-latency le reveille. */\n      if (msg.type === \"selftest\") {\n        this.selfTest = msg.hz > 0 ? 1 : 0;\n        this.selfInc = msg.hz > 0 ? (6.283185307179586 * msg.hz / sampleRate) : 0;\n        this.selfPhase = 0;\n        return;\n      }\n      if (msg.type === \"simple\") {\n        /* Mode simple : plus aucune reparation, plus aucune rampe interne.\n         * Le puits joue ce qu il recoit, et rien d autre. */\n        this.simple = msg.on ? 1 : 0;\n        this.reopenArmed = 0; this.reopenLong = 0;\n        this.concealOn = 0; this.spliceLeft = 0;\n        return;\n      }\n      if (msg.type === \"output-muted\") {\n        this.outMuted = msg.muted ? 1 : 0;\n        return;\n      }\n      if (msg.type === \"reopen-ramp\") {\n        this.longSpan = msg.frames > 0 ? msg.frames | 0 : this.longSpan;\n        this.reopenSpan = this.longSpan;\n        this.reopenLeft = this.longSpan;\n        this.reopenStarted = 0;\n        this.reopenArmed = 1;\n        this.reopenLong = 1;   /* une ouverture est en cours */\n        return;\n      }\n      if (msg.type === \"silence-now\") {\n        this.silenceLeft = msg.frames > 0 ? msg.frames | 0 : 2400;\n        this.silenceSpan = this.silenceLeft;\n        return;\n      }\n      if (msg.type === \"set-thresholds\") {\n        if (msg.needFrames > 0) this.needThreshold = msg.needFrames | 0;\n        if (msg.targetFrames > 0) this.targetFrames = msg.targetFrames | 0;\n        return;\n      }\n      if (msg.type === \"forget\") {\n        this.forgetHistory();\n        return;\n      }\n      if (msg.type === \"wake\") {\n        /* Seul ordre qui annule une extinction commandee. reset-latency ne le\n         * fait PLUS : il arrive au milieu de la rampe d extinction de la mise\n         * en veille, et remettre le gain a 1 en plein milieu d une rampe est\n         * une marche de signal \u2014 un clic franc, exactement au moment ou l ecran\n         * s eteint. */\n        this.silenceLeft = 0;\n        this.silenced = 0;\n        this.forgetHistory();\n        return;\n      }\n      if (msg.type === \"reset-latency\") {\n        if (msg.after >= 0) this.acceptAfter = msg.after | 0;\n        this.forgetHistory();\n        this.blocks.length = 0;\n        this.current = null;\n        this.offset = 0;\n        this.queuedFrames = 0;\n        this._needSent = false;\n        this.bufferBoostFrames = 0;\n        this.healthyQuanta = 0;\n        this.gapFrames = 0;\n        this.crossfadeLeft = 0;\n        this.unlockGain = 0;\n        this.unlockActive = this.unlockFadeSec > 0;\n        this.primed = false;\n        if (this.mode === \"pcm\") this.requestFill(true);\n        return;\n      }\n    };\n  }\n\n  /* EFFACER LA MATIERE D AVANT LA VEILLE.\n   *\n   * histL/histR gardent les deux dernieres secondes de sortie. Apres un\n   * verrouillage de plusieurs minutes elles contiennent encore l audio d avant\n   * \u2014 et la premiere famine venue les rejoue. Un fragment de musique d il y a\n   * dix minutes ressorti a plein niveau, ce n est pas un clic : c est le gros\n   * glitch desagreable. On efface donc tout ce qui pourrait etre ressuscite. */\n  forgetHistory() {\n    this.histL.fill(0);\n    this.histR.fill(0);\n    this.histW = 0;\n    this.lastOutL = 0; this.lastOutR = 0;\n    this.prevOutL = 0; this.prevOutR = 0;\n    /* meanDelta N EST PAS de la matiere : c est l ECHELLE d agitation du\n     * signal, et elle ne change pas parce qu on a vide une file. La remettre a\n     * zero effondrait le seuil de couture a son plancher absolu (0.012), et les\n     * premiers joints de blocs d une vraie musique le franchissaient tous.\n     * Le detecteur declarait alors des discontinuites qui n existaient pas, et\n     * les \u00ab reparait \u00bb par un fondu de 5 ms contre un echantillon fige \u2014 LA\n     * REPARATION ETAIT L ARTEFACT. Mesure : sauts=1 cote source contre\n     * coutures=4 dissim=0f/4s cote puits, toutes apres un reset-latency.\n     * On garde donc l echelle, et on desarme le detecteur 100 ms \u2014 le temps que\n     * la prediction lineaire ait de nouveau deux echantillons reels sur quoi\n     * s appuyer. Un vrai saut dans cette fenetre reste couvert par la rampe de\n     * reprise, qui part de zero. */\n    this.seamWarm = (sampleRate * 0.1) | 0;\n    this.concealOn = 0;\n    this.concealTonal = 0;\n    this.concealDecay = 0;\n    this.spliceLeft = 0;\n    this.crossfadeLeft = 0;\n    this.gapFrames = 0;\n  }\n\n  envelopDecaySeconds(envelop) {\n    if (!(envelop > 1e-6)) return 0.5;\n    var d = Math.log(0.001) / -envelop;\n    if (!isFinite(d) || d < 0) return 0.5;\n    if (d > 4) return 4;\n    return d;\n  }\n\n  playVoice(desc) {\n    if (this.voices.length >= this.maxVoices) this.voices.shift();\n    var fadein = desc.fadein >= 0 ? +desc.fadein : 0.0000006;\n    if (fadein < 0) fadein = 0;\n    var envelop = desc.envelop >= 0 ? +desc.envelop : 8.0;\n    var duration = desc.duration > 0 ? +desc.duration : 0.08;\n    var decay = this.envelopDecaySeconds(envelop);\n    this.voices.push({\n      id: this.nextId++,\n      start: this.frame + (desc.startOffsetFrames | 0),\n      duration: duration,\n      totalLife: duration + decay,\n      volume: desc.volume >= 0 ? +desc.volume : 0.6,\n      fadein: fadein,\n      envelop: envelop,\n      freqX: desc.freqX != null ? +desc.freqX : 2.0,\n      freqY: desc.freqY != null ? +desc.freqY : 4.0,\n      freqZ: desc.freqZ != null ? +desc.freqZ : 0.0,\n      type: desc.soundType === \"tone\" ? \"tone\" : \"tweet\",\n      phase: 0\n    });\n    this.primed = true;\n  }\n\n  hash1(p) {\n    var p2x = (p * 5.3983) % 1;\n    if (p2x < 0) p2x += 1;\n    var p2y = (p * 5.4427) % 1;\n    if (p2y < 0) p2y += 1;\n    var d = p2y * (p2x + 21.5351) + p2x * (p2y + 14.3137);\n    p2x += d;\n    p2y += d;\n    var r = (p2x * p2y * 95.4337) % 1;\n    return r < 0 ? r + 1 : r;\n  }\n  noise(n) {\n    var f = n - Math.floor(n);\n    n = Math.floor(n);\n    f = f * f * (3.0 - 2.0 * f);\n    return this.hash1(n) * (1 - f) + this.hash1(n + 1) * f - 0.5;\n  }\n  noiseSlope(n, loc) {\n    var f = n - Math.floor(n);\n    n = Math.floor(n);\n    if (loc <= 0) f = f >= 1 ? 1 : 0;\n    else {\n      f = f / loc;\n      if (f < 0) f = 0;\n      if (f > 1) f = 1;\n      f = f * f * (3 - 2 * f);\n    }\n    return this.hash1(n) * (1 - f) + this.hash1(n + 1) * f;\n  }\n  smoothstep(edge0, edge1, x) {\n    var t = (x - edge0) / (edge1 - edge0);\n    if (t < 0) t = 0;\n    if (t > 1) t = 1;\n    return t * t * (3 - 2 * t);\n  }\n  tweetVolume(t) {\n    var n1 = this.noiseSlope(t * 11.0, 0.3);\n    var n2 = this.smoothstep(0.0, 1.0, Math.abs(Math.sin(t * 14.0)));\n    var n3 = this.smoothstep(0.4, 0.9, this.noiseSlope(t * 0.5 + 4.0, 0.3));\n    var n = n1 * n2 * 0.2 * n3;\n    n = n * n;\n    if (n < 0) n = 0;\n    if (n > 1) n = 1;\n    return n;\n  }\n  /* Full Shadertoy FM - desktop. Aliases hard above ~Nyquist/4. */\n  tweetHeavy(t) {\n    t = t - 1.5;\n    var f =\n      Math.sin(6.2831 * 2.0 * t) * this.noise(t * 8.1 - 100.0) * 100.0 + 5000.0;\n    f += Math.cos(50.0 * 6.2831 * t);\n    return Math.sin(6.2831 * f * t);\n  }\n  sampleTweetHeavy(t, freqX, freqY) {\n    var volume = this.tweetVolume((t + freqY - 0.5) * 0.6) * 20.0;\n    /* Match tweet.sound exactly; final device mixing performs the clamp. */\n    return this.tweetHeavy((t + freqX) * 0.4) * volume;\n  }\n  /* Mobile: phase-accum chirp in bird range (1.8\u20134.5 kHz), same gate feel. */\n  sampleTweetLight(t, freqX, freqY, voice, dt) {\n    var gate = this.tweetVolume((t + freqY * 0.08) * 0.6);\n    if (gate < 1e-4) {\n      voice.phase = 0;\n      return 0;\n    }\n    /* Phrase offset without jumping into chaotic FM region. */\n    var phrase = (freqX * 0.015) % 0.4;\n    var tt = t + phrase;\n    var sweep =\n      1900 +\n      2200 * (0.5 + 0.5 * Math.sin(tt * 16.0 + freqX * 0.25)) +\n      350 * Math.sin(tt * 37.0);\n    if (sweep > 4500) sweep = 4500;\n    if (sweep < 1200) sweep = 1200;\n    voice.phase += sweep * dt;\n    if (voice.phase > 1e6) voice.phase -= 1e6;\n    var sig = Math.sin(6.28318530718 * voice.phase);\n    sig *= 0.6 + 0.4 * Math.sin(tt * 42.0);\n    return sig * gate * 0.55;\n  }\n  panSimple(pos) {\n    if (pos > 1.25) pos = 1.25;\n    if (pos < -1.25) pos = -1.25;\n    var e0 = 1 - pos,\n      e1 = 1 + pos;\n    var len = Math.sqrt(e0 * e0 + e1 * e1);\n    if (len < 1e-8) return [0.707, 0.707];\n    return [e0 / len, e1 / len];\n  }\n  envelope(t, v) {\n    if (t < 0 || t > v.totalLife) return 0;\n    var e = t < v.duration ? 1.0 : Math.exp(-v.envelop * (t - v.duration));\n    if (v.fadein > 1e-12 && t < v.fadein) e *= t / v.fadein;\n    return e < 0 ? 0 : e > 1 ? 1 : e;\n  }\n\n  /* Keep the oldest `keep` frames (rounded up to a block) and drop the rest.\n   * Playback stays sample-continuous \u2014 only not-yet-heard tail is discarded. */\n  trimQueue(keepFrames) {\n    var keep = keepFrames > 0 ? keepFrames | 0 : 0;\n    var kept = this.current ? this.current.frames - this.offset : 0;\n    var i = 0;\n    if (kept < 0) kept = 0;\n    if (this.queuedFrames <= keep) return;\n    while (i < this.blocks.length && kept < keep) {\n      kept += this.blocks[i].frames;\n      i++;\n    }\n    if (i < this.blocks.length) this.blocks.length = i;\n    this.queuedFrames = kept;\n    this._needSent = false;\n  }\n\n  requestFill(force) {\n    var effectiveNeed;\n    if (this.mode !== \"pcm\" || !this.sourcePort) return;\n    effectiveNeed = this.needThreshold + (this.bufferBoostFrames >> 1);\n    if (this.queuedFrames >= effectiveNeed) {\n      this._needSent = false;\n      return;\n    }\n    if (this._needSent && (this.renderFrames - this.needSentAtFrame) < 384) return;\n    this._needSent = true;\n    this.needSentAtFrame = this.renderFrames;\n    this.sourcePort.postMessage({\n      type: \"need\",\n      queuedFrames: this.queuedFrames | 0,\n      needFrames: effectiveNeed | 0,\n      targetFrames: (this.targetFrames + this.bufferBoostFrames) | 0\n    });\n  }\n\n  /* Rampe de volume maitre pour le bloc courant, un point par echantillon. */\n  updateMasterRamp(n) {\n    var i, m = this.master, t = this.masterTarget, s = this.masterSlew;\n    if (!this.masterRamp || this.masterRamp.length < n)\n      this.masterRamp = new Float32Array(n);\n    for (i = 0; i < n; i++) {\n      if (m < t) { m += s; if (m > t) m = t; }\n      else if (m > t) { m -= s; if (m < t) m = t; }\n      this.masterRamp[i] = m;\n    }\n    this.master = m;\n  }\n\n  /* --- historique de sortie : la matiere premiere de la dissimulation --- */\n  pushHistory(l, r) {\n    this.histL[this.histW] = l;\n    this.histR[this.histW] = r;\n    this.histW = (this.histW + 1) % this.histLen;\n  }\n  histAt(buf, back) {\n    var idx = this.histW - back;\n    while (idx < 0) idx += this.histLen;\n    return buf[idx % this.histLen];\n  }\n  /* Delai FRACTIONNAIRE. Une periode reelle tombe presque jamais sur un nombre\n   * entier d echantillons : 440 Hz a 48 kHz font 109.09. Boucler sur 109 rejoue\n   * un dixieme d echantillon de decalage a chaque tour, ce qui se paie en\n   * cassure de pente au raccord. L interpolation lineaire supprime ce residu. */\n  histAtF(buf, backF) {\n    var i0 = Math.floor(backF), f = backF - i0;\n    return this.histAt(buf, i0) * (1 - f) + this.histAt(buf, i0 + 1) * f;\n  }\n\n  /* Periode dominante par autocorrelation normalisee, passe grossiere au pas\n   * de 4 puis affinage. Ne tourne QU AU DEMARRAGE d une dissimulation, jamais\n   * en regime nominal : le cout ne touche pas le budget temps reel courant. */\n  detectPeriod() {\n    /* LOMIN etait a 32 echantillons, soit 1500 Hz. Sur un signal bref ou\n     * bruite, l autocorrelation trouve une fausse periodicite courte, et la\n     * repeter EN BOUCLE ne dissimule pas un trou : ca SYNTHETISE une tonalite\n     * pure a cette frequence. C est la cause des \u00ab petits sons aigus \u00bb \u2014\n     * fabriques par le filtre cense les eviter. Plancher a 160 echantillons\n     * (300 Hz) : au-dessous, aucune boucle n est credible pour ce contenu. */\n    var W = 512, LOMIN = 160, LOMAX = 800;\n    var best = 0, bestScore = -1e9, lag, i, s, e0, e1, a, b, sc, lo, hi;\n    var coarse = [], coarseSc = [];\n    if (LOMAX + W > this.histLen) LOMAX = this.histLen - W;\n    for (lag = LOMIN; lag <= LOMAX; lag += 4) {\n      s = 0; e0 = 1e-9; e1 = 1e-9;\n      for (i = 0; i < W; i += 2) {\n        a = this.histAt(this.histL, i + 1);\n        b = this.histAt(this.histL, i + 1 + lag);\n        s += a * b; e0 += a * a; e1 += b * b;\n      }\n      sc = s / Math.sqrt(e0 * e1);\n      if (sc > bestScore) { bestScore = sc; best = lag; }\n      coarse.push(lag); coarseSc.push(sc);\n    }\n    /* Ambiguite d octave : les MULTIPLES de la vraie periode correlent aussi\n     * bien. Mais la regle precedente - prendre le plus petit lag a 2 % du\n     * meilleur - est fausse sur du contenu large bande : beaucoup de lags s y\n     * valent, donc elle retombait TOUJOURS sur le plancher. Mesure dans les\n     * journaux : periode=160, le plancher exact, avec un score de 0.92, encore\n     * et encore. Boucler un contenu non periodique sur 160 echantillons, c est\n     * synthetiser un bourdon a 300 Hz - le petit son aigu.\n     * On ne retient un sous-multiple que s il en est vraiment un : score quasi\n     * egal ET division entiere. */\n    for (i = 0; i < coarse.length; i++) {\n      var cand = coarse[i], ratio;\n      if (coarseSc[i] < bestScore - 0.01) continue;\n      ratio = best / cand;\n      if (Math.abs(ratio - Math.round(ratio)) < 0.06) { best = cand; break; }\n    }\n    lo = best - 4; hi = best + 4;\n    if (lo < LOMIN + 1) lo = LOMIN + 1;\n    if (hi > LOMAX - 1) hi = LOMAX - 1;\n    var scores = {};\n    for (lag = lo; lag <= hi; lag++) {\n      s = 0; e0 = 1e-9; e1 = 1e-9;\n      for (i = 0; i < W; i++) {\n        a = this.histAt(this.histL, i + 1);\n        b = this.histAt(this.histL, i + 1 + lag);\n        s += a * b; e0 += a * a; e1 += b * b;\n      }\n      sc = s / Math.sqrt(e0 * e1);\n      scores[lag] = sc;\n      if (sc > bestScore) { bestScore = sc; best = lag; }\n    }\n    /* Sommet sub-echantillon : parabole sur les trois points autour du max. */\n    var sm = scores[best - 1], s0 = scores[best], sp = scores[best + 1];\n    var frac = 0, den;\n    if (sm !== undefined && sp !== undefined) {\n      den = sm - 2 * s0 + sp;\n      if (den < -1e-9 || den > 1e-9) {\n        frac = 0.5 * (sm - sp) / den;\n        if (frac < -0.5) frac = -0.5;\n        if (frac > 0.5) frac = 0.5;\n      }\n    }\n    this.concealPeriodF = best + frac;\n    /* Correlation trop faible = signal aperiodique (bruit, percussion). Repeter\n     * une periode inventee sonnerait faux : on retombe sur une fenetre courte,\n     * qui se comporte alors comme un simple fondu de texture. */\n    this.concealScore = bestScore;\n    if (bestScore < 0.30) { best = 256; this.concealPeriodF = 256; }\n    return best;\n  }\n\n  /* DISSIMULATION NON GENERATRICE PAR DEFAUT.\n   *\n   * Prolonger la forme d onde en repetant sa derniere periode ne marche que si\n   * le signal EST periodique. Sinon on n habille pas un trou : on FABRIQUE une\n   * note qui n a jamais existe, et c est exactement ce que l oreille remarque.\n   * Trois fois de suite les artefacts aigus signales venaient de la, pas du\n   * flux. La regle est donc inversee : par defaut on s eteint doucement, et on\n   * n etend periodiquement que si la periodicite est FLAGRANTE - correlation\n   * >= 0.85 et periode franchement au-dessus du plancher de detection.\n   *\n   * Un trou de 8 ms comble par une extinction douce est inaudible. Un bourdon\n   * de 80 ms a 300 Hz ne l est pas. */\n  beginConceal(cause) {\n    this.concealScore = 0;\n    this.concealPeriod = this.detectPeriod();\n    /* Pendant une ouverture, jamais de continuation tonale : boucler une\n     * periode inventee y produisait le bourdon entendu apres chaque reprise.\n     * On garde le raccord court, qui lisse le joint sans rien fabriquer. */\n    this.concealTonal = this.reopenLong ? 0 :\n      ((this.concealScore >= 0.85 && this.concealPeriodF > 176) ? 1 : 0);\n    /* Une correlation faible veut dire \u00ab ce signal n est pas periodique \u00bb.\n     * Le prolonger longtemps inventerait une note qui n a jamais existe. On\n     * raccourcit alors le fondu a 20 ms : assez pour masquer la couture,\n     * trop court pour etre entendu comme une hauteur. */\n    this.concealFadeFrames = this.concealTonal\n      ? this.concealFadeLong : this.concealFadeShort;\n    /* Silence en entree = rien a prolonger. Boucler du bruit de fond a bas\n     * niveau produit un souffle module tres reconnaissable. */\n    {  var e = 0, i, n = 256;\n       for (i = 1; i <= n; i++) { var v = this.histAt(this.histL, i); e += v * v; }\n       if (e / n < 1e-8) this.concealFadeFrames = 64;\n    }\n    this.concealPos = 0;\n    this.concealFrames = 0;\n    this.concealDecay = 1;\n    this.concealOn = 1;\n    if (cause === 2) this.concealSeams++; else this.concealUnderruns++;\n    this.lastPeriod = this.concealPeriod | 0;\n    this.lastScore = this.concealScore;\n  }\n\n  /* Continuation : on lit TOUJOURS une periode en arriere du pointeur\n   * d ecriture. Comme on reinjecte dans l historique ce qu on vient de lire, la\n   * boucle se referme d elle-meme, periode apres periode, sans coupure et sans\n   * accumuler la decroissance dans la matiere. */\n  concealSource(buf) {\n    /* Tonal : on relit une periode en arriere, la boucle se referme d elle-meme.\n     * Sinon : on gele le dernier echantillon emis, et c est la decroissance qui\n     * fait tout le travail. Continue en valeur, et surtout : rien d invente. */\n    if (this.concealTonal) return this.histAtF(buf, this.concealPeriodF);\n    return buf === this.histL ? this.lastOutL : this.lastOutR;\n  }\n  concealAdvance() {\n    var t;\n    this.concealPos++;\n    this.concealFrames++;\n    t = this.concealFrames / this.concealFadeFrames;\n    if (t > 1) t = 1;\n    t = 1 - t;\n    this.concealDecay = t * t * (3.0 - 2.0 * t);\n  }\n\n  /* Seuil de couture : proportionnel a l agitation recente du signal, jamais\n   * sous un plancher absolu. Un sinus calme a un meanDelta minuscule, une\n   * texture dense en a un gros \u2014 le meme seuil fixe serait soit sourd soit\n   * paranoiaque. */\n  spliceThreshold() {\n    return 0.012 + 3.0 * this.meanDelta;\n  }\n\n  /* Saturation douce : le chemin PCM n avait AUCUNE limite. Tout depassement\n   * partait en ecretage dur du navigateur, qui s entend comme un craquement.\n   * Valeur et pente continues en 0.9, asymptote a 1.0. */\n  softClip(v) {\n    var s, a;\n    if (v <= 0.9 && v >= -0.9) return v;\n    s = v < 0 ? -1 : 1;\n    a = v * s;\n    return s * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1));\n  }\n\n  processInline(left, right, n) {\n    var sr = sampleRate;\n    var dt = 1.0 / sr;\n    var i, vi, v, t, env, sig, pan, g, absFrame, endFrame;\n    var still = [];\n    this.updateMasterRamp(n);\n    for (i = 0; i < n; i++) {\n      left[i] = 0;\n      right[i] = 0;\n    }\n    for (vi = 0; vi < this.voices.length; vi++) {\n      v = this.voices[vi];\n      endFrame = v.start + Math.ceil(v.totalLife * sr);\n      if (this.frame >= endFrame) continue;\n      still.push(v);\n      /* Legacy tweet.sound writes the same signal to both channels and ignores\n       * freq.z. Keep panning only for tone/mobile voices. */\n      pan = v.type === \"tweet\" && !this.lightSynth ? [1.0, 1.0] : this.panSimple(v.freqZ);\n      for (i = 0; i < n; i++) {\n        absFrame = this.frame + i;\n        if (absFrame < v.start) continue;\n        t = (absFrame - v.start) * dt;\n        if (v.type === \"tweet\") t *= this.legacyTimeScale;\n        env = this.envelope(t, v);\n        if (env <= 1e-5) continue;\n        if (v.type === \"tone\")\n          sig = Math.sin(6.28318530718 * (v.freqX > 20 ? v.freqX : 440) * t) * 0.15;\n        else if (this.lightSynth)\n          sig = this.sampleTweetLight(t, v.freqX, v.freqY, v, dt);\n        else sig = this.sampleTweetHeavy(t, v.freqX, v.freqY);\n        g = sig * v.volume * env * this.masterRamp[i];\n        left[i] += g * pan[0];\n        right[i] += g * pan[1];\n      }\n    }\n    this.voices = still;\n    for (i = 0; i < n; i++) {\n      if (left[i] > 1) left[i] = 1;\n      else if (left[i] < -1) left[i] = -1;\n      if (right[i] > 1) right[i] = 1;\n      else if (right[i] < -1) right[i] = -1;\n    }\n    this.frame += n;\n  }\n\n  processPcm(left, right, n) {\n    var i, si, rawL, rawR, phase, fade;\n    for (i = 0; i < n; i++) {\n      if (!this.current || this.offset >= this.current.frames) {\n        this.current = this.blocks.length ? this.blocks.shift() : null;\n        this.offset = 0;\n      }\n      if (!this.current) {\n        if (this.primed && !this.silenced && !this.unlockActive && !this.outMuted) {\n          if (this.gapFrames === 0) {\n            this.underruns++;\n            this.gapStartL = this.lastOutL;\n            this.gapStartR = this.lastOutR;\n            /* Grow look-ahead only after a real starvation event. */\n            /* Cap \u2014 muted warm-up must not inflate to 16k. */\n            this.bufferBoostFrames += 256;\n            if (this.bufferBoostFrames > 1024) this.bufferBoostFrames = 1024;\n            this.healthyQuanta = 0;\n          }\n          this.gapFrames++;\n          this.underrunFrames++;\n          if (this.gapFrames > this.maxGapFrames)\n            this.maxGapFrames = this.gapFrames;\n          /* Trou : on PROLONGE la forme d onde au lieu de figer le dernier\n           * echantillon puis de fondre. Maintenir une valeur constante casse la\n           * pente (le signal cessait brutalement de suivre l onde) ; repeter la\n           * derniere periode garde la hauteur, le timbre et la continuite. */\n          if (this.simple) { left[i] = 0; right[i] = 0; continue; }\n          if (!this.concealOn) this.beginConceal(1);\n          var cl = this.concealSource(this.histL);\n          var cr = this.concealSource(this.histR);\n          this.pushHistory(cl, cr);   /* brut : la boucle reste vivante */\n          left[i] = cl * this.concealDecay;\n          right[i] = cr * this.concealDecay;\n          this.concealAdvance();\n          this.prevOutL = this.lastOutL; this.lastOutL = left[i];\n          this.prevOutR = this.lastOutR; this.lastOutR = right[i];\n          continue;\n        }\n        left[i] = 0.0;\n        right[i] = 0.0;\n        this.prevOutL = this.lastOutL; this.lastOutL = 0.0;\n        this.prevOutR = this.lastOutR; this.lastOutR = 0.0;\n        this.pushHistory(0.0, 0.0);\n        continue;\n      }\n      si = this.offset * 2;\n      rawL = this.current.samples[si];\n      rawR = this.current.samples[si + 1];\n\n      /* Sortie de trou : on ne coupe pas la dissimulation, on fond dedans. */\n      if (this.gapFrames > 0) {\n        this.spliceLeft = this.spliceFrames;\n        this.gapFrames = 0;\n      } else if (this.offset === 0 && this.primed && !this.concealOn\n                 && this.spliceLeft <= 0 && this.seamWarm <= 0\n                 && !this.simple) {\n        /* LE DETECTEUR EST REMIS EN SERVICE PENDANT LES OUVERTURES.\n         * Je l avais coupe la parce que sa REPARATION etait mauvaise (une\n         * boucle tonale de 80 ms). Mais la detection, elle, etait juste : le\n         * sinus d etalonnage montre \u00ab frames>0.01=2 \u00bb et \u00ab ecart max=0.01245 \u00bb\n         * a chaque reprise \u2014 deux echantillons faux au joint, soit 7 % de la\n         * crete. C est un petit tic, et c est moi qui l avais laisse passer.\n         * Cote source : sauts=8 max=0.326 au re-ancrage, meme cause.\n         * On repare donc a nouveau, mais JAMAIS en synthetisant (voir\n         * beginConceal) : un simple raccord court, qui ne peut rien inventer. */\n        /* PENDANT UNE OUVERTURE, LE DETECTEUR NE PEUT QUE NUIRE.\n         * Mesure : dissim=0f/5s \u2014 cinq dissimulations, une par reprise, avec\n         * periode=372@0.97T. Le T veut dire qu il a juge le signal periodique\n         * et BOUCLE une periode inventee pendant 80 ms, a mi-rampe donc\n         * parfaitement audible. C est la petite coupure entendue apres chaque\n         * reprise : la musique remplacee par une boucle synthetique.\n         * Or apres un re-ancrage les premiers joints sont LEGITIMEMENT\n         * discontinus, et la rampe d ouverture les couvre deja par\n         * construction. On desarme donc le detecteur tant qu elle tourne. */\n        /* JOINT entre deux blocs : le seul endroit ou le flux peut sauter.\n         * Prediction lineaire depuis les deux derniers echantillons emis ;\n         * un ecart trop grand veut dire que le producteur a change d avis\n         * (re-ancrage apres suspension, flush, changement de page). */\n        var predL = 2 * this.lastOutL - this.prevOutL;\n        var predR = 2 * this.lastOutR - this.prevOutR;\n        var dev = Math.abs(rawL - predL);\n        var devR = Math.abs(rawR - predR);\n        if (devR > dev) dev = devR;\n        /* Une attaque qui demarre DEPUIS LE SILENCE est un vrai transitoire,\n         * pas une couture : la lisser reviendrait a emousser tous les SFX. On\n         * n intervient que si quelque chose sonnait deja. */\n        var lvl = Math.abs(this.lastOutL);\n        if (Math.abs(this.lastOutR) > lvl) lvl = Math.abs(this.lastOutR);\n        if (lvl > 0.02 && dev > this.spliceThreshold()) {\n          this.anomalies++;\n          this.beginConceal(2);\n          this.spliceLeft = this.spliceFrames;\n        }\n      }\n\n      if (this.crossfadeLeft > 0) {\n        phase = 1.0 - this.crossfadeLeft / this.crossfadeFrames;\n        phase = phase * phase * (3.0 - 2.0 * phase);\n        left[i] = this.crossfadeFromL * (1.0 - phase) + rawL * phase;\n        right[i] = this.crossfadeFromR * (1.0 - phase) + rawR * phase;\n        this.crossfadeLeft--;\n      } else if (this.spliceLeft > 0) {\n        /* Fondu a PUISSANCE CONSTANTE entre la continuation et le vrai signal.\n         * Un fondu lineaire entre deux signaux dephases se creuse au milieu\n         * (annulation partielle) : on l entend comme un petit trou. */\n        var w = 1.0 - this.spliceLeft / this.spliceFrames;\n        var wr = Math.sqrt(w), wc = Math.sqrt(1.0 - w);\n        wc *= this.concealDecay;\n        left[i] = this.concealSource(this.histL) * wc + rawL * wr;\n        right[i] = this.concealSource(this.histR) * wc + rawR * wr;\n        this.concealAdvance();\n        this.spliceLeft--;\n        if (this.spliceLeft <= 0) this.concealOn = 0;\n      } else {\n        this.concealOn = 0;\n        left[i] = rawL;\n        right[i] = rawR;\n      }\n      left[i] = this.softClip(left[i]);\n      right[i] = this.softClip(right[i]);\n      this.prevOutL = this.lastOutL;\n      this.prevOutR = this.lastOutR;\n      this.lastOutL = left[i];\n      this.lastOutR = right[i];\n      this.pushHistory(left[i], right[i]);\n      {  var md = Math.abs(this.lastOutL - this.prevOutL);\n         this.meanDelta = this.meanDelta * 0.999 + md * 0.001; }\n      if (this.seamWarm > 0) this.seamWarm--;\n      this.offset++;\n      this.queuedFrames--;\n      if (this.queuedFrames < 0) this.queuedFrames = 0;\n      if (this.primed && this.queuedFrames < this.minQueuedFrames)\n        this.minQueuedFrames = this.queuedFrames;\n    }\n  }\n\n  process(inputs, outputs) {\n    var output = outputs[0];\n    var left = output[0];\n    var right = output[1] || output[0];\n    var n = left.length;\n    var si, sg;\n\n    /* Deja eteint : on ne touche meme pas au FIFO. Aucune famine ne peut etre\n     * declaree, aucune dissimulation ne peut demarrer. */\n    if (this.silenced) {\n      for (si = 0; si < n; si++) { left[si] = 0; right[si] = 0; }\n      this.lastOutL = 0; this.lastOutR = 0;\n      this.prevOutL = 0; this.prevOutR = 0;\n      this.renderFrames += n;\n      return true;\n    }\n\n    if (this.mode === \"inline\") this.processInline(left, right, n);\n    else this.processPcm(left, right, n);\n\n    /* Le contenu vient du fil audio, pas du fil principal. */\n    if (this.selfTest) {\n      var sti, stv;\n      for (sti = 0; sti < n; sti++) {\n        stv = 0.25 * Math.sin(this.selfPhase);\n        this.selfPhase += this.selfInc;\n        if (this.selfPhase > 6.283185307179586) this.selfPhase -= 6.283185307179586;\n        left[sti] = stv; right[sti] = stv;\n      }\n      this.lastOutL = left[n - 1]; this.lastOutR = right[n - 1];\n      this.prevOutL = left[n - 2]; this.prevOutR = right[n - 2];\n    }\n\n    /* Extinction commandee : rampe douce, puis silence franc. */\n    if (this.silenceLeft > 0) {\n      for (si = 0; si < n && this.silenceLeft > 0; si++) {\n        sg = this.silenceLeft / this.silenceSpan;\n        sg = sg * sg * (3.0 - 2.0 * sg);\n        left[si] *= sg; right[si] *= sg;\n        this.silenceLeft--;\n      }\n      for (; si < n; si++) { left[si] = 0; right[si] = 0; }\n      if (this.silenceLeft <= 0) {\n        this.silenced = 1;\n        this.concealOn = 0;\n        this.spliceLeft = 0;\n      }\n      this.lastOutL = left[n - 1];\n      this.lastOutR = right[n - 1];\n    }\n\n    if (this.unlockActive) {\n      var step = 1.0 / (this.unlockFadeSec * sampleRate);\n      var i, g;\n      for (i = 0; i < n; i++) {\n        this.unlockGain += step;\n        if (this.unlockGain >= 1) {\n          this.unlockGain = 1;\n          this.unlockActive = false;\n          break;\n        }\n        g = this.unlockGain;\n        left[i] *= g;\n        right[i] *= g;\n      }\n    }\n\n    /* Fondu d ouverture : tant que rien ne sonne, on ne consomme pas la rampe.\n     * Elle couvre ainsi l attaque reelle, quel que soit le retard du flux. */\n    if (!this.simple) {\n      var ri, ra, rb, rg;\n      for (ri = 0; ri < n; ri++) {\n        ra = left[ri] < 0 ? -left[ri] : left[ri];\n        rb = right[ri] < 0 ? -right[ri] : right[ri];\n        if (rb > ra) ra = rb;\n        /* Comptage du silence : au-dela du seuil on rearme un fondu court. */\n        if (ra < 0.002) {\n          this.quietRun++;\n          if (this.quietRun === this.quietArm) {\n            /* Une ouverture en cours garde sa duree longue : c est justement\n             * le silence d attente du flux qui la declenche. */\n            this.reopenSpan = this.reopenLong ? this.longSpan : this.softSpan;\n            this.reopenLeft = this.reopenSpan;\n            this.reopenArmed = 1;\n          }\n          continue;\n        }\n        this.quietRun = 0;\n        if (!this.reopenArmed) continue;\n        /* La rampe n avance QUE sur du signal franc. Le seuil precedent\n         * (0.002) etait franchi par le pre-bruit qui precede la musique : la\n         * rampe s y consommait entierement et l attaque reelle entrait ensuite\n         * a gain 1, en marche. Mesure a l enveloppe : plateau a 1-2 pendant\n         * 110 ms puis saut direct a 5. A 0.02 la rampe est garantie de couvrir\n         * la vraie attaque ; ce qui est plus faible reste attenue, donc\n         * inaudible de toute facon. */\n        if (ra > 0.02) {\n          this.reopenLeft--;\n          if (this.reopenLeft <= 0) {\n            this.reopenArmed = 0;\n            this.reopenLong = 0;   /* ouverture terminee */\n            continue;\n          }\n        }\n        rg = 1 - this.reopenLeft / this.reopenSpan;\n        rg = rg * rg * (3.0 - 2.0 * rg);\n        left[ri] *= rg; right[ri] *= rg;\n      }\n    }\n\n    this.renderFrames += n;\n    if (this.mode === \"pcm\") {\n      /* Re-ask every quantum while below target \u2014 a single sticky _needSent\n       * left the FIFO draining during slow worker fills. */\n      if (this.queuedFrames < this.targetFrames + (this.bufferBoostFrames >> 1))\n        this.requestFill(this.queuedFrames < this.needThreshold);\n      /* Give the look-ahead back once the FIFO stays healthy, otherwise one\n       * early hitch ratchets latency up for the rest of the session. */\n      if (this.queuedFrames >= this.needThreshold) {\n        this.healthyQuanta++;\n        if (this.healthyQuanta >= 200 && this.bufferBoostFrames > 0) {\n          this.healthyQuanta = 0;\n          this.bufferBoostFrames -= 256;\n          if (this.bufferBoostFrames < 0) this.bufferBoostFrames = 0;\n        }\n      } else this.healthyQuanta = 0;\n    }\n    this._tick++;\n    if ((this._tick & 15) === 0) {\n      this.port.postMessage({\n        type: \"stats\",\n        underruns: this.underruns,\n        anomalies: this.anomalies,\n        rxFrames: this.rxFrames,\n        concealUnderruns: this.concealUnderruns,\n        concealSeams: this.concealSeams,\n        lastPeriod: this.lastPeriod,\n        lastScore: this.lastScore,\n        lastTonal: this.concealTonal | 0,\n        underrunFrames: this.underrunFrames,\n        maxGapMs: (this.maxGapFrames * 1000) / sampleRate,\n        minQueuedFrames:\n          this.minQueuedFrames === 0x7fffffff ? this.queuedFrames : this.minQueuedFrames,\n        fillWaitMs: (this.fillWaitLastFrames * 1000) / sampleRate,\n        fillWaitMaxMs: (this.fillWaitMaxFrames * 1000) / sampleRate,\n        bufferBoostFrames: this.bufferBoostFrames,\n        queuedFrames:\n          this.mode === \"inline\" ? this.voices.length : this.queuedFrames | 0,\n        blocks: this.blocks.length | 0,\n        mode: this.mode,\n        voices: this.voices.length | 0\n      });\n    }\n    return true;\n  }\n}\n\nregisterProcessor(\"spin-audio-processor\", SpinAudioProcessor);\n\n\n/* ====================== MONITEUR DE SORTIE ==========================\n * Dernier point observable de la chaine : branche APRES le gain de sortie,\n * donc sur le signal qui part reellement au DAC. Toutes les autres sondes\n * mesurent la SOURCE ou le FIFO ; celle-ci mesure ce que l oreille entend.\n *\n * Deux detecteurs, aucun traitement (il ne modifie rien) :\n *   1. MARCHE - cassure de PENTE (derivee seconde). Une forme d onde continue\n *      a une derivee seconde bornee ; un clic la fait exploser. Seuil adaptatif\n *      sur l agitation recente, pour ne pas crier sur un transitoire legitime.\n *   2. TROU   - suite de zeros exacts alors que quelque chose sonnait.\n *\n * Chaque evenement est date et accompagne du gain courant : un evenement a\n * gain<0.02 est inaudible par construction et ne doit plus etre poursuivi. */\nclass SpinOutputMonitor extends AudioWorkletProcessor {\n  constructor() {\n    super();\n    this.port.onmessage = (e) => {\n      var d = e.data || {};\n      if (d.type === \"dump\") this.dumpEnvelope();\n      else if (d.type === \"tone\") {\n        this.tone = +d.hz || 0;\n        this.tk = 2 * Math.cos(2 * Math.PI * this.tone / sampleRate);\n        this.t1 = 0; this.t2 = 0;\n        this.tWin = 0; this.tMax = 0; this.tBad = 0; this.tPeak = 0;\n      }\n    };\n    this.p0 = 0; this.p1 = 0;\n    this.meanD2 = 0;\n    this.zeroRun = 0;\n    this.wasLoud = 0;\n    this.frames = 0;\n    this.events = 0;\n    this.lastEventFrame = -1e9;\n    this.peak = 0;\n    this.armed = 0;\n    /* Enveloppe roulante de la sortie reelle : crete par tranche de 5 ms,\n     * 512 tranches = 2.56 s. C est ce qui permet de VOIR la forme d un glitch\n     * (rafale, trou, coupure franche) au lieu de la deduire. */\n    this.envN = 512;\n    this.envStep = (sampleRate * 0.005) | 0;\n    this.env = new Float32Array(this.envN);\n    this.envW = 0;\n    this.envAcc = 0;\n    this.envCnt = 0;\n    /* ============ VERIFICATEUR DE SINUS ============\n     * Pour un sinus pur de pulsation w, la recurrence\n     *     x[n] = 2*cos(w)*x[n-1] - x[n-2]\n     * est EXACTE, quelle que soit l amplitude et la phase. Il suffit donc de\n     * la comparer a l echantillon recu : l ecart est nul partout, sauf la ou\n     * la chaine a fabrique un defaut \u2014 et son amplitude est celle du defaut.\n     * Aucun seuil a regler, aucune heuristique. La rampe d ouverture fait\n     * varier le gain donc produit un ecart attendu : on la voit, c est utile. */\n    this.tone = 0;             /* Hz, 0 = desactive */\n    this.tk = 0;               /* 2*cos(w) */\n    this.t1 = 0; this.t2 = 0;  /* x[n-1], x[n-2] */\n    this.tWin = 0;             /* frames dans la fenetre courante */\n    this.tMax = 0;             /* pire ecart de la fenetre */\n    this.tMaxAt = 0;           /* et son instant */\n    this.tBad = 0;             /* frames au-dela de 0.01 */\n    this.tPeak = 0;\n  }\n  dumpEnvelope() {\n    var out = new Float32Array(this.envN), k, idx;\n    for (k = 0; k < this.envN; k++) {\n      idx = (this.envW + k) % this.envN;\n      out[k] = this.env[idx];\n    }\n    this.port.postMessage({ type: \"out-env\", env: out, stepMs: 5, t: currentTime });\n  }\n  process(inputs) {\n    var inp = inputs[0];\n    if (!inp || !inp.length || !inp[0]) { this.frames += 128; return true; }\n    var ch = inp[0], n = ch.length;\n    var i, x, a, d1, d2, ad2, thr, kind = 0, amp = 0, thrHit = 0;\n    for (i = 0; i < n; i++) {\n      x = ch[i];\n      a = x < 0 ? -x : x;\n      if (a > this.peak) this.peak = a;\n      d1 = x - this.p0;\n      d2 = d1 - (this.p0 - this.p1);\n      ad2 = d2 < 0 ? -d2 : d2;\n      /* Mesure : a 0.03+12*meanD2, tous les evenements sortaient a 1.1-1.6x le\n       * seuil sur du contenu large bande legitime \u2014 du bruit de detection, pas\n       * des clics. Un vrai clic est a 10x. On remonte, et on publie le rapport\n       * pour que l ordre de grandeur soit lisible d un coup d oeil. */\n      thr = 0.06 + 25 * this.meanD2;\n      if (this.armed && ad2 > thr && ad2 > amp) { kind = 1; amp = ad2; thrHit = thr; }\n      this.meanD2 = this.meanD2 * 0.9995 + ad2 * 0.0005;\n      if (a < 1e-7) {\n        this.zeroRun++;\n      } else {\n        if (this.armed && this.wasLoud && kind === 0\n            && this.zeroRun >= 24 && this.zeroRun < 48000) {\n          kind = 2; amp = this.zeroRun; thrHit = 0;\n        }\n        this.zeroRun = 0;\n        if (a > 0.02) this.wasLoud = 1;\n      }\n      if (a > this.envAcc) this.envAcc = a;\n      if (++this.envCnt >= this.envStep) {\n        this.env[this.envW] = this.envAcc;\n        this.envW = (this.envW + 1) % this.envN;\n        this.envAcc = 0; this.envCnt = 0;\n      }\n      if (this.tone > 0) {\n        var pr = this.tk * this.t1 - this.t2;\n        var er = x - pr; if (er < 0) er = -er;\n        this.t2 = this.t1; this.t1 = x;\n        if (a > this.tPeak) this.tPeak = a;\n        /* Les deux premiers echantillons n ont pas d historique. */\n        if (this.tWin > 2) {\n          if (er > this.tMax) { this.tMax = er; this.tMaxAt = currentTime; }\n          if (er > 0.01) this.tBad++;\n        }\n        this.tWin++;\n      }\n      this.p1 = this.p0; this.p0 = x;\n    }\n    if (this.tone > 0 && this.tWin >= sampleRate) {\n      this.port.postMessage({\n        type: \"tone-check\", hz: this.tone, max: this.tMax,\n        bad: this.tBad, win: this.tWin, peak: this.tPeak, at: this.tMaxAt\n      });\n      this.tWin = 0; this.tMax = 0; this.tBad = 0; this.tPeak = 0;\n    }\n    this.frames += n;\n    if (!this.armed && this.frames > sampleRate * 0.5) this.armed = 1;\n    /* Un clic n arrive jamais seul : on n en rapporte qu un par 50 ms,\n     * sinon un seul evenement noierait la console. */\n    if (kind && (this.frames - this.lastEventFrame) > sampleRate * 0.05) {\n      this.lastEventFrame = this.frames;\n      this.events++;\n      this.port.postMessage({\n        type: \"out-glitch\", kind: kind, amp: amp, thr: thrHit,\n        peak: this.peak, t: currentTime, n: this.events\n      });\n      this.peak = 0;\n    }\n    return true;\n  }\n}\n\nregisterProcessor(\"spin-output-monitor\", SpinOutputMonitor);\n";

  /* The processor is embedded as one escaped line. Patch its adaptive policy
   * before creating the Blob so the normal Android target stays low, while a
   * proven underrun can temporarily buy a much deeper reserve. */
  SPIN_AUDIO_PROCESSOR_SRC = SPIN_AUDIO_PROCESSOR_SRC
    .replace(
      "    this.bufferBoostFrames = 0;\n    this.needThreshold = 4096;",
      "    this.bufferBoostFrames = 0;\n" +
      "    this.bufferBoostMax = opts.bufferBoostMax > 0 ? opts.bufferBoostMax | 0 : 3072;\n" +
      "    this.bufferBoostStep = opts.bufferBoostStep > 0 ? opts.bufferBoostStep | 0 : 512;\n" +
      "    this.healthyQuantaTarget = opts.healthyQuantaTarget > 0 ? opts.healthyQuantaTarget | 0 : 1200;\n" +
      "    this.riskBoostCooldown = 0;\n" +
      "    this.fifoReadyNotified = false;\n" +
      "    this.needThreshold = 4096;"
    )
    .replace(
      "            this.bufferBoostFrames += 256;\n            if (this.bufferBoostFrames > 1024) this.bufferBoostFrames = 1024;",
      "            this.bufferBoostFrames += this.bufferBoostStep;\n" +
      "            if (this.bufferBoostFrames > this.bufferBoostMax)\n" +
      "              this.bufferBoostFrames = this.bufferBoostMax;"
    )
    .replace(
      "        if (this.healthyQuanta >= 200 && this.bufferBoostFrames > 0) {\n          this.healthyQuanta = 0;\n          this.bufferBoostFrames -= 256;",
      "        if (this.healthyQuanta >= this.healthyQuantaTarget && this.bufferBoostFrames > 0) {\n" +
      "          this.healthyQuanta = 0;\n" +
      "          this.bufferBoostFrames -= Math.max(256, this.bufferBoostStep >> 1);"
    )
    .replace(
      "      if (msg.type === \"set-mode\") {",
      "      if (msg.type === \"arm-fifo-ready\") {\n" +
      "        this.fifoReadyNotified = false;\n" +
      "        this.fifoArmFrame = this.renderFrames;\n" +
      "        if (this.queuedFrames >= this.targetFrames || (this.queuedFrames >= this.needThreshold && (this.renderFrames - (this.fifoArmFrame | 0)) > sampleRate * 0.5)) {\n" +
      "          this.fifoReadyNotified = true;\n" +
      "          this.port.postMessage({ type: \"fifo-ready\", queuedFrames: this.queuedFrames | 0 });\n" +
      "        }\n" +
      "        return;\n" +
      "      }\n" +
      "      if (msg.type === \"set-mode\") {"
    )
    .replace(
      "      if (msg.type === \"set-mode\") {",
      "      if (msg.type === \"pcm\" && msg.samples) {\n" +
      /* Eteint pour la veille : on ne consomme plus, donc empiler ferait
         grossir la file pendant toute la mise en veille pour la rejouer d un
         coup au reveil. */
      "        if (this.silenced) { this.rxFrames += (msg.frames | 0); return; }\n" +
      "        var direct = msg.samples instanceof Float32Array ? msg.samples : new Float32Array(msg.samples);\n" +
      "        var directFrames = msg.frames | 0;\n" +
      "        if (directFrames > 0) {\n" +
      "          this.blocks.push({ samples: direct, frames: directFrames });\n" +
      "          this.queuedFrames += directFrames;\n" +
      "          this.rxFrames += directFrames;\n" +
      "          this.primed = true;\n" +
      "          if (!this.fifoReadyNotified && (this.queuedFrames >= this.targetFrames || (this.queuedFrames >= this.needThreshold && (this.renderFrames - (this.fifoArmFrame | 0)) > sampleRate * 0.5))) {\n" +
      "            this.fifoReadyNotified = true;\n" +
      "            this.port.postMessage({ type: \"fifo-ready\", queuedFrames: this.queuedFrames | 0 });\n" +
      "          }\n" +
      "        }\n" +
      "        return;\n" +
      "      }\n" +
      "      if (msg.type === \"set-mode\") {"
    )
    .replace(
      "              this.queuedFrames += frames;\n              if (this._needSent) {",
      "              this.queuedFrames += frames;\n" +
      "              if (!this.fifoReadyNotified && (this.queuedFrames >= this.targetFrames || (this.queuedFrames >= this.needThreshold && (this.renderFrames - (this.fifoArmFrame | 0)) > sampleRate * 0.5))) {\n" +
      "                this.fifoReadyNotified = true;\n" +
      "                this.port.postMessage({ type: \"fifo-ready\", queuedFrames: this.queuedFrames | 0 });\n" +
      "              }\n" +
      "              if (this._needSent) {"
    )
    .replace(
      "            this.queuedFrames = 0;\n            this._needSent = false;",
      "            this.queuedFrames = 0;\n" +
      "            this.fifoReadyNotified = false;\n" +
      "            this._needSent = false;"
    )
    .replace(
      "        this.queuedFrames = 0;\n        this._needSent = false;",
      "        this.queuedFrames = 0;\n" +
      "        this.fifoReadyNotified = false;\n" +
      "        this.fifoArmFrame = this.renderFrames;\n" +
      "        this._needSent = false;"
    )
    .replace(
      "              }\n              this._needSent = false;\n              /* First PCM block",
      "              }\n" +
      "              /* A refill that consumed half the low-water reserve is\n" +
      "               * an underrun warning even if it arrived a few samples in\n" +
      "               * time. Buy one temporary step before the audible gap. */\n" +
      "              if (this.fillWaitLastFrames >= (this.needThreshold >> 1) &&\n" +
      "                  this.queuedFrames < this.needThreshold &&\n" +
      "                  this.riskBoostCooldown <= 0) {\n" +
      "                this.bufferBoostFrames += this.bufferBoostStep;\n" +
      "                if (this.bufferBoostFrames > this.bufferBoostMax)\n" +
      "                  this.bufferBoostFrames = this.bufferBoostMax;\n" +
      "                this.riskBoostCooldown = 1000;\n" +
      "                this.healthyQuanta = 0;\n" +
      "              }\n" +
      "              this._needSent = false;\n" +
      "              /* First PCM block"
    )
    .replace(
      "    this.renderFrames += n;\n    if (this.mode === \"pcm\") {",
      "    this.renderFrames += n;\n" +
      "    if (this.riskBoostCooldown > 0) this.riskBoostCooldown--;\n" +
      "    if (this.mode === \"pcm\") {"
    )
    .replace(
      "    if (this._needSent && (this.renderFrames - this.needSentAtFrame) < 384) return;",
      "    /* One reliable MessagePort request at a time. Retrying before PCM\n" +
      "     * arrives queues stale FIFO snapshots and destabilizes the fill. */\n" +
      "    if (this._needSent) return;"
    )
    .replace(
      "      /* Re-ask every quantum while below target — a single sticky _needSent\n" +
      "       * left the FIFO draining during slow worker fills. */",
      "      /* Consumer-driven single-flight refill. PCM receipt clears\n" +
      "       * _needSent and permits the next request. */"
    );

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
    /* One and only one browser audio device owner. */
    global._numerisSoundBusOwnsDevice = 1;
    pauseSokolSaudio();
    var mobile = isMobileUa();
    /* Normal path: faithful GPU-worker PCM. Inline synthesis remains a
     * diagnostic path only; it cannot reproduce every generated .sound. */
    var inlineSynth = !!opts.forceInlineSynth;
    var mainThreadPcm = !!opts.mainThreadPcm;
    /* AudioWorklet is the low-latency sink. ScriptProcessor remains available
     * for old or insecure WebViews where the Worklet cannot be installed. */
    var preferWorklet = !!opts.preferWorklet;
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
      /* PCM messages are dynamically sized from the FIFO deficit. They are
       * independent of graphical FPS and may reach ssound SIZE_X (2048). */
      blockFrames: opts.blockFrames > 0 ? opts.blockFrames | 0 : 512,
      /* FIFO depth absorbs scheduling hitches; it no longer controls the GPU
       * render size, which follows the exact queue deficit. */
      targetFrames: opts.targetFrames > 0 ? opts.targetFrames | 0 : (mobile ? 6144 : 4096),
      /* Plancher : setTargetFrames ne descend jamais en dessous. */
      targetFramesFloor: opts.targetFrames > 0 ? opts.targetFrames | 0 : (mobile ? 6144 : 4096),
      needFrames: opts.needFrames > 0 ? opts.needFrames | 0 : (mobile ? 4096 : 3072),
      /* Engine clock (SSOUND_SAMPLE_RATE). Device rate filled after AudioContext. */
      synthRate: opts.synthRate > 0 ? opts.synthRate | 0 : 48000,
      /* 0 until unlock â€” then AudioContext.sampleRate (may differ â†’ resample). */
      sampleRate: opts.sampleRate > 0 ? opts.sampleRate | 0 : 0,
      convertPath: "pending",
      legacyTimeScale: opts.legacyTimeScale > 0 ? +opts.legacyTimeScale : 1.0,
      /* SOUND_UNLOCK_FADEIN_SEC â€” ramp when device first becomes audible. */
      unlockFadeSec: opts.unlockFadeSec > 0 ? +opts.unlockFadeSec : 0.04,
      toneHz: opts.toneHz > 0 ? +opts.toneHz : 440,
      preferCpu: !!opts.preferCpu,
      preferWorklet: preferWorklet,
      inlineSynth: inlineSynth,
      mainThreadPcm: mainThreadPcm,
      mobile: mobile,
      _diagLastMs: 0,
      _diagWarnMs: 0,
      _diagUnderruns: -1,
      _diagAnomalies: -1,
      _diagUnderrunFrames: 0
    };

    function audioDiagNumber(v, digits) {
      v = +v || 0;
      return v.toFixed(digits == null ? 1 : digits);
    }

    function maybeLogAudioHealth(msg) {
      if (!SOUND_DIAG) return;
      var s = state.stats || {};
      var now = typeof performance !== "undefined" && performance.now
        ? performance.now() : Date.now();
      var total = msg.underruns | 0;
      var frames = msg.underrunFrames | 0;
      var deltaEvents = state._diagUnderruns >= 0 ? total - state._diagUnderruns : 0;
      var deltaFrames = frames - (state._diagUnderrunFrames | 0);
      var active = (s.workerVoices | 0) > 0 || (+s.peak || 0) > 0.0001;
      var detail =
        "path=" + (state.audioPath || "pending") +
        " backend=" + (s.backend || "pending") +
        " q=" + (msg.queuedFrames | 0) + "/" + state.targetFrames +
        " min=" + (msg.minQueuedFrames | 0) +
        " workerQ~" + (s.queued_est | 0) +
        " gpuReq=" + (s.gpuRequestFrames | 0) +
        "/" + (s.gpuRequestMaxFrames | 0) +
        " wait=" + audioDiagNumber(msg.fillWaitMs) +
        "/" + audioDiagNumber(msg.fillWaitMaxMs) + "ms" +
        " gpu=" + audioDiagNumber(s.synthLastMs) +
        "/" + audioDiagNumber(s.synthMaxMs) + "ms" +
        " fillMax=" + audioDiagNumber(s.workerFillMaxMs) + "ms" +
        " pumpLate=" + audioDiagNumber(s.pumpLateLastMs) +
        "/" + audioDiagNumber(s.pumpLateMaxMs) + "ms" +
        " edge=" + audioDiagNumber(s.edgeJumpMax, 3) +
        "/x" + audioDiagNumber(s.edgeRatioMax, 1) +
        "#" + (s.edgeCount | 0) +
        " gpuEdge=" + (s.gpuEdgeCount | 0) +
        " rawEdge=" + audioDiagNumber(s.rawEdgeJumpMax, 3) +
        "/x" + audioDiagNumber(s.rawEdgeRatioMax, 1) +
        "#" + (s.rawEdgeCount | 0) +
        " echoEdge=" + audioDiagNumber(s.echoEdgeJumpMax, 3) +
        "/x" + audioDiagNumber(s.echoEdgeRatioMax, 1) +
        "#" + (s.echoEdgeCount | 0) +
        " echoMix=" + audioDiagNumber(s.echoMix, 2) +
        " gain=" + audioDiagNumber(s.busGain, 3) +
        " master=" + audioDiagNumber(s.masterSmooth, 3) +
        " zeroRun=" + (s.zeroRunMax | 0) +
        " staleNeed=" + (s.staleNeeds | 0) +
        " voices=" + (s.workerVoices | 0) +
        " boost=" + (msg.bufferBoostFrames | 0) +
        /* coutures reparees par le filtre d anomalies du worklet : une valeur
           qui monte a la reprise apres veille dit que le producteur est reparti
           ailleurs dans la forme d onde, et que le raccord a ete lisse. */
        " coutures=" + (state.stats.anomalies | 0) +
        /* Cause des dissimulations. famine = le FIFO etait vide (transport) ;
           saut = le flux a change de forme d onde entre deux blocs (source).
           Les deux s entendent pareil et n ont pas le meme remede. */
        " dissim=" + (state.stats.concealUnderruns | 0) +
        "f/" + (state.stats.concealSeams | 0) + "s" +
        " periode=" + (state.stats.lastPeriod | 0) +
        "@" + audioDiagNumber(state.stats.lastScore, 2) +
        (state.stats.lastTonal ? "T" : "F");

      /* LE PUITS NE PARLAIT QUE QUAND IL MOURAIT DE FAIM.
         Le worklet compte aussi les COUTURES qu il repare (anomalies) et les
         dissimulations par saut de forme d onde (concealSeams). Ces deux-la
         s entendent — c est meme exactement ce qu on appelle un « glitch
         random » — et aucune ligne ne les rapportait tant qu il n y avait pas
         de famine. Un artefact repare reste un artefact : il doit se voir. */
      var anom = (state.stats.anomalies | 0) + (state.stats.concealSeams | 0);
      var deltaAnom = state._diagAnomalies >= 0
        ? anom - state._diagAnomalies : 0;
      if (
        state.audioReady && state._outputFadedIn &&
        (deltaEvents > 0 || deltaFrames >= 128 || deltaAnom > 0) &&
        now - state._diagWarnMs >= 750
      ) {
        state._diagWarnMs = now;
        dwarn(
          "[audio-health] " +
          (deltaEvents > 0 || deltaFrames >= 128
            ? "UNDERRUN +" + Math.max(0, deltaEvents) +
              " events +" + Math.max(0, deltaFrames) + " frames"
            : "COUTURE +" + deltaAnom) +
          " total=" + total +
          " maxGap=" + audioDiagNumber(msg.maxGapMs) + "ms " + detail
        );
      }
      state._diagAnomalies = anom;
      if (state.audioReady && active && now - state._diagLastMs >= 5000) {
        state._diagLastMs = now;
        dlog(
          "[audio-health] " + (deltaFrames > 0 ? "STARVED " : "stable ") + detail
        );
      }
      state._diagUnderruns = total;
      state._diagUnderrunFrames = frames;
    }

    function refreshConvertPath() {
      var cfg = state.synthRate | 0;
      var dev = state.sampleRate | 0;
      if (!(cfg > 0)) cfg = 48000;
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
    if (!inlineSynth && !mainThreadPcm) {
      /* OffscreenCanvas is only needed by the GPU module inside the worker,
       * which degrades to the JS synth on its own — do not fail the bus here. */
      if (!workerSupported(false)) {
        state.error = "worker-unsupported";
        return state;
      }
      var url = locate("sound_worker.js", opts.workerUrl);
      if (url.indexOf("?") < 0) url += "?v=gpu41";
      else url += "&v=gpu41";
      var worker;
      try {
        worker = new Worker(url);
      } catch (err) {
        state.error = "worker-create:" + (err && err.message ? err.message : err);
        return state;
      }

      /* The worker no longer runs a timing shader of its own; the ssound
       * module creates the only audio GL context, inside the worker. */
      var canvas = null;
      worker.onmessage = function (ev) {
        var msg = ev.data || {};
        if (msg.type === "pcm-capture-started") {
          state.captureState = "recording";
          console.log("[audio-capture] recording " + (+msg.seconds || 0) + "s PCM...");
          return;
        }
        if (msg.type === "pcm-capture" && msg.samples) {
          var pcm = new Float32Array(msg.samples);
          var frames = Math.min(msg.frames | 0, pcm.length >> 1);
          var rate = msg.sampleRate > 0 ? msg.sampleRate | 0 : 48000;
          var wav = new ArrayBuffer(44 + frames * 4);
          var dv = new DataView(wav);
          function fourcc(off, value) {
            for (var ci = 0; ci < 4; ci++) dv.setUint8(off + ci, value.charCodeAt(ci));
          }
          fourcc(0, "RIFF"); dv.setUint32(4, 36 + frames * 4, true);
          fourcc(8, "WAVE"); fourcc(12, "fmt ");
          dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
          dv.setUint16(22, 2, true); dv.setUint32(24, rate, true);
          dv.setUint32(28, rate * 4, true); dv.setUint16(32, 4, true);
          dv.setUint16(34, 16, true); fourcc(36, "data");
          dv.setUint32(40, frames * 4, true);
          for (var wi = 0; wi < frames * 2; wi++) {
            var sv = pcm[wi];
            if (sv > 1) sv = 1;
            else if (sv < -1) sv = -1;
            dv.setInt16(44 + wi * 2, sv < 0 ? sv * 32768 : sv * 32767, true);
          }
          var blob = new Blob([wav], { type: "audio/wav" });
          if (state.lastCaptureUrl) URL.revokeObjectURL(state.lastCaptureUrl);
          state.lastCaptureBlob = blob;
          state.lastCaptureUrl = URL.createObjectURL(blob);
          state.captureState = "ready";
          state.captureFrames = frames;
          var link = document.createElement("a");
          link.href = state.lastCaptureUrl;
          link.download = "numeris-audio-debug-" + Date.now() + ".wav";
          link.style.display = "none";
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          console.log("[audio-capture] WAV ready frames=" + frames +
            " rate=" + rate + " url=" + state.lastCaptureUrl);
          return;
        }
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
        if (msg.type === "warmup-barrier") {
          if ((msg.token | 0) === (state._warmupBarrierToken | 0)) {
            state._warmupReadyCount = 0;
            state._warmupReleaseAllowed = 1;
            /* Query the sink itself after the producer barrier. */
            try {
              if (state.worklet && state.worklet.port)
                state.worklet.port.postMessage({ type: "arm-fifo-ready" });
            } catch (eArm) {}
            dlog(
              "[sound_bus] first-unlock barrier ready q=" +
                (msg.queued_est | 0) +
                " blocks=" +
                (msg.pcm_blocks | 0)
            );
          }
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
          state.stats.gpuRequestFrames = msg.gpu_request_frames | 0;
          state.stats.gpuRequestMaxFrames = msg.gpu_request_max_frames | 0;
          state.stats.voices = msg.voices | 0;
          state.stats.ssound = msg.ssound | 0;
          state.stats.wasm = msg.wasm | 0;
          state.stats.backend = msg.backend || "";
          state.stats.peak = +msg.peak || 0;
          state.stats.busGain = msg.bus_gain == null ? 1 : (+msg.bus_gain || 0);
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
          state.stats.workerVoices = msg.voices | 0;
          state.stats.pumpLateLastMs = +msg.pump_late_last_ms || 0;
          state.stats.pumpLateMaxMs = +msg.pump_late_max_ms || 0;
          state.stats.pumpLateCount = msg.pump_late_count | 0;
          state.stats.staleNeeds = msg.stale_needs | 0;
          state.stats.edgeJumpMax = +msg.edge_jump_max || 0;
          state.stats.edgeRatioMax = +msg.edge_ratio_max || 0;
          state.stats.edgeCount = msg.edge_count | 0;
          state.stats.gpuEdgeCount = msg.gpu_edge_count | 0;
          state.stats.zeroRunMax = msg.zero_run_max | 0;
          state.stats.rawEdgeCount = msg.raw_edge_count | 0;
          state.stats.rawEdgeJumpMax = +msg.raw_edge_jump_max || 0;
          state.stats.rawEdgeRatioMax = +msg.raw_edge_ratio_max || 0;
          state.stats.echoEdgeCount = msg.echo_edge_count | 0;
          state.stats.echoEdgeJumpMax = +msg.echo_edge_jump_max || 0;
          state.stats.echoEdgeRatioMax = +msg.echo_edge_ratio_max || 0;
          state.stats.echoMix = +msg.echo_mix || 0;
          state.stats.masterSmooth = msg.master_smooth == null ? 1 : (+msg.master_smooth || 0);
          /* queued_est is producer-side only. Never open the DAC from it: PCM
           * may still be in transit to the actual sink FIFO. */
          if (typeof opts.onStats === "function") opts.onStats(state, msg);
          return;
        }
        if (msg.type === "error") {
          state.ok = false;
          state.ready = false;
          state.error = (msg.reason || "error") + (msg.detail ? ":" + msg.detail : "");
          console.error("[sound_bus] worker message error", state.error, msg);
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
        var detail =
          "message=" + (err && err.message ? err.message : "unknown") +
          " file=" + (err && err.filename ? err.filename : url) +
          " line=" + (err && err.lineno ? err.lineno : 0) +
          ":" + (err && err.colno ? err.colno : 0) +
          (err && err.error && err.error.stack ? " stack=" + err.error.stack : "");
        state.error = "worker-onerror:" + detail;
        console.error("[sound_bus] " + state.error, err);
        if (typeof opts.onError === "function")
          opts.onError(state, { reason: "worker-onerror", detail: detail });
      };
      worker.onmessageerror = function (err) {
        state.ok = false;
        state.error = "worker-messageerror:data-clone";
        console.error("[sound_bus] " + state.error, err);
        if (typeof opts.onError === "function")
          opts.onError(state, { reason: "worker-messageerror", detail: "data-clone" });
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
          maxVoices: state.mobile ? 16 : 32,
          toneHz: state.toneHz,
          preferCpu: state.preferCpu
        };
        if (canvas) worker.postMessage(initMsg, [canvas]);
        else worker.postMessage(initMsg);
        dlog("[sound_bus] worker init url=" + url +
          " rate=" + initMsg.sampleRate + " block=" + initMsg.blockFrames +
          " target=" + initMsg.targetFrames + " need=" + initMsg.needFrames +
          " voices=" + initMsg.maxVoices + " canvas=" + (canvas ? 1 : 0));
      } catch (err) {
        state.error = "postMessage:" + (err && err.message ? err.message : err);
        try {
          worker.terminate();
        } catch (e2) {}
        return state;
      }
      state.worker = worker;
    } else {
      /* Main Sokol PCM and inline modes need no Worker or second GL context. */
      state.ready = true;
      state.ok = true;
      state.renderer = mainThreadPcm ? "sokol-main" : "worklet-inline";
      state.stats.backend = state.renderer;
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
        if (!state.audioPath) {
          state.audioPath = state.scriptNode
            ? "script-pcm"
            : (state.inlineSynth ? "worklet-inline" : "worklet-pcm");
        }
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
        if (state.worklet && state.worklet.port && !soft) {
          state.worklet.port.postMessage({
            type: "reset-latency",
            /* Tout bloc commence avant cette marque est perime. */
            after: state._txFrames | 0
          });
          /* Le producteur pilote son debit sur cette valeur. La laisser a son
             ancien niveau jusqu au prochain rapport de stats (~42 ms) lui ferait
             croire que la file est pleine alors qu on vient de la vider — donc
             ne rien produire, donc une famine juste apres la reprise. */
          state.stats.queuedFrames = 0;
          /* Le puits vient de jeter sa file : tout ce qui etait en route ne
             compte plus. On repart de zero des deux cotes. */
          state._flushEpoch = (state._flushEpoch | 0) + 1;
          state._qMark = 0;
          state._rxMark = state._txFrames | 0;
          state._qMarkTime = state.audioCtx ? state.audioCtx.currentTime : -1;
        }
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
          dlog(
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
          dlog("[sound_bus] trim latency (" + why + ")");
        }
      } catch (e3) {}
    }
    state.trimAudioLatency = trimAudioLatency;
    state._lastTrimMs = 0;
    state._outputAllowed = 1;
    state._backgroundMuted = 0;
    state._backgroundPausing = 0;
    state._backgroundFadeTimer = 0;
    state._resumeDebounce = 0;
    state._dacDetached = 0;
    state._unlockFadePending = 0;
    /* First-unlock barrier: worker stats may arrive while startAudio() is still
     * attaching the sink. Never open the DAC before pending plays are flushed. */
    state._warmupReleaseAllowed = 0;
    state._warmupBarrierToken = 0;

    /* Desktop can wait for timers. Phone lock/screen-off freezes JS almost
     * immediately — any setTimeout fade is cut mid-way → pop. Mobile uses a
     * short AudioContext ramp + busy-wait so the audio thread finishes first. */
    /* Niveau de sortie. Mesure au moniteur : crete=0.990 puis 0.915 — la sortie
       tapait en permanence contre le limiteur doux, ce qui durcit tout le mix.
       0.70 = -3.1 dB : la crete retombe vers 0.65-0.70 et le limiteur ne sert
       plus que d exception. */
    /* ===================== DIAGNOSTICS AUDIO =====================
       0 = silence complet dans la console, et le moniteur de sortie n est
           meme pas construit (un AudioWorkletNode et une analyse par bloc en
           moins sur le fil audio — ce n est pas que du journal, c est du
           travail en moins).
       1 = tout le journal d instrumentation : enveloppes, coutures, horloge
           du peripherique, sante de la file, verificateur de sinus.
       Les vraies erreurs (console.error) ne sont JAMAIS masquees.
       Peut aussi s activer sans reconstruire, depuis la console ou l URL :
           localStorage.spinAudioDiag = 1      (persistant)
           ...?audiodiag=1                     (une session)                */
    var SOUND_DIAG = 0;
    try {
      if (typeof location !== "undefined" &&
          /[?&]audiodiag=1/.test(location.search || "")) SOUND_DIAG = 1;
      else if (typeof localStorage !== "undefined" &&
               localStorage.getItem("spinAudioDiag") === "1") SOUND_DIAG = 1;
    } catch (eDg) {}
    function dlog() {
      if (!SOUND_DIAG) return;
      try { console.log.apply(console, arguments); } catch (e) {}
    }
    function dwarn() {
      if (!SOUND_DIAG) return;
      try { console.warn.apply(console, arguments); } catch (e) {}
    }
    if (SOUND_DIAG) {
      try { console.log("[sound_bus] diagnostics audio ACTIFS"); } catch (e) {}
    }

    var SOUND_BARE_OSC_TEST = 0;
    var SOUND_OUTPUT_LEVEL = SOUND_BARE_OSC_TEST ? 0.0 : 0.70;

    /* ================== MODE SIMPLE : TOUT MON ECHAFAUDAGE COUPE ==================
     |
     | Tu dis que le probleme n existait pas avant mes corrections. C est une
     | hypothese verifiable, et c est a moi de la verifier plutot que d ajouter
     | une dix-huitieme couche par-dessus.
     |
     | A 1, tout ce que j ai empile aujourd hui sur le cycle de vie est
     | DESACTIVE d un coup :
     |   - rampe d ouverture accrochee au signal   (reopen-ramp)
     |   - fondu doux apres silence                (quietArm)
     |   - detection de couture et dissimulation   (conceal)
     |   - extinction franche a la mise en fond    (silence-now)
     |   - vidage dur de la file a chaque bascule  (trim)
     |   - retard experimental de la 1re ouverture
     | Il ne reste que : remplir la file, la jouer, et un fondu de gain a
     | l ouverture et a la fermeture.
     |
     | Le glitch de demarrage disparait  -> il vient de mon echafaudage, et je
     |                                      bisecte a l interieur, une piece
     |                                      apres l autre.
     | Le glitch persiste               -> il est en amont (chemin compute
     |                                      WebGPU), et c est la qu il faut
     |                                      chercher, pas dans le bus.
     |
     | Dans les deux cas on decoupe le probleme en deux au lieu de tatonner. */
    var SOUND_SIMPLE_MODE = 0;   /* diagnostic termine : on remet le vrai bus */
    /* Sinus fabrique dans le worklet (fil audio). 0 = audio normal. */
    var SOUND_WORKLET_SELFTEST_HZ = 0;   /* retour au vrai son du jeu */
    /* Profondeur demandee au peripherique, en secondes. "interactive" (~20 ms
       sur Android) laissait passer des decrochages de 20 a 40 ms. */
    /* ===== TEST : GROS TAMPON DE SORTIE =====
       Ton essai avec les exemples de floooh est decisif : le MEME code audio
       (saudio) ne claque pas en WebGL et claque en WebGPU. Le son n y est pour
       rien — c est le fil audio temps reel qui rate son echeance parce que le
       navigateur est occupe par WebGPU. Tes journaux le disent aussi :
           [audio-dev] PERTE 33ms sur 5.0s  <<<< le peripherique n a pas joue
           [perf-10s] frame=34.5ms present=25.4ms
       La seule parade cote application contre une famine du fil audio, c est
       un tampon plus profond. On passe de 45 a 120 ms pour trancher.
       Si tout devient propre : famine confirmee, on cherchera ensuite le bon
       compromis. Remettre 0.045 pour comparer. */
    /* 120 ms rendait le claquement de FERMETURE impossible a eviter : il faut
       attendre fondu + latence avant de couper, et 25+120 = 145 ms de blocage
       synchrone dans pagehide, c est trop. A 45 ms, l attente tombe a 78 ms —
       tenable, et le fondu atteint vraiment le haut-parleur. */
    var SOUND_DEVICE_LATENCY = 0.045;
    /* ===== COMPILER LE WORKLET AVANT D OUVRIR LE FLUX =====
       Ordre actuel : resume() -> le flux Android s ouvre -> PUIS addModule()
       compile un module de 200 ko SUR LE FIL AUDIO. Ce fil est justement
       celui qui doit remplir les tout premiers tampons du peripherique. Il
       compile au lieu de produire : les premiers tampons arrivent en retard,
       et un flux Android qui demarre en retard claque — meme si le contenu
       est du silence parfait, ce que mon moniteur a mesure (crete=0.000).
       Ici on inverse : module compile et noeud branche PENDANT que le
       contexte est encore suspendu, resume() en dernier. Le flux s ouvre
       alors sur un graphe deja pret.
       Secours : si addModule ne repond pas en 400 ms sur contexte suspendu
       (bug Chrome connu), on retombe sur l ancien ordre. */
    /* ANNULE. Preuve dans le journal : en repoussant resume() apres la
       compilation du module, il sort de la tache du geste, et Chrome Android
       le REFUSE — "AudioContext was not allowed to start" puis
       audio-resume-timeout ctx=suspended. Ici, pas d activation collante :
       resume() doit etre appele DANS le geste. Retour a l ordre d origine. */
    var SOUND_MODULE_BEFORE_RESUME = 0;
    /* ================== TEST : LE PERIPHERIQUE OU NOUS ? ==================
       Apres le toucher, le contexte tourne et le worklet produit deja le
       sinus, mais la sortie reste a ZERO NUMERIQUE pendant ce delai. Le
       peripherique Android demarre donc sur du silence parfait.
         - si le clac reste PILE au toucher      -> c est le demarrage du
           peripherique, rien dans notre code ne peut l enlever ;
         - s il se deplace a la fin du delai     -> c est notre signal.
       Mettre a 0 pour revenir au comportement normal. */
    /* Test termine : il a prouve que le clac tombait au toucher pendant un
       silence numerique parfait, ce qui a mene a l activation utilisateur.
       Remettre 1500 pour le refaire. */
    var SOUND_OPEN_SILENCE_MS = 0;
    /* Que faire quand la page part pour de bon (rechargement, fermeture).
         0 = RIEN DU TOUT : ni fondu, ni coupure, ni close, ni suspend.
             On ne touche plus au flux, le navigateur le detruit avec la page.
             C est le test : si le clac de fermeture disparait, il venait de
             NOUS ; s il reste, il vient de l arrachage par le navigateur.
         1 = fondu puis close(), en attendant que le fondu atteigne le DAC
         2 = fondu puis suspend() (comportement d origine) */
    var SOUND_LEAVE_MODE = 1;
    var BACKGROUND_FADE_SEC = state.mobile ? 0.055 : 0.10;
    var BLUR_FADE_SEC = state.mobile ? 0.04 : 0.06;
    var PHONE_LOCK_FADE_SEC = 0.055;
    /* Tab/browser kill: timers never run — short ramp + busy-wait only. */
    var TERMINAL_LEAVE_FADE_SEC = state.mobile ? 0.025 : 0.035;

    function isTerminalLeaveReason(reason) {
      return (
        reason === "pagehide" ||
        reason === "shutdown" ||
        reason === "stop" ||
        reason === "beforeunload"
      );
    }

    function wakeSink() {
      try {
        if (state.worklet && state.worklet.port)
          state.worklet.port.postMessage({ type: "wake" });
      } catch (eWk) {}
    }
    state._wakeSink = wakeSink;

    function silenceScriptSink() {
      try {
        if (typeof state._scriptSilenceForTeardown === "function")
          state._scriptSilenceForTeardown();
      } catch (eSc) {}
      try {
        if (state.worklet && state.worklet.port)
          state.worklet.port.postMessage({
            type: "reset-latency",
            /* Tout bloc commence avant cette marque est perime. */
            after: state._txFrames | 0
          });
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
      if (state._resumeDebounce) {
        clearTimeout(state._resumeDebounce);
        state._resumeDebounce = 0;
      }
      state._backgroundPausing = 0;
    }

    function disconnectDac() {
      try {
        if (state.scriptNode) state.scriptNode.disconnect();
      } catch (e0) {}
      try {
        if (state.worklet) state.worklet.disconnect();
      } catch (e1) {}
      try {
        /* disconnect() SANS ARGUMENT coupe toutes les sorties du noeud — donc
           aussi le moniteur branche dessus. Il restait muet pour le reste de la
           session : c est pour ca qu aucun [audio-out] n apparaissait apres la
           premiere veille. On ne coupe QUE le lien vers le DAC. */
        if (state.outputGain && state.audioCtx)
          state.outputGain.disconnect(state.audioCtx.destination);
      } catch (e2) {
        try { if (state.outputGain) state.outputGain.disconnect(); } catch (e2b) {}
        try {
          if (state.outputGain && state._outMon) state.outputGain.connect(state._outMon);
        } catch (e2c) {}
      }
      try {
        if (state._silentAudio) state._silentAudio.pause();
      } catch (e3) {}
      state._dacDetached = 1;
    }

    function reconnectDac() {
      var ctx = state.audioCtx;
      var g;
      if (!ctx || ctx.state === "closed") return;
      g = ensureOutputGain(ctx);
      try {
        if (state.scriptNode) {
          state.scriptNode.disconnect();
          state.scriptNode.connect(g);
        }
      } catch (e0) {}
      try {
        if (state.worklet) {
          state.worklet.disconnect();
          state.worklet.connect(g);
        }
      } catch (e1) {}
      try {
        g.connect(ctx.destination);
      } catch (e2) {}
      try { if (state._outMon) g.connect(state._outMon); } catch (e2b) {}
      state._dacDetached = 0;
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
      state._resumedOnce = 1;   /* la prochaine ouverture est une REPRISE */
      stopWorkerPumpSoft();
      try {
        if (state._pendingPlays) state._pendingPlays.length = 0;
      } catch (eP) {}
      silenceScriptSink();
      muteOutputNow();
      /* Detacher puis rattacher un noeud du graphe n est PAS aligne sur les
         echantillons : c est une edition de graphe, pas une rampe. Le gain est
         deja a zero et le puits emet du silence franc — le detachement
         n apporte rien et ajoute une discontinuite a chaque bascule. On ne
         detache que pour une vraie mise hors service. */
      if (reason === "pagehide" || reason === "freeze" || reason === "interrupted")
        disconnectDac();
      pauseSokolSaudio();
      /* SUSPENDRE LE CONTEXTE COUTE PLUS CHER QUE CE QU IL RAPPORTE.
         suspend()/resume() ferme et rouvre le peripherique audio du systeme :
         sur Android c est plusieurs centaines de millisecondes, et c est la
         plus grosse part du blanc de 849 ms mesure au retour d un changement
         d app. Or la sortie est DEJA muette de deux facons independantes :
         le gain de sortie est a zero et le worklet est en silence franc. Un
         contexte qui tourne en emettant des zeros exacts ne consomme rien.
         On ne suspend donc que pour une vraie mise hors service de la page
         (pagehide / freeze / interruption systeme), jamais pour un
         changement d onglet ou d application. */
      {  var hardStop = (reason === "pagehide" || reason === "freeze"
                      || reason === "interrupted");
         if (hardStop) {
            try {
               var ctxP = state.audioCtx;
               if (ctxP && ctxP.state === "running") ctxP.suspend();
            } catch (eSus) {}
         }
         try {
            dlog("[sound_bus] paused for background (" + (reason || "?") + ")"
               + (hardStop ? " ctx=suspendu" : " ctx=maintenu")
               + " t=+" + Math.round(((typeof performance !== "undefined" && performance.now)
                    ? performance.now() : Date.now()) - (state._silenceSinceMs || 0)) + "ms");
         } catch (eLog) {}
      }
    }

    /* Delai reel entre une rampe posee sur le noeud de gain et le moment ou
       elle sort du haut-parleur. Android annonce outputLatency=0, ce qui est
       faux : on prend 50 % de marge sur la latence de base plus 20 ms. */
    function bgLatencyMs() {
      var ms = 0;
      try {
        var c = state.audioCtx;
        if (c) {
          var b = (c.baseLatency || 0) * 1000;
          var o = (c.outputLatency || 0) * 1000;
          ms = b + o;
          if (ms < b * 1.5) ms = b * 1.5;
        }
      } catch (e) {}
      if (!(ms > 0)) ms = SOUND_DEVICE_LATENCY * 1000;
      return ms + 20;
    }

    function pauseForBackground(reason) {
      /* A phone lock/app switch can emit several lifecycle events. Preserve the
       * first audio-timeline ramp instead of restarting it until JS freezes. */
      if (state._backgroundMuted || state._backgroundPausing) return;
      if (state._shutdownBegun || state._tearingDown) return;
      /* AudioContext starts suspended until the unlock tap. Treating that as
       * "tab hidden" stopped the worker and left gain at 0 — total silence. */
      if (
        isPageAudible() &&
        reason !== "interrupted" &&
        reason !== "freeze" &&
        reason !== "pagehide"
      )
        return;
      cancelBackgroundPause();
      state._backgroundPausing = 1;
      state._outputAllowed = 0;
      state._unlockFadePending = 0;
      state._warmupReadyCount = 0;
      /* Fade on the audio timeline first. Clearing PCM or disconnecting here
       * would turn a tab switch / phone lock into a hard waveform edge. */
      var fadeSec = reason === "freeze" || reason === "interrupted"
        ? PHONE_LOCK_FADE_SEC
        : BACKGROUND_FADE_SEC;
      /* Le puits s eteint LUI-MEME, sur son propre fil. La rampe de gain
         ci-dessous vit sur le fil audio elle aussi, mais elle ne protege pas
         d une famine survenue pendant la rampe : le producteur, lui, est deja
         en train d etre gele par le systeme. Le worklet est le seul a pouvoir
         garantir du silence franc quoi qu il arrive en amont. */
      try {
        if (!SOUND_SIMPLE_MODE && state.worklet && state.worklet.port)
          state.worklet.port.postMessage({
            type: "silence-now",
            /* 12 ms, pas 55. Au verrouillage, le systeme gele l onglet sans
               prevenir : une rampe longue a toutes les chances d etre coupee en
               plein milieu, et une rampe coupee est une marche de signal. Douze
               millisecondes suffisent a ne pas claquer et ont quatre fois plus
               de chances d aller au bout. */
            /* 12 ms UNIQUEMENT quand le systeme peut geler l onglet sans
               prevenir (verrouillage, pagehide) : une rampe longue y serait
               coupee en plein milieu, et une rampe coupee est une marche.
               Pour un simple changement d application l onglet n est PAS gele
               et on a tout le temps. Mesure a l enveloppe de sortie : le signal
               passait de 0.44 a zero en 2 cases de 5 ms — ce n est pas un
               fondu, c est une coupure, et c est ce qu on entend. */
            frames: Math.max(256, Math.round(
              ((reason === "freeze" || reason === "pagehide" || reason === "interrupted")
                 ? 0.012 : 0.070) * (state.sampleRate || 48000)))
          });
      } catch (eSil) {}
      fadeOutputOut(reason || "background", fadeSec, null);
      if (state.mobile) {
        /* JS may freeze immediately after visibility/pagehide. AudioParam runs
         * on the audio thread while this short wait lets the ramp finish. */
        /* L ATTENTE ACTIVE ETAIT UNE MAUVAISE IDEE, ET C EST MESURE.
           Elle bloquait le fil principal 59 ms PILE au moment ou le systeme
           bascule d application — exactement quand [audio-dev] releve les
           decrochages. Elle servait a laisser finir la rampe de gain avant
           finishBackgroundMute ; depuis qu on ne suspend plus le contexte et
           qu on ne detache plus le graphe, celui-ci ne fait presque plus rien
           d urgent. On rend la main au systeme. */
        /* MEME CORRECTION QUE POUR LA FERMETURE : on finissait la coupure
           "fondu + 8 ms" plus tard, sans compter la latence du peripherique.
           Le fondu n avait donc pas encore atteint le haut-parleur quand on
           coupait net — la meme marche de signal, au passage en veille. */
        state._backgroundFadeTimer = setTimeout(function () {
          finishBackgroundMute(reason || "background");
        }, (fadeSec * 1000 + bgLatencyMs() + 8) | 0);
      } else {
        state._backgroundFadeTimer = setTimeout(function () {
          finishBackgroundMute(reason || "background");
        }, (fadeSec * 1000 + bgLatencyMs() + 20) | 0);
      }
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
      if (state._wakeSink) state._wakeSink();   /* annule l extinction commandee */
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
      state._warmupWaitTicks = 0;
      state._unlockFadePending = 1;
      var ctx = state.audioCtx;
      if (!ctx) return;
      dumpOutEnv("mise en veille (juste avant la reprise)");
      var _t0 = (typeof performance !== "undefined" && performance.now)
        ? performance.now() : Date.now();
      var _now = function () {
        return (typeof performance !== "undefined" && performance.now)
          ? performance.now() : Date.now();
      };
      Promise.resolve()
        .then(function () {
          state._resumeWasRunning = ctx.state === "running" ? 1 : 0;
          return ctx.state !== "running" ? ctx.resume() : null;
        })
        .then(function () {
          try {
            dlog("[sound_bus] reprise : ctx " +
              (state._resumeWasRunning ? "deja actif" : "resume() " + Math.round(_now() - _t0) + "ms") +
              " | depuis fade-out=" +
              Math.round(_now() - (state._silenceSinceMs || _now())) + "ms");
          } catch (eR) {}
          if (ctx.state !== "running") {
            dwarn(
              "[sound_bus] foreground: still " + ctx.state + " — nuke for next gesture"
            );
            nukeAudioGraph();
            state.audioStage = "waiting-gesture";
            return;
          }
          reconnectDac();
          resumeSokolSaudio();
          markAudioReadyIfRunning();
          resumeWorkerPump();
          if (wasMuted) {
            /* Flush stale pre-suspend PCM while gain is zero, then wait for a
             * worker barrier AND the sink-local fifo-ready acknowledgement. */
            state._warmupReleaseAllowed = 0;
            state._warmupReadyCount = 0;
            /* La fenetre d observation de la file DEMARRE ICI, pas au fondu
               de sortie. Preuve dans le journal : la barriere se declenchait
               des "output fade-out (visibility)", donc au moment de la vraie
               reprise elle avait deja 400 ms au compteur et se laissait
               traverser sans rien verifier :
                   attente reprise : reprise 4800/4080 (... 0/400ms)   <- au fondu
                   output fade-in ... file=5204/8036                    <- non gardee
               On remet le compteur a zero juste avant de vider la file. */
            state._reOpenAt = 0;
            state._rePeak = 0;
            /* VOILA POURQUOI LA BARRIERE NE GARDAIT RIEN.
               resumeFromForeground remet _unlockFadePending a 1 : une reprise
               repasse donc par la barriere du PREMIER demarrage, pas par la
               mienne. Mais son chronometre (_firstOpenAt) et sa crete
               n avaient jamais ete remis a zero depuis le vrai premier
               demarrage — au bout de quelques secondes de jeu elle etait
               largement au-dela de son plafond de 600 ms et se laissait
               traverser sans rien verifier. D ou le fondu d entree a
               file=3276/8013, soit 41 % de reserve.
               On remet sa fenetre a zero a chaque reouverture : elle observe
               de nouveau la file, retient la crete, et ouvre sur une crete. */
            state._firstOpenAt = 0;
            state._firstPeak = 0;
            state._peakAt = 0;
            trimAudioLatency(reason || "foreground", true);
            state._warmupBarrierToken = ((state._warmupBarrierToken | 0) + 1) | 0;
            if (state.worker)
              state.worker.postMessage({
                type: "warmup_barrier",
                token: state._warmupBarrierToken
              });
            else state._warmupReleaseAllowed = 1;
          }
        })
        .catch(function () {
          nukeAudioGraph();
          state.audioStage = "waiting-gesture";
        });
    }

    function syncPageAudible(trigger) {
      if (isPageAudible()) {
        /* Tab switches flicker visible/hidden; resume immediately → blips. */
        if (state._resumeDebounce) clearTimeout(state._resumeDebounce);
        /* 180 ms d anti-rebond s ajoutaient telles quelles au blanc de reprise.
           40 ms suffisent a absorber le clignotement visible/cache d une
           bascule d application. */
        state._resumeDebounce = setTimeout(function () {
          state._resumeDebounce = 0;
          if (isPageAudible()) resumeFromForeground(trigger || "sync");
        }, 40);
      } else {
        if (state._resumeDebounce) {
          clearTimeout(state._resumeDebounce);
          state._resumeDebounce = 0;
        }
        pauseForBackground(trigger || "sync");
      }
    }

    state.isPageAudible = isPageAudible;

    function isBackgroundInactive() {
      if (!isPageAudible()) return true;
      if (state._backgroundMuted || state._backgroundPausing) return true;
      /* Mobile: clipboard / system sheets fire window.blur without a matching
       * focus, and hasFocus() stays false after Copy Link — that was leaving
       * the fractal freeze_bg stuck after Share closed. Only hard-hide counts. */
      if (isMobileUa()) return false;
      /* Desktop: soft blur / unfocused window also freezes the shader clock. */
      if (state.audioReady && state._outputFadedIn && !state._outputAllowed) return true;
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        if (typeof document.hasFocus === "function" && !document.hasFocus()) return true;
      }
      return false;
    }

    /* Clipboard / Android system UI can blur without focus returning; a
     * subsequent touch inside the page should unduck audio immediately. */
    function clearSoftBlurIfVisible() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden")
        return;
      if (state._backgroundMuted || state._backgroundPausing) return;
      if (state._outputAllowed) return;
      state._outputAllowed = 1;
      state._warmupReadyCount = 0;
      state._outputFadedIn = 0;
      state._unlockFadePending = 1;
    }

    state.isBackgroundInactive = isBackgroundInactive;
    state.clearSoftBlurIfVisible = clearSoftBlurIfVisible;

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
      state._warmupReleaseAllowed = 0;
      try {
        if (state.audioCtx && state.audioCtx.state !== "closed") state.audioCtx.close();
      } catch (e2) {}
      state.audioCtx = null;
      state.audioPath = "";
      state._backgroundMuted = 0;
      if (state._wakeSink) state._wakeSink();   /* annule l extinction commandee */
      state._backgroundPausing = 0;
      state._outputAllowed = 1;
      state._dacDetached = 0;
    }

    /* Master gain before destination — mute soft on reload/teardown and hold
     * silence until the PCM FIFO is primed (avoids first-tap underrun clicks). */
    function ensureOutputGain(ctx) {
      if (state.outputGain && state.outputGain.context === ctx) return state.outputGain;
      var g = ctx.createGain();
      g.gain.value = 0;
      g.connect(ctx.destination);
      state.outputGain = g;
      state._outMon = null;      /* le moniteur suivait l ancien gain */
      state._outputFadedIn = 0;
      state._warmupReadyCount = 0;
      state._warmupWaitTicks = 0;
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
      /* Ceinture : jamais de fondu d ouverture sur un puits reste eteint. Une
         extinction commandee qui ne serait pas annulee vaudrait un silence
         definitif, ce qui est le pire defaut possible ici. */
      if (state._wakeSink) state._wakeSink();
      /* Le puits fera son propre fondu, accroche au premier son reel. */
      try {
        if (!SOUND_SIMPLE_MODE && state.worklet && state.worklet.port)
          state.worklet.port.postMessage({
            type: "reopen-ramp",
            frames: Math.round(0.250 * (state.sampleRate || 48000))
          });
      } catch (eRR) {}
      g = gNode.gain;
      t = ctx.currentTime;
      /* The Worklet's own ramp often expires while it is consuming silent
       * warm-up PCM. Keep a short output-stage ramp for the actual first note. */
      /* Une reprise apres veille remonte sur un flux qui vient de repartir :
         un fondu de 50 ms y laisse passer le moindre accroc. On l allonge. */
      dur = Math.max(state.mobile ? 0.05 : 0.03,
        state.unlockFadeSec > 0 ? state.unlockFadeSec : 0.02);
      if (reason === "fifo-ready" && state._resumedOnce) dur = Math.max(dur, 0.18);
      try {
        g.cancelScheduledValues(t);
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(SOUND_OUTPUT_LEVEL, t + dur);
      } catch (eFade) {
        try {
          g.value = SOUND_OUTPUT_LEVEL;
        } catch (e2) {}
      }
      /* Mi-rampe : au-dela, une famine redevient audible et doit compter. */
      try {
        if (state._unmuteTimer) clearTimeout(state._unmuteTimer);
        state._unmuteTimer = setTimeout(function () {
          state._unmuteTimer = 0;
          tellSinkMuted(0);
        }, ((dur * 1000 * 0.5) | 0) + 1);
      } catch (eUM) { tellSinkMuted(0); }
      try {
        var _nw = (typeof performance !== "undefined" && performance.now)
          ? performance.now() : Date.now();
        if (state._unlockAtMs && !state._openMarkDone) {
          state._openMarkDone = 1;
          dlog("[sound_bus] >>>>>> LE SON COMMENCE ICI : " +
            Math.round(_nw - state._unlockAtMs) + " ms apres le toucher <<<<<<");
        }
        dlog("[sound_bus] output fade-in (" + (reason || "primed") + ")" +
          (state._silenceSinceMs
            ? " | SILENCE " + Math.round(_nw - state._silenceSinceMs) + "ms" +
              " file=" + (state.stats ? (state.stats.queuedFrames | 0) : -1) +
              " cible=" + (state.targetFrames | 0) +
              " ticks=" + (state._warmupWaitTicks | 0)
            : ""));
        state._silenceSinceMs = 0;
        state._reOpenAt = 0; state._rePeak = 0;
      } catch (eLog) {}
      try {
        if (state._envTimer) clearTimeout(state._envTimer);
        state._envTimer = setTimeout(function () {
          state._envTimer = 0;
          dumpOutEnv("ouverture (" + (reason || "?") + ")");
        }, 800);
      } catch (eE) {}
    }

    function flattenLatencyBeforeOpen(reason) {
      /* While muted, worklet underruns still inflate FIFO/boost. Flatten before
       * opening the gain or the first audible touch rides a huge backlog. */
      try {
        if (state.worklet && state.worklet.port)
          state.worklet.port.postMessage({
            type: "reset-latency",
            /* Tout bloc commence avant cette marque est perime. */
            after: state._txFrames | 0
          });
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
        dlog("[sound_bus] flatten latency (" + (reason || "?") + ")");
      } catch (e3) {}
    }

    /* Pourquoi la sortie reste fermee, au plus une ligne par 400 ms. */
    function warmupWaitLog(why) {
      if (!SOUND_DIAG) return;
      var now = (typeof performance !== "undefined" && performance.now)
        ? performance.now() : Date.now();
      if (now - (state._warmupLogMs || 0) < 400) return;
      state._warmupLogMs = now;
      try {
        dlog("[sound_bus] attente reprise : " + why +
          " | rapports=" + (state._warmupReadyCount | 0) +
          " ticks=" + (state._warmupWaitTicks | 0) +
          " depuis=" + Math.round(now - (state._silenceSinceMs || now)) + "ms");
      } catch (e) {}
    }

    function maybeReleaseWarmup(queued) {
      var need = state.needFrames > 0 ? state.needFrames | 0 : 768;
      /* Ouvrir le DAC des 768 frames, c est demarrer la sortie sur 16 ms de
         reserve : la premiere seconde partait systematiquement en famines, et
         au retour de veille aussi (le trim vide la file, puis on rouvre trop
         tot). On attend la moitie de la cible que le producteur a annoncee.
         Garde-fou : si cette profondeur n arrive jamais, on retombe sur le
         seuil d origine plutot que de rester muet. */
      /* LA CIBLE ANNONCEE N EST PAS UNE PROFONDEUR ATTEIGNABLE.
         Le producteur annonce target*1.4 (marge de securite) et cette valeur
         redescend lentement apres une perturbation. Mesure : cible annoncee
         12593 frames (262 ms) alors que la file reelle plafonne a 100 ms.
         Exiger la moitie de l annonce (131 ms) etait donc INSATISFIABLE : on
         attendait le garde-fou, soit 60 rapports de 42.7 ms = 2.6 SECONDES de
         silence. C est exactement le grand blanc apres un reveil.
         Deux bornes : la profondeur exigee ne depasse jamais 80 ms, et
         l attente ne depasse jamais 8 rapports (~340 ms). Au-dela on ouvre sur
         le seuil de base — la rampe de 180 ms couvre le reste. */
      /* MESURE DECISIVE : need valait 4096 frames (85 ms) alors que le
         producteur tient une file de 77 a 87 ms. La porte demandait donc
         EXACTEMENT la profondeur de croisiere : passer ou pas etait un coup de
         des, d ou les reprises tantot immediates tantot a 2822 ms, et le
         "il faut toucher une deuxieme fois".
           attente reprise : file 3212/4096  ticks=11
           attente reprise : file 3296/4096  ticks=21
           attente reprise : file 3344/4096  ticks=31
           attente reprise : file 3006/4096  ticks=41  -> elle REDESCEND
         Une porte doit etre franchement sous le regime nominal, jamais dessus.
         Exigence initiale : 60 ms au plus. Secours ferme apres 8 rapports
         (~340 ms) : 30 ms, la rampe d ouverture couvre le reste. */
      var deep = ((state.targetFrames | 0) * 0.5) | 0;
      var cap  = ((state.sampleRate || 48000) * 0.060) | 0;
      var slow = ((state.sampleRate || 48000) * 0.030) | 0;
      if (deep > cap) deep = cap;
      if (state._outputFadedIn) return;
      if (!state.audioReady) return;
      if (!state._warmupReleaseAllowed) return;
      /* ===================== EXPERIENCE, PAS UNE CORRECTION =====================
         Au premier toucher, le moniteur de sortie ne voit RIEN : pas de clic
         (aucun '#' dans l enveloppe), pas de trou, pas de rafale. La montee est
         un fondu propre de ~250 ms depuis le silence. Le bruit entendu n est
         donc pas dans les echantillons qu on envoie.
         Reste une hypothese physique : sur beaucoup de telephones Android,
         l OUVERTURE du peripherique audio fait elle-meme un "pop" — c est
         l ampli qui s allume, pas notre signal.
         Pour trancher, on retarde la premiere ouverture du gain de 1,5 s.
         Le peripherique, lui, demarre des le toucher et emet du silence.
           - si le pop reste PILE au toucher  -> c est le materiel
           - s il se deplace 1,5 s plus tard  -> c est notre signal
         Une seule mesure suffit a fermer la question. */
      /* ============ PRE-ROLL PROFOND AU TOUT PREMIER DEMARRAGE ============
       |
       | Preuve dans tes journaux : la minuterie audio de 10 ms a saute
       |     [accum] re-ancrage (interruption, 527 ms)
       |     [accum] re-ancrage (interruption, 609 ms)
       | pendant le demarrage. Le producteur vit sur le FIL PRINCIPAL, et ce
       | fil est bloque une demi-seconde pendant l init WASM + WebGPU + les 14
       | shaders + IDBFS + la police + le spike. Ta remarque sur le second fil
       | vise exactement ca.
       |
       | Deplacer la production dans un worker est le vrai correctif, mais le
       | chemin compute a besoin du device WebGPU, qui vit sur le fil principal
       | — c est un chantier, pas un correctif de ce soir.
       |
       | En attendant, la parade qui coute zero : au PREMIER demarrage
       | seulement, on ne s ouvre pas sur une file mince. On attend 250 ms de
       | reserve — de quoi encaisser une interruption de 250 ms — avec un
       | secours a 3 s pour ne jamais rester muet. Les reprises ne sont pas
       | touchees : elles n ont pas cette tempete d init. */
      /* CORRECTION : la version precedente exigeait 250 ms (12000 trames) que
         le producteur ne fournit JAMAIS — il tient 45 a 90 ms. On tombait donc
         systematiquement dans le secours de 3 s, puis on ouvrait sur une file
         vide : 3 s de silence PUIS un trou. Meme faute que les deux barrieres
         de chauffe precedentes.
         Ici on ne fixe plus de chiffre : on observe la file 300 ms, on retient
         sa CRETE, et on ouvre sur une crete (85 % du maximum vu). On s ouvre
         donc sur une file pleine quelle que soit la profondeur du producteur. */
      /* ================== MEME PRUDENCE A LA REPRISE ==================
         Mesure dans les journaux d une reprise :
             trim latency (visibility, hard) ... out=104ms
             [accum] re-ancrage (file videe par le bus, 19 ms)
             output fade-in (fifo-ready) | SILENCE 537ms file=3808 cible=8822
         On VIDE la file pour rattraper la latence accumulee, puis on rouvre le
         son alors qu elle n est remplie qu a 43 %. Le producteur n a pas fini
         de refaire sa reserve, et le moindre a-coup — juste au retour au
         premier plan, quand le systeme est le plus charge — devient un trou.
         C est le glitch subtil de reprise.
         On applique donc la meme regle qu au demarrage : on observe la file,
         on retient sa crete, et on rouvre sur une crete. Borne par la cible
         courante et plafonnee a 400 ms pour ne jamais rester muet. */
      if (!state._unlockFadePending && state._silenceSinceMs &&
          !state._backgroundPausing && state._outputAllowed) {
         var nowR = (typeof performance !== "undefined" && performance.now)
           ? performance.now() : Date.now();
         if (!state._reOpenAt) { state._reOpenAt = nowR; state._rePeak = 0; }
         var qR = queued | 0;
         if (qR > (state._rePeak | 0)) state._rePeak = qR;
         var wantR = (((state._rePeak | 0) * 85) / 100) | 0;
         var tgtR = ((((state.targetFrames | 0) || 6144) * 70) / 100) | 0;
         if (tgtR > 0 && wantR > tgtR) wantR = tgtR;
         var floorR = ((state.sampleRate || 48000) * 0.050) | 0;
         if (wantR < floorR) wantR = floorR;
         var waitedR = nowR - state._reOpenAt;
         if ((qR < wantR || waitedR < 80) && waitedR < 400) {
            state._warmupReadyCount = 0;
            warmupWaitLog("reprise " + qR + "/" + wantR +
              " (crete " + (state._rePeak | 0) + ", cible " +
              (state.targetFrames | 0) + ", " + Math.round(waitedR) + "/400ms)");
            return;
         }
      }
      if (state._unlockFadePending) {
         var nowP = (typeof performance !== "undefined" && performance.now)
           ? performance.now() : Date.now();
         if (!state._firstOpenAt) {
            state._firstOpenAt = nowP; state._firstPeak = 0; state._peakAt = nowP;
         }
         var q0 = queued | 0;
         if (q0 > (state._firstPeak | 0)) { state._firstPeak = q0; state._peakAt = nowP; }
         /* ATTENDRE LE PLATEAU, PAS UN CHIFFRE.
            La crete seule ne vaut rien juste apres un vidage de file : elle
            n est que "la ou la file en est arrivee", pas "la file est pleine".
            Les journaux le montrent — on rouvrait a file=3468/6144, soit 56 %,
            parce que la crete du moment valait 3468.
            Le vrai signe qu une file est pleine, c est qu elle ARRETE DE
            MONTER. On attend donc que la crete ne progresse plus pendant
            150 ms. Aucun seuil absolu, aucune hypothese sur le producteur :
            ca marche a 40 ms de reserve comme a 300 ms. */
         var flat = nowP - (state._peakAt || nowP);
         var waitedP = nowP - state._firstOpenAt;
         if (flat < 150 && waitedP < 700) {
            state._warmupReadyCount = 0;
            warmupWaitLog("remplissage " + q0 + " (crete " + (state._firstPeak | 0) +
              ", stable depuis " + Math.round(flat) + "ms, " +
              Math.round(waitedP) + "/700ms)");
            return;
         }
         /* La crete seule ne suffit pas : au demarrage targetFrames descend
            de 9280 a 6144, donc une crete relevee tot (9916) devient
            inatteignable et on tombait dans le secours — 1,2 s d attente pour
            rien. On borne par la cible COURANTE. */
         var crest = (((state._firstPeak | 0) * 85) / 100) | 0;
         var byTarget = ((((state.targetFrames | 0) || 6144) * 75) / 100) | 0;
         if (byTarget > 0 && crest > byTarget) crest = byTarget;
         var floorF = ((state.sampleRate || 48000) * 0.040) | 0;
         if (crest < floorF) crest = floorF;
         var waited = nowP - state._firstOpenAt;
         if ((q0 < crest || waited < 120) && waited < 600) {
            state._warmupReadyCount = 0;
            warmupWaitLog("pre-roll 1er demarrage " + q0 + "/" + crest +
              " (crete " + (state._firstPeak | 0) + ", cible " +
              (state.targetFrames | 0) + ", " +
              Math.round(waited) + "/600ms)");
            return;
         }
      }
      if (SOUND_OPEN_SILENCE_MS > 0 && state._unlockFadePending) {
         var nowU = (typeof performance !== "undefined" && performance.now)
           ? performance.now() : Date.now();
         if (!state._unlockAtMs) {
            state._unlockAtMs = nowU;
            try {
              dlog("[sound_bus] TEST PERIPHERIQUE : le peripherique tourne" +
                " des maintenant, mais la sortie reste a zero numerique pendant " +
                SOUND_OPEN_SILENCE_MS + " ms. Ecoute OU tombe le clac.");
            } catch (e) {}
         }
         if (nowU - state._unlockAtMs < SOUND_OPEN_SILENCE_MS) {
            warmupWaitLog("silence d ouverture " +
              Math.round(nowU - state._unlockAtMs) + "/" + SOUND_OPEN_SILENCE_MS + "ms");
            return;
         }
      }
      if (state._backgroundMuted || state._backgroundPausing || !state._outputAllowed) return;
      state._warmupWaitTicks = (state._warmupWaitTicks | 0) + 1;
      if (state._warmupWaitTicks >= 8) need = slow;
      else if (deep < need) need = deep;
      if ((queued | 0) < need) {
        state._warmupReadyCount = 0;
        warmupWaitLog("file " + (queued | 0) + "/" + need);
        return;
      }
      /* PLEINE N EST PAS STABLE.
         Apres un vidage dur (verrouillage du telephone, changement d onglet) le
         producteur relache un bloc entier d un coup : la file est pleine dans la
         milliseconde, alors que la boucle de rendu, elle, est encore en train de
         se reveiller. On rouvrait donc le DAC pile sur la famine suivante — le
         glitch entendu a chaque reprise. On exige maintenant que la file reste
         pleine ET qu aucune famine nouvelle ne soit survenue. */
      {  var un = state.stats.underruns | 0;
         if (un !== (state._warmupUnderrunMark | 0)) {
            state._warmupUnderrunMark = un;
            state._warmupReadyCount = 0;
            return;
         }
      }
      state._warmupWaitTicks = 0;
      state._warmupReadyCount = (state._warmupReadyCount | 0) + 1;
      /* Quatre rapports consecutifs sains, soit ~170 ms. Le premier
         deverrouillage garde son ouverture immediate : la file y est vierge et
         le fondu d unlock couvre l attaque. */
      var required = state._unlockFadePending ? 1 : 4;
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
      try { if (state._unmuteTimer) { clearTimeout(state._unmuteTimer); state._unmuteTimer = 0; } } catch (eCT) {}
      tellSinkMuted(1);
      try {
        state._silenceSinceMs = (typeof performance !== "undefined" && performance.now)
          ? performance.now() : Date.now();
      } catch (eTS) {}
      try {
        dlog("[sound_bus] output fade-out (" + (reason || "shutdown") + ")");
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
      if (SOUND_LEAVE_MODE === 0 && isTerminalLeaveReason(reason)) {
        try {
          dlog("[sound_bus] depart de page (" + reason +
            ") : ON NE TOUCHE A RIEN (test du clac de fermeture)");
        } catch (eNT) {}
        return;
      }
      cancelBackgroundPause();
      var dur = beginGracefulShutdown(reason);
      var fadeBase = isTerminalLeaveReason(reason)
        ? TERMINAL_LEAVE_FADE_SEC
        : state.mobile
          ? PHONE_LOCK_FADE_SEC
          : 0.20;
      /* FAUTE CORRIGEE : on attendait 42 ms au maximum avant de fermer, alors
         que le peripherique a 45 ms de retard (base=45ms dans tes journaux).
         Le fondu de 25 ms n avait donc JAMAIS atteint le haut-parleur quand
         on coupait : le DAC etait tranche a pleine amplitude. C est
         exactement le claquement de fermeture.
         Il faut attendre fondu + latence du peripherique. */
      /* Combien de temps le fondu met-il a ATTEINDRE le haut-parleur.
         Attention : Android annonce outputLatency=0 (voir "sortie=0ms" dans
         les journaux), ce qui est faux — il n a simplement pas la mesure. On
         ne fait donc pas confiance a la somme brute : on prend une marge de
         50 % sur la latence de base, plus 20 ms fixes. Mieux vaut attendre
         30 ms de trop que couper 5 ms trop tot : c est cette troncature qui
         faisait le claquement. */
      var latMs = 0;
      try {
        var cL = state.audioCtx;
        if (cL) {
          var b = (cL.baseLatency || 0) * 1000;
          var o = (cL.outputLatency || 0) * 1000;
          latMs = b + o;
          if (latMs < b * 1.5) latMs = b * 1.5;
        }
      } catch (eL) {}
      if (!(latMs > 0)) latMs = SOUND_DEVICE_LATENCY * 1000;
      latMs += 20;
      /* MEME FAUTE SUR LE CHEMIN DE LA MISE EN VEILLE : on attendait
         "fondu + 15 ms" sans compter la latence du peripherique. Le fondu
         n atteignait donc pas le haut-parleur avant suspend() — c est le
         petit clac au passage en arriere-plan dont tu te plaignais. Meme
         calcul des deux cotes. */
      var waitMs = (((dur > 0 ? dur : fadeBase) * 1000) + latMs) | 0;
      /* Le plafond doit etre AU-DESSUS du besoin reel, jamais en dessous :
         un plafond qui tronque l attente reproduit exactement le defaut
         qu on cherche a eviter. */
      if (waitMs > 260) waitMs = 260;
      try {
        dlog("[sound_bus] depart (" + reason + ") : fondu " +
          Math.round((dur > 0 ? dur : fadeBase) * 1000) + "ms + latence " +
          Math.round(latMs) + "ms -> attente " + waitMs + "ms avant " +
          (isTerminalLeaveReason(reason) ? "close()" : "suspend()"));
      } catch (eLg) {}
      busyWaitMs(waitMs);
      silenceScriptSink();
      muteOutputNow();
      var ctx = state.audioCtx;
      if (ctx && ctx.state === "running") {
        try {
          /* FERMER, PAS SUSPENDRE, QUAND LA PAGE PART POUR DE BON.
           |
           | Ton test le dit : au tout premier demarrage, aucun glitch. Il
           | n apparait qu au rechargement — donc uniquement quand un flux
           | audio precedent existe. Ce n est pas du contenu, c est la
           | fermeture/reouverture du flux de sortie du systeme.
           |
           | suspend() GARDE le peripherique ouvert. La page est ensuite
           | detruite par le navigateur, et le flux est arrache en plein
           | milieu d un tampon : c est le claquement de fermeture. Puis la
           | nouvelle page en ouvre un second pendant que le premier agonise :
           | c est le claquement au toucher suivant.
           |
           | close() rend explicitement le peripherique. Le flux se termine
           | proprement, et il est libre quand la page suivante le redemande.
           | C est la seule chose que l on controle dans cette histoire. */
          var term = isTerminalLeaveReason(reason);
          var sus = null;
          if (!term) sus = ctx.suspend();
          else if (SOUND_LEAVE_MODE === 1) sus = ctx.close();
          else if (SOUND_LEAVE_MODE === 2) sus = ctx.suspend();
          if (!term && sus && typeof sus.then === "function") {
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
        dlog("[sound_bus] soft mute teardown (" + (reason || "?") + ")");
      } catch (e6) {}
    }
    state.softMuteTeardown = softMuteTeardown;

    function ensureAudioContext() {
      if (state.audioCtx) return state.audioCtx;
      var AC = global.AudioContext || global.webkitAudioContext;
      /* Prefer engine clock (44.1k) so worker can skip resample â†’ fewer clicks. */
      /* PROFONDEUR DU TAMPON DU PERIPHERIQUE.
         Mesure : [audio-dev] DECROCHAGE 39ms puis 21ms — l horloge audio en
         retard sur l horloge murale au moment d une reprise, donc 60 ms de son
         que le systeme n a pas joues. Avec "interactive", Android donne un
         tampon de l ordre de 20 ms : le moindre a-coup le vide.
         0.045 demande ~45 ms. C est un COMPROMIS : un peu de latence en plus
         sur les effets, contre une marge doublee face aux a-coups. */
      var acOpts = {
        latencyHint: SOUND_DEVICE_LATENCY,
        sampleRate: state.synthRate > 0 ? state.synthRate | 0 : 48000
      };
      var ctx;
      try {
        ctx = new AC(acOpts);
      } catch (eAc) {
        ctx = new AC({ latencyHint: SOUND_DEVICE_LATENCY });
      }
      state.audioCtx = ctx;
      state.sampleRate = ctx.sampleRate | 0;
      try {
        dlog("[sound_bus] latence peripherique : base=" +
          Math.round((ctx.baseLatency || 0) * 1000) + "ms sortie=" +
          Math.round((ctx.outputLatency || 0) * 1000) + "ms (demande " +
          Math.round(SOUND_DEVICE_LATENCY * 1000) + "ms)");
      } catch (eL) {}
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
    /* Mettre a 1 pour reactiver l aide au deverrouillage par element <audio>.
       Voir le commentaire dans primeHtmlMedia. */
    var SOUND_USE_HTML_MEDIA_PRIME = 0;

    function primeHtmlMedia() {
      /* SUSPECT NUMERO UN DU POP AU DEMARRAGE.
       |
       | Le sinus d etalonnage a prouve que le signal est parfait : ecart a la
       | recurrence = 0.00000 sur 48000 frames par seconde, six secondes de
       | suite, et une enveloppe d ouverture en escalier monotone 1-2-3-4. Le
       | pop entendu n est donc PAS un echantillon que nous emettons.
       |
       | Reste ce qui OUVRE le peripherique. Cet element <audio> muet demarre
       | un flux media SEPARE du contexte audio, avec son propre ouvrir/fermer
       | cote systeme — et sur Android c est un declencheur de pop connu. Il
       | n est la que comme aide au deverrouillage sur de vieux WebView ; le
       | journal montre ctx=running juste apres resume(), donc il ne sert
       | probablement plus a rien ici.
       | On le coupe pour trancher. Si le deverrouillage cassait sur un
       | appareil, remettre SOUND_USE_HTML_MEDIA_PRIME a 1. */
      if (!SOUND_USE_HTML_MEDIA_PRIME) {
        if (!state._htmlPrimeLogged) {
          state._htmlPrimeLogged = 1;
          try { dlog("[sound_bus] aide <audio> desactivee (test du pop)"); } catch (e) {}
        }
        return;
      }
      if (!state.mobile) return;
      try {
        var a = state._silentAudio;
        if (!a) {
          /* Minimal WAV â€” HTMLMediaElement.play() carries stronger gesture
           * activation on Android WebView than AudioContext.resume() alone. */
          a = new Audio(
            "data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA"
          );
          a.preload = "auto";
          /* Activation aid only: never open a second audible media path. */
          a.defaultMuted = true;
          a.muted = true;
          a.volume = 0;
          a.playsInline = true;
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

    /* ================= TEST NU : NOTRE CODE, OU LA PLATEFORME ? =================
     |
     | Un OscillatorNode branche DIRECTEMENT sur ctx.destination. Pas de
     | worklet, pas de file, pas de GPU, pas de fondu, pas de gestion de cycle
     | de vie — rien de ce que j ai ecrit. Juste le navigateur qui produit un
     | sinus.
     |
     | C est le seul moyen de trancher, et il ne laisse aucune place a
     | l interpretation :
     |   - tu entends TOUJOURS le gros glitch au demarrage  -> il vient de
     |     l ouverture du peripherique par Android/Chrome, et aucune ligne de
     |     notre code ne peut l empecher.
     |   - le demarrage est PROPRE                          -> il vient de
     |     notre chemin, et je cherche dans un espace enfin reduit.
     |
     | Pendant ce test notre propre sortie est mise a zero : ce que tu entends
     | ne peut venir que de l oscillateur. Remettre SOUND_BARE_OSC_TEST a 0
     | apres (declare plus haut, avec SOUND_OUTPUT_LEVEL). */
    function startBareOscTest() {
      var ctx = state.audioCtx, osc, g;
      if (!SOUND_BARE_OSC_TEST || state._bareOsc) return;
      if (!ctx || ctx.state !== "running") return;
      try {
        g = ctx.createGain();
        g.gain.value = 0.17;          /* meme niveau que le sinus d etalonnage */
        osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = 330;    /* 330, pas 440 : impossible a confondre */
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start();
        state._bareOsc = osc;
        dwarn("[sound_bus] TEST NU : oscillateur 330 Hz direct sur le DAC, " +
          "notre sortie est coupee. Si le glitch de demarrage persiste, " +
          "il ne vient pas de notre code.");
      } catch (eO) {
        try { dlog("[sound_bus] test nu impossible : " + eO); } catch (e2) {}
      }
    }

    /* ============== DECROCHAGE DU PERIPHERIQUE AUDIO ==============
     |
     | C est le SEUL endroit ou un defaut peut encore se cacher, et je n avais
     | aucun instrument dessus.
     |
     | Le moniteur de sortie est un noeud DANS le graphe : il voit les
     | echantillons CALCULES. Il ne peut pas voir si le systeme les a
     | reellement JOUES. Si la couche audio d Android rate son echeance, elle
     | insere un blanc ou repete un tampon — et aucun noeud du graphe n en sait
     | rien. C est exactement compatible avec ce qu on observe : un sinus
     | mathematiquement exact (ecart 0.00000) et des clics entendus.
     |
     | La mesure : l horloge du contexte audio n avance que si le peripherique
     | consomme. On la compare a l horloge murale. Si l audio prend du retard
     | sur le mur, c est que le peripherique a cale, et l ecart EST la duree du
     | trou. Un blocage du fil principal ne fausse pas la mesure : dans ce cas
     | les deux horloges avancent pareil. */
    function checkDeviceStall() {
      var ctx = state.audioCtx, aw, an, dw, da, skew;
      if (!ctx || ctx.state !== "running") { state._clkA = 0; return; }
      an = ctx.currentTime;
      aw = (typeof performance !== "undefined" && performance.now)
        ? performance.now() / 1000 : Date.now() / 1000;
      if (!state._clkA) { state._clkA = an; state._clkW = aw; return; }
      da = an - state._clkA;
      dw = aw - state._clkW;
      state._clkA = an; state._clkW = aw;
      if (dw <= 0 || dw > 1.0) return;          /* intervalle inexploitable */
      /* MA MESURE PRECEDENTE ETAIT FAUSSE, ET SES PROPRES CHIFFRES LE DISENT.
       | ctx.currentTime n avance pas continument : il saute d un bloc de rendu
       | a l autre. Echantillonne toutes les 42 ms, ca donne « audio 3ms » puis
       | « audio 32ms » — de la QUANTIFICATION, pas des trous. La preuve : le
       | cumul oscillait entre -32 et +90 ms sans jamais croitre, et un ecart
       | NEGATIF est impossible pour une vraie perte.
       | On accumule donc sur 5 s. Sur cette duree la quantification s annule :
       | une derive d horloge donne un taux constant en ppm, une perte reelle
       | donne un deficit qui grandit fenetre apres fenetre. */
      state._clkSum = (state._clkSum || 0) + (dw - da);
      state._clkWin = (state._clkWin || 0) + dw;
      if (state._clkWin >= 5.0) {
        var def = state._clkSum, ppm = (def / state._clkWin) * 1e6;
        var grave = def > 0.030;
        try {
          dlog("[audio-dev] " + (grave ? "PERTE " : "horloge ") +
            Math.round(def * 1000) + "ms sur " + state._clkWin.toFixed(1) + "s (" +
            Math.round(ppm) + " ppm)" +
            (grave ? "   <<<< le peripherique n a pas joue ce son" :
             "  — derive normale, aucune perte"));
        } catch (eS) {}
        state._clkSum = 0; state._clkWin = 0;
      }
    }

    /* Vrai etat de la sortie, transmis au puits. Enveloppe conservatrice :
       ferme des le debut du fondu de sortie, rouverte a mi-rampe d ouverture. */
    function tellSinkMuted(muted) {
      try {
        if (state.worklet && state.worklet.port)
          state.worklet.port.postMessage({ type: "output-muted", muted: muted ? 1 : 0 });
      } catch (eTM) {}
    }

    /* Demande au moniteur l enveloppe des 2.5 dernieres secondes de la SORTIE. */
    function dumpOutEnv(why) {
      try {
        if (state._outMon) {
          state._outEnvWhy = why || "?";
          state._outMon.port.postMessage({ type: "dump" });
        }
      } catch (eD) {}
    }

    /* Une case = 5 ms de sortie reelle. '.' = silence, 1..9 = niveau, '#' = sature.
       On lit la forme du defaut au lieu de la deduire : une rafale saute a 9,
       un trou creuse des '.', une coupure franche passe de 7 a '.' en une case. */
    function renderOutEnv(d) {
      var env = d.env, n = env ? env.length : 0, i, v, c, line = "", shown = 300;
      if (!n) return;
      for (i = n - shown; i < n; i++) {
        v = env[i] || 0;
        if (v < 0.001) c = ".";
        else if (v >= 0.95) c = "#";
        else {
          c = Math.round(Math.sqrt(v) * 9);
          if (c < 1) c = 1; if (c > 9) c = 9;
          c = "" + c;
        }
        line += c;
      }
      try {
        dwarn("[audio-env] " + (state._outEnvWhy || "?") +
          " | 1 case = 5ms, 1.5s, la plus recente a DROITE\n" +
          line.slice(0, 100) + "\n" + line.slice(100, 200) + "\n" + line.slice(200, 300));
      } catch (eR) {}
    }

    /* Sonde branchee APRES state.outputGain, donc sur le signal reel du DAC.
       Elle n emet rien (numberOfOutputs 0) et ne modifie pas la chaine. */
    function attachOutputMonitor(ctx) {
      /* Sans diagnostics, on ne CONSTRUIT meme pas le moniteur : c est un
         AudioWorkletNode de plus sur le fil audio, plus une analyse par bloc
         (enveloppe, detection de marche, verificateur de sinus). Economie
         reelle, pas seulement du journal en moins. */
      if (!SOUND_DIAG) return;
      if (!ctx || state._outMon) return;
      var g, m;
      try {
        g = ensureOutputGain(ctx);
        m = new AudioWorkletNode(ctx, "spin-output-monitor", {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 2,
          channelCountMode: "explicit",
          channelInterpretation: "speakers"
        });
      } catch (eM) {
        try { dlog("[sound_bus] moniteur de sortie indisponible : " + eM); } catch (e0) {}
        return;
      }
      m.port.onmessage = function (ev) {
        var d = ev.data || {};
        if (d.type === "out-env") { renderOutEnv(d); return; }
        if (d.type === "tone-check") {
          /* max = pire ecart a la recurrence du sinus, sur 1 s de sortie.
             En regime nominal il doit rester sous ~0.001. Tout ce qui monte
             au-dessus de 0.01 est un defaut FABRIQUE par la chaine, et sa
             valeur est directement l amplitude du defaut. */
          var gv2 = 0;
          try { gv2 = state.outputGain ? state.outputGain.gain.value : 0; } catch (e9) {}
          try {
            dwarn("[audio-sin] " + d.hz + "Hz | ecart max=" + (+d.max).toFixed(5) +
              " frames>0.01=" + (d.bad | 0) + "/" + (d.win | 0) +
              " crete=" + (+d.peak).toFixed(3) +
              " gain=" + gv2.toFixed(3) +
              " t=" + (+d.at).toFixed(2) + "s" +
              (d.max > 0.01 ? "   <<<< DEFAUT" : ""));
          } catch (e10) {}
          return;
        }
        var gv = 0, sr = state.sampleRate || 48000, what, val;
        if (d.type !== "out-glitch") return;
        try { gv = state.outputGain ? state.outputGain.gain.value : 0; } catch (eG) {}
        what = d.kind === 2 ? "TROU  " : "MARCHE";
        val = d.kind === 2
          ? ((d.amp * 1000) / sr).toFixed(1) + "ms"
          : (+d.amp).toFixed(4);
        try {
          dwarn(
            "[audio-out] " + what + " " + val +
            " =x" + (d.thr > 0 ? (d.amp / d.thr).toFixed(1) : "-") +
            " seuil=" + (+d.thr || 0).toFixed(4) +
            " crete=" + (+d.peak || 0).toFixed(3) +
            " gain=" + gv.toFixed(3) +
            " audible=" + (gv > 0.02 ? "OUI" : "non") +
            " t=" + (+d.t || 0).toFixed(2) + "s #" + d.n +
            " | phase=" + (state._backgroundMuted ? "fond"
                        : state._backgroundPausing ? "mise-en-fond"
                        : state._shutdownBegun ? "fermeture"
                        : state._outputFadedIn ? "nominal" : "ouverture")
          );
        } catch (eW) {}
      };
      try { g.connect(m); } catch (eC) { return; }
      state._outMon = m;
      /* Etalonnage : doit correspondre a ssound_accum_test_hz cote C. */
      /* Verificateur de sinus : doit correspondre a ssound_accum_test_hz. */
      if (SOUND_WORKLET_SELFTEST_HZ > 0) {
        try { m.port.postMessage({ type: "tone", hz: SOUND_WORKLET_SELFTEST_HZ }); }
        catch (eT) {}
      }
      try {
        dlog("[sound_bus] moniteur de sortie actif (dernier etage avant le DAC)");
      } catch (eL) {}
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
          unlockFadeSec: state.unlockFadeSec,
          /* A deeper FIFO hid overload by adding audible beat latency. Keep
           * only a short temporary cushion. */
          bufferBoostMax: state.mobile ? 1024 : 1536,
          bufferBoostStep: 512,
          healthyQuantaTarget: state.mobile ? 600 : 800
        }
      });
      try { attachOutputMonitor(ctx); } catch (eMon) {}
      try {
        if (SOUND_WORKLET_SELFTEST_HZ > 0) {
          node.port.postMessage({ type: "selftest", hz: SOUND_WORKLET_SELFTEST_HZ });
          dwarn("[sound_bus] SINUS SUR LE FIL AUDIO : " +
            SOUND_WORKLET_SELFTEST_HZ + " Hz genere dans le worklet. " +
            "Le fil principal n a plus rien a livrer.");
        }
        if (SOUND_SIMPLE_MODE) {
          node.port.postMessage({ type: "simple", on: 1 });
          dwarn("[sound_bus] MODE SIMPLE : rampes, coutures, " +
            "dissimulation, extinction et vidage DESACTIVES");
        }
      } catch (eSm) {}
      node.port.onmessage = function (ev) {
        var msg = ev.data || {};
        if (msg.type === "fifo-ready") {
          maybeReleaseWarmup(msg.queuedFrames | 0);
          return;
        }
        if (msg.type === "stats") {
          state.stats.underruns = msg.underruns | 0;
          state.stats.anomalies = msg.anomalies | 0;
          state.stats.concealUnderruns = msg.concealUnderruns | 0;
          state.stats.concealSeams = msg.concealSeams | 0;
          state.stats.lastPeriod = msg.lastPeriod | 0;
          state.stats.lastScore = +msg.lastScore || 0;
          state.stats.lastTonal = msg.lastTonal | 0;
          state.stats.underrunFrames = msg.underrunFrames | 0;
          state.stats.maxGapMs = +msg.maxGapMs || 0;
          state.stats.minQueuedFrames = msg.minQueuedFrames | 0;
          state.stats.fillWaitMs = +msg.fillWaitMs || 0;
          state.stats.fillWaitMaxMs = +msg.fillWaitMaxMs || 0;
          state.stats.bufferBoostFrames = msg.bufferBoostFrames | 0;
          state.stats.queuedFrames = msg.queuedFrames | 0;
          state._qMark = msg.queuedFrames | 0;
          state._rxMark = msg.rxFrames | 0;
          state._qMarkTime = state.audioCtx ? state.audioCtx.currentTime : -1;
          if (msg.mode === "inline") state.stats.voices = msg.voices | 0;
          state.stats.audioMode = msg.mode || (state.inlineSynth ? "inline" : "pcm");
          checkDeviceStall();
          maybeReleaseWarmup(msg.queuedFrames | 0);
          maybeLogAudioHealth(msg);
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
      if (state.mainThreadPcm) {
        node.port.postMessage({
          type: "set-thresholds",
          needFrames: state.needFrames,
          targetFrames: state.targetFrames
        });
        connectAudioOut(node, ctx);
        state.worklet = node;
        state.audioPath = "worklet-pcm";
        markAudioReadyIfRunning();
        return;
      }
      var channel = new MessageChannel();
      state.audioPort = null; /* source port is owned by the AudioWorkletNode */
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
        dlog("[sound_bus] worklet source cached (addModule deferred until after resume)");
      } catch (eWarm) {
        dwarn("[sound_bus] worklet prefetch failed (will retry on gesture)", eWarm);
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
        dlog("[sound_bus] one-shot: detached legacy Sokol saudio (rebuild App.wasm to skip)");
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
    state.captureAudio = function (seconds) {
      if (!state.worker) return 0;
      state.captureState = "requested";
      state.worker.postMessage({ type: "capture_pcm", seconds: seconds || 5 });
      return 1;
    };

    /* FILE EXTRAPOLEE — le capteur de la boucle de production.
    |
    | Le worklet ne rapporte sa file que tous les 16 quanta, soit ~42 ms. Entre
    | deux rapports le producteur ne la voyait que MONTER (ses propres pushes)
    | et jamais descendre, alors que le puits consomme en continu. Il lisait
    | donc une avance trop grande, sous-produisait, et le FIFO se vidait — sur
    | une machine a 75 fps dont le pire intervalle de frame est 10 ms.
    |
    | Le bus est le seul endroit qui connaisse a la fois la derniere mesure et
    | l horloge du contexte audio. Il extrapole : ce qui restait, moins ce qui a
    | ete joue depuis, plus ce qui a ete pousse depuis. Plus de retard. */
    /* Compteur de vidages. Le producteur le lit : quand il change, il sait que
       la file a ete jetee et que tout ce qu il a en vol est perime — sans avoir
       a le deduire d une duree d interruption. */
    state._flushEpoch = 0;
    state._qMark = 0;        /* file rapportee par le puits */
    state._rxMark = 0;       /* total recu par le puits a cet instant */
    state._txFrames = 0;     /* total envoye par le bus, monotone */
    state._qMarkTime = -1;
    /* COMPTABILITE EXACTE, PLUS D ESTIMATION QUI SE PERD.
     |
     | On ajoutait les frames poussees a la derniere mesure, puis le rapport de
     | stats suivant ECRASAIT le tout. Un bloc envoye entre le moment ou le
     | worklet mesure sa file et celui ou son message arrive disparaissait donc
     | de l estimation — jusqu a 170 ms d un coup sur mobile, ou les blocs sont
     | gros. Le producteur voyait sa file chuter sans raison, declarait une
     | rupture et se re-verrouillait de force. Mesure : 1300 re-verrouillages
     | par session sur Android, contre 6 sur desktop ou les blocs sont petits.
     |
     | Le puits compte maintenant tout ce qu il RECOIT. La difference avec ce
     | que le bus a ENVOYE est exactement ce qui est encore en route. Plus de
     | course possible. */
    state.queuedFramesNow = function () {
      var ctx = state.audioCtx;
      var q, el, sr;
      /* Pas encore de marque = aucune mesure reelle. Le bus existe des le
         chargement de la page, bien avant que l AudioContext demarre : rendre
         state.stats.queuedFrames (0) faisait croire au producteur qu il avait
         VU une file vide. Il se calait dessus, puis au deverrouillage la vraie
         file apparaissait a 210 ms d un coup — une rupture dure en plein fondu
         d entree. Meme principe que plus bas : sans donnee, on dit -1. */
      if (!ctx || state._qMarkTime < 0) return -1;
      q = (state._qMark | 0) + ((state._txFrames | 0) - (state._rxMark | 0));
      el = ctx.currentTime - state._qMarkTime;
      if (!(el > 0)) el = 0;
      /* L extrapolation ne vaut que jusqu au rapport suivant (~42 ms). Si les
         rapports tardent — fil principal charge, onglet qui se reveille — la
         soustraction continuerait de courir et l estimation tomberait a zero.
         Le producteur y lirait une file vide et repondrait par un gros bloc :
         grille rythmique grossiere et file qui gonfle. On borne. */
      /* UN CAPTEUR SANS DONNEE FRAICHE DOIT DIRE « JE NE SAIS PAS ».
         Le plafond ci-dessous borne l extrapolation, mais il la rend AUSSI
         fausse quand le retard depasse largement la borne : page cachee, veille,
         gel du fil principal. Au retour, la soustraction manquante fait lire une
         file de 344 ms la ou le bus s apprete a la raboter a 24 ms — le
         producteur se re-verrouille sur un fantome, puis le bus vide tout.
         Les deux corrections opposees a 50 ms d intervalle, c est le glitch de
         veille. -1 = inconnu : le producteur saute simplement ce tick et attend
         un rapport reel. */
      if (el > 0.25) return -1;
      if (el > 0.15) el = 0.15;
      sr = state.sampleRate > 0 ? state.sampleRate : 48000;
      q -= Math.round(el * sr);
      return q > 0 ? q : 0;
    };

    /* Le producteur decide de sa propre avance et l annonce au bus.
    |
    | Le chemin compute vise une avance adaptee au framerate de la machine :
    | sur un mobile a 15 fps il lui faut ~320 ms pour survivre a un intervalle
    | de tick de 100 ms. Si le bus garde sa cible de 6144 frames (128 ms), il
    | voit une file trop pleine et la RABOTE — or raboter jette de l audio deja
    | produit, au milieu d une forme d onde. C est un glitch fabrique par un
    | desaccord entre deux composants qui ont chacun raison de leur cote.
    |
    | On laisse donc le producteur remonter la cible. Il ne la baisse jamais
    | sous la valeur d origine : le bus reste maitre du plancher. */
    state.setTargetFrames = function (frames) {
      var f = frames | 0;
      if (f < state.targetFramesFloor) f = state.targetFramesFloor;
      if (f > 65536) f = 65536;
      if (f === (state.targetFrames | 0)) return state.targetFrames | 0;
      state.targetFrames = f;
      try {
        if (state.worklet && state.worklet.port)
          state.worklet.port.postMessage({ type: "set-thresholds", targetFrames: f });
      } catch (e0) {}
      try {
        if (state.worker) state.worker.postMessage({ type: "set-thresholds", targetFrames: f });
      } catch (e1) {}
      try { dlog("[sound_bus] target frames -> " + f); } catch (e2) {}
      return f;
    };

    /* App.wasm drives this bridge from the main Sokol GPU context. */
    state.expectFrames = function () {
      if (!state.mainThreadPcm || !state.audioReady || !state.worklet) return 0;
      var want = (state.targetFrames | 0) - (state.stats.queuedFrames | 0);
      if (want < 0) want = 0;
      if (want > 2048) want = 2048;
      return want | 0;
    };
    state.pushPcm = function (samples, frames) {
      if (!state.mainThreadPcm || !state.worklet || !state.worklet.port) return 0;
      frames = frames | 0;
      if (frames <= 0) return 0;
      state.worklet.port.postMessage(
        /* MARQUE DE POSITION. Un « reset-latency » vide la file du worklet,
           mais il ne peut PAS annuler les messages deja postes sur le port :
           ceux-la arrivent APRES le vidage et se recollent devant les blocs
           neufs, alors que le producteur s est re-ancre entre-temps. Le raccord
           entre les deux est une marche — et elle est invisible a la source,
           qui a bien produit un flux continu. Mesure : sauts=1 cote source,
           coutures=4 dissim=0f/4s cote puits, meme session.
           _txFrames est monotone et jamais remis a zero : il sert de numero
           d ordre absolu. */
        { type: "pcm", samples: samples, frames: frames,
          at: state._txFrames | 0 },
        [samples.buffer]
      );
      state.stats.queuedFrames = (state.stats.queuedFrames | 0) + frames;
      /* Total envoye. La difference avec ce que le puits declare avoir recu
         donne exactement ce qui est encore en route. */
      state._txFrames = (state._txFrames | 0) + frames;
      state.stats.pcm_blocks = (state.stats.pcm_blocks | 0) + 1;
      return frames;
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
        else if (msg.soundType === "numeris_spark")
          inlineBase = 330;
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
      if (state._backgroundMuted || state._backgroundPausing || !isPageAudible())
        return 0;
      /* Start instruments even before AudioContext unlock â€” worker advances
       * voice clocks silently; unlock fade-in avoids a hard onset. */
      if (!state.audioReady) {
        if (!state._unlockStarted) return 0;
        if (state._pendingPlays.length >= 8) state._pendingPlays.shift();
        state._pendingPlays.push(desc || {});
        return 1;
      }
      if (state.worker || state._scriptPlay)
        return sendPlayReady(desc || {});
      return 0;
    };
    state.stopAll = function () {
      if (state.inlineSynth && state.worklet && state.worklet.port)
        state.worklet.port.postMessage({ type: "stop_all" });
      if (state.worker) state.worker.postMessage({ type: "stop_all" });
    };
    /* Mirror the persisted bfx echo settings into the worker synth. */
    state.setEcho = function (delayMs, feedback, mix) {
      if (state.worker)
        state.worker.postMessage({
          type: "set_echo",
          delayMs: +delayMs,
          feedback: +feedback,
          mix: +mix
        });
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
          sampleRate: state.sampleRate || state.synthRate || 48000,
          synthRate: state.synthRate || state.sampleRate || 48000,
          toneHz: state.toneHz
        },
        [port]
      );
    }

    function startScriptProcessorFallback(ctx) {
      /* HTTP Android often has no AudioWorklet. Keep the SAME desktop sound path:
       * worker synth @44.1k â†’ resample â†’ PCM FIFO â†’ this ScriptProcessor sink.
       * (Callback still runs on the render thread â€” prefer HTTPS for Worklet.) */
      dwarn(
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
      /* Soft underrun: hold last sample briefly, then fade — fast fade-to-0 is
       * what the ear hears as random crackle when an FPS hitch drains the FIFO.
       * Kept short so concealment never smears a real SFX attack. */
      var holdFrames = 64;
      var fadeFrames = 192;
      var healthyBlocks = 0;
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
      state.audioPort = audioPort;
      /* Cap cold-start boost — unbounded growth made first Android unlock lag
       * hundreds of ms until background recreate reset the graph. */
      var BUFFER_BOOST_MAX = state.mobile ? 1024 : 1536;
      var BUFFER_BOOST_STEP = 512;
      var srOut = ctx.sampleRate || 48000;
      /* Pad just enough to bridge one refill round-trip; 14 ms used to be pure
       * added latency on every trim. */
      var silencePadFrames = Math.max(256, (srOut * 0.006) | 0); /* ~6 ms */

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
          if (
            state._backgroundMuted ||
            state._backgroundPausing ||
            !state._outputAllowed
          )
            return;
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
        } else if (a.type === "trim") {
          /* Keep the oldest cushion, drop the stale idle tail — no starvation. */
          var keep = a.keepFrames > 0 ? a.keepFrames | 0 : 0;
          if (queuedFrames > keep) {
            var kept = current ? current.frames - offset : 0;
            var bi = 0;
            if (kept < 0) kept = 0;
            while (bi < blocks.length && kept < keep) {
              kept += blocks[bi].frames;
              bi++;
            }
            if (bi < blocks.length) blocks.length = bi;
            queuedFrames = kept;
            needSent = false;
          }
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
        if (
          state._backgroundMuted ||
          state._backgroundPausing ||
          !state._outputAllowed ||
          state._tearingDown
        ) {
          for (i = 0; i < n; i++) {
            left[i] = 0;
            right[i] = 0;
          }
          lastOutL = 0;
          lastOutR = 0;
          return;
        }
        /* Ask early in the callback so the worker can fill during this quantum. */
        requestFill(queuedFrames < state.needFrames + (bufferBoostFrames >> 1));
        for (i = 0; i < n; i++) {
          if (!current || offset >= current.frames) {
            current = blocks.length ? blocks.shift() : null;
            offset = 0;
          }
          if (!current) {
            if (primed && !unlockActive) {
              if (gapFrames === 0) {
                underruns++;
                healthyBlocks = 0;
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
        /* Hand the cold-start boost back once the FIFO stays healthy — without
         * this a single early hitch keeps the extra latency all session. */
        if (queuedFrames >= (state.needFrames | 0)) {
          healthyBlocks++;
          if (healthyBlocks >= 72 && bufferBoostFrames > 0) {
            healthyBlocks = 0;
            bufferBoostFrames -= BUFFER_BOOST_STEP >> 1;
            if (bufferBoostFrames < 0) bufferBoostFrames = 0;
          }
        } else healthyBlocks = 0;
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

    function detachCurrentSink() {
      if (state.worklet) {
        try { state.worklet.port.onmessage = null; } catch (e0) {}
        try { state.worklet.disconnect(); } catch (e1) {}
        state.worklet = null;
      }
      if (state.scriptNode) {
        try { state.scriptNode.onaudioprocess = null; } catch (e2) {}
        try { state.scriptNode.disconnect(); } catch (e3) {}
        state.scriptNode = null;
      }
      if (state.audioPort) {
        try { state.audioPort.onmessage = null; } catch (e4) {}
        try { state.audioPort.close(); } catch (e5) {}
        state.audioPort = null;
      }
      state._scriptTrimLatency = null;
      state._scriptSoftTrimLatency = null;
      state._scriptSilenceForTeardown = null;
      state.audioReady = false;
      state.audioPath = "switching";
      state._outputFadedIn = 0;
      state._warmupReadyCount = 0;
      state._warmupWaitTicks = 0;
      state._warmupReleaseAllowed = 0;
    }

    /* Runtime A/B test: keep the exact same GPU synth worker and PCM stream,
     * and replace only the browser sink. This isolates Worklet scheduling from
     * synthesis/transport bugs and avoids restarting the score. */
    state.setSinkMode = function (useWorklet) {
      preferWorklet = !!useWorklet;
      state.preferWorklet = preferWorklet;
      state.sinkSwitchError = "";
      if (!state.audioCtx || (!state.worklet && !state.scriptNode))
        return Promise.resolve(state);
      if ((preferWorklet && state.worklet) || (!preferWorklet && state.scriptNode))
        return Promise.resolve(state);
      if (state._sinkSwitchPromise) return state._sinkSwitchPromise;

      var ctx = state.audioCtx;
      var target = preferWorklet ? "worklet" : "main-thread";
      state.audioStage = "switching-" + target;
      state._sinkSwitchPromise = new Promise(function (resolve) {
        fadeOutputOut("sink-switch", 0.045, resolve);
      }).then(function () {
        detachCurrentSink();
        if (preferWorklet) {
          if (!workletSupported(ctx) || !isSecureEnough())
            throw new Error("AudioWorklet unavailable in this browser/context");
          return ensureWorkletModule(ctx).then(function () {
            attachWorkletNodeSync(ctx);
          });
        }
        startScriptProcessorFallback(ctx);
      }).then(function () {
        state.audioStage = state.worklet ? "worklet" : "script-pcm";
        markAudioReadyIfRunning();
        state._warmupBarrierToken = ((state._warmupBarrierToken | 0) + 1) | 0;
        if (state.worker)
          state.worker.postMessage({
            type: "warmup_barrier",
            token: state._warmupBarrierToken
          });
        else state._warmupReleaseAllowed = 1;
        dlog("[sound_bus] sink switched dynamically to " + state.audioPath);
        return state;
      }).catch(function (err) {
        state.sinkSwitchError = String(err && err.message ? err.message : err);
        state.error = "sink-switch:" + state.sinkSwitchError;
        /* Never leave a running context without a sink. If Worklet selection
         * failed, restore the main-thread PCM fallback immediately. */
        if (!state.worklet && !state.scriptNode) {
          preferWorklet = false;
          state.preferWorklet = false;
          startScriptProcessorFallback(ctx);
          state.audioStage = "script-pcm";
          markAudioReadyIfRunning();
          state._warmupReleaseAllowed = 1;
        }
        dwarn("[sound_bus] dynamic sink switch failed", err);
        return state;
      }).then(function (result) {
        state._sinkSwitchPromise = null;
        return result;
      }, function (err) {
        state._sinkSwitchPromise = null;
        throw err;
      });
      return state._sinkSwitchPromise;
    };

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
      try { attachOutputMonitor(ctx); } catch (eMon) {}
      try {
        if (SOUND_WORKLET_SELFTEST_HZ > 0) {
          node.port.postMessage({ type: "selftest", hz: SOUND_WORKLET_SELFTEST_HZ });
          dwarn("[sound_bus] SINUS SUR LE FIL AUDIO : " +
            SOUND_WORKLET_SELFTEST_HZ + " Hz genere dans le worklet. " +
            "Le fil principal n a plus rien a livrer.");
        }
        if (SOUND_SIMPLE_MODE) {
          node.port.postMessage({ type: "simple", on: 1 });
          dwarn("[sound_bus] MODE SIMPLE : rampes, coutures, " +
            "dissimulation, extinction et vidage DESACTIVES");
        }
      } catch (eSm) {}
      node.port.onmessage = function (ev) {
        var msg = ev.data || {};
        if (msg.type === "fifo-ready") {
          maybeReleaseWarmup(msg.queuedFrames | 0);
          return;
        }
        if (msg.type === "stats") {
          state.stats.underruns = msg.underruns | 0;
          state.stats.anomalies = msg.anomalies | 0;
          state.stats.concealUnderruns = msg.concealUnderruns | 0;
          state.stats.concealSeams = msg.concealSeams | 0;
          state.stats.lastPeriod = msg.lastPeriod | 0;
          state.stats.lastScore = +msg.lastScore || 0;
          state.stats.lastTonal = msg.lastTonal | 0;
          state.stats.underrunFrames = msg.underrunFrames | 0;
          state.stats.maxGapMs = +msg.maxGapMs || 0;
          state.stats.minQueuedFrames = msg.minQueuedFrames | 0;
          state.stats.fillWaitMs = +msg.fillWaitMs || 0;
          state.stats.fillWaitMaxMs = +msg.fillWaitMaxMs || 0;
          state.stats.bufferBoostFrames = msg.bufferBoostFrames | 0;
          state.stats.queuedFrames = msg.queuedFrames | 0;
          state._qMark = msg.queuedFrames | 0;
          state._rxMark = msg.rxFrames | 0;
          state._qMarkTime = state.audioCtx ? state.audioCtx.currentTime : -1;
          if (msg.mode === "inline") state.stats.voices = msg.voices | 0;
          state.stats.audioMode = msg.mode || (state.inlineSynth ? "inline" : "pcm");
          checkDeviceStall();
          maybeReleaseWarmup(msg.queuedFrames | 0);
          maybeLogAudioHealth(msg);
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
      if (state._retired || (!state.worker && !state.mainThreadPcm)) {
        /* Sokol / main-thread GPU owns the device. Do not open a second
         * AudioContext — Chrome glitches when two graphs run at once. */
        return Promise.resolve(state);
      }
      if (!audioSupported()) {
        state.error = "audio-unsupported";
        state.audioStage = "error";
        return Promise.reject(new Error(state.error));
      }
      if (state._startPromise) return state._startPromise;
      if (
        state.audioReady &&
        state.audioCtx &&
        state.audioCtx.state === "running" &&
        (state.scriptNode || state.worklet)
      ) {
        resumeWorkerPump();
        fadeOutputIn("already-running");
        return Promise.resolve(state);
      }
      state._tearingDown = 0;
      state._backgroundMuted = 0;
      if (state._wakeSink) state._wakeSink();   /* annule l extinction commandee */
      state._backgroundPausing = 0;
      state._outputAllowed = 1;
      if (!state._unlockStarted) state._unlockStarted = true;
      state._unlockAttempts++;

      /* Only recreate a *dead* graph. pointerdown+click used to nuke the
       * ScriptProcessor on the still-suspended first context. */
      if (state.audioCtx && state.audioCtx.state === "closed") {
         dwarn("[sound_bus] recreating AudioContext (was closed)");
         nukeAudioGraph();
      }
      if (state._resumeTimedOut && state.audioCtx &&
          state.audioCtx.state === "suspended") {
        dwarn("[sound_bus] recreating AudioContext after resume timeout");
        nukeAudioGraph();
        state._resumeTimedOut = 0;
      }

      ctx = ensureAudioContext();
      primeAudioGesture(ctx);
      state.sampleRate = ctx.sampleRate | 0;
      refreshConvertPath();
      dlog(
        "[sound_bus] AudioContext device=" +
          state.sampleRate +
          " Hz | config=" +
          state.synthRate +
          " Hz | " +
          state.convertPath +
          " | attempt=" +
          state._unlockAttempts +
          " ctx=" +
          ctx.state
      );
      if (SOUND_MODULE_BEFORE_RESUME && !state.worklet && !state.scriptNode &&
          preferWorklet && workletSupported(ctx) && isSecureEnough() &&
          ctx.state === "suspended" && !state._modFirstTried) {
        state._modFirstTried = 1;
        state.audioStage = "worklet-module-presuspend";
        state._startPromise = Promise.race([
          ensureWorkletModule(ctx).then(function () { return "ok"; }),
          new Promise(function (rs) { setTimeout(function () { rs("timeout"); }, 400); })
        ]).then(function (st) {
          if (st === "ok") {
            try {
              attachWorkletNodeSync(ctx);
              dlog("[sound_bus] graphe PRET avant ouverture du flux" +
                " (module compile sur contexte suspendu)");
            } catch (eAt) {
              dwarn("[sound_bus] attache pre-resume impossible", eAt);
            }
          } else {
            dwarn("[sound_bus] addModule sans reponse sur contexte suspendu" +
              " -> ancien ordre (resume puis compilation)");
          }
          state._startPromise = null;
          return state.startAudio();
        }, function (eM) {
          dwarn("[sound_bus] addModule pre-resume en echec -> ancien ordre", eM);
          state._startPromise = null;
          return state.startAudio();
        });
        return state._startPromise;
      }
      if (!state._unlockAtMs) {
        state._unlockAtMs = (typeof performance !== "undefined" && performance.now)
          ? performance.now() : Date.now();
        /* Rechargement ou premiere visite ? C est LA difference que tu decris :
           propre au tout premier demarrage, claquant apres un rechargement. */
        try {
          var nav = performance.getEntriesByType("navigation")[0];
          dlog("[sound_bus] ouverture du flux | navigation=" +
            ((nav && nav.type) || "?") + " | " +
            Math.round((typeof performance !== "undefined" && performance.now)
              ? performance.now() : 0) + " ms apres le chargement de la page");
        } catch (eN) {}
      }
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
      /* Give AudioContext the gesture first. HTMLMedia is only a secondary
       * Android activation aid; calling play() first can consume activation in
       * some WebViews and leave resume() pending forever. */
      primeHtmlMedia();
      resumePromise = Promise.race([
        Promise.resolve(resumePromise).then(function () { return "resumed"; }),
        new Promise(function (resolve) {
          setTimeout(function () { resolve("timeout"); }, 1200);
        })
      ]);

      function attachSinkIfNeeded() {
        if (state.worklet || state.scriptNode) return Promise.resolve();
        dlog("[sound_bus] sink probe preferWorklet=" + (preferWorklet ? 1 : 0) +
          " supported=" + (workletSupported(ctx) ? 1 : 0) +
          " secure=" + (isSecureEnough() ? 1 : 0) +
          " AudioWorkletNode=" + (typeof global.AudioWorkletNode) +
          " ctx.audioWorklet=" + (ctx.audioWorklet ? 1 : 0) +
          " workerOk=" + (state.ok ? 1 : 0) +
          " workerReady=" + (state.ready ? 1 : 0));
        /* Numeris main-thread PCM has exactly two explicit choices in Settings:
         * AudioWorklet here, or Sokol WebAudio outside this bus. Never hide a
         * third ScriptProcessor path behind the AudioWorklet button. */
        if (state.mainThreadPcm &&
            (!workletSupported(ctx) || !isSecureEnough())) {
          state.audioStage = "error";
          state.error = "audio-worklet-unavailable";
          throw new Error(state.error);
        }
        if (preferWorklet && workletSupported(ctx) && isSecureEnough()) {
          state.audioStage = "worklet-module";
          /* Loading a worklet while AudioContext is suspended can hang on
           * Android. Do it after resume, inside the user-gesture chain. */
          return Promise.race([
            ensureWorkletModule(ctx).then(function () { return "ok"; }),
            new Promise(function (resolve) {
              setTimeout(function () { resolve("timeout"); }, 1500);
            })
          ]).then(function (status) {
            if (status === "ok") {
              state.audioStage = "worklet";
              attachWorkletNodeSync(ctx);
              return;
            }
            if (state.mainThreadPcm) {
              state.audioStage = "error";
              state.error = "audio-worklet-timeout";
              throw new Error(state.error);
            }
            dwarn("[sound_bus] Worklet timeout; using ScriptProcessor PCM");
            state.audioStage = "script-pcm";
            startScriptProcessorFallback(ctx);
          }, function (err) {
            if (state.mainThreadPcm) {
              state.audioStage = "error";
              state.error = "audio-worklet-init:" +
                String(err && err.message ? err.message : err);
              throw new Error(state.error);
            }
            dwarn("[sound_bus] Worklet unavailable; using ScriptProcessor PCM", err);
            state.audioStage = "script-pcm";
            startScriptProcessorFallback(ctx);
          });
        }
        state.audioStage = "script-pcm";
        startScriptProcessorFallback(ctx);
        dlog("[sound_bus] PCM sink=script-pcm ctx=" + ctx.state);
        return Promise.resolve();
      }

      state._startPromise = Promise.resolve(resumePromise).then(
        function (resumeStatus) {
          if (resumeStatus === "timeout" && ctx.state !== "running") {
            state._resumeTimedOut = 1;
            throw new Error("audio-resume-timeout ctx=" + ctx.state);
          }
          state._resumeTimedOut = 0;
          primeAudioGesture(ctx);
          if (ctx.state !== "running")
            dwarn("[sound_bus] resume resolved but ctx=" + ctx.state);
          return attachSinkIfNeeded();
        }
      ).then(
        function () {
          markAudioReadyIfRunning();
          startBareOscTest();
          dlog(
            "[sound_bus] after resume ready=" +
              (state.audioReady ? 1 : 0) +
              " ctx=" +
              ctx.state +
              " sink=" +
              (state.scriptNode ? "script" : state.worklet ? "worklet" : "none") +
              " path=" +
              (state.audioPath || "?") +
              " worker=" +
              (state.worker ? 1 : 0)
          );
          resumeWorkerPump();
          if (state.audioReady) {
            /* Keep DAC muted until fresh PCM reaches the safety threshold.
             * Opening gain on an empty Worklet produced the first-tap pop. */
            state._unlockFadePending = 1;
            state._warmupReadyCount = 0;
            state._warmupReleaseAllowed = 0;
            flushPendingPlays();
            /* Same Worker channel as play: acknowledgement is emitted only
             * after all pending plays and their immediate refill were handled. */
            state._warmupBarrierToken = ((state._warmupBarrierToken | 0) + 1) | 0;
            if (state.worker)
              state.worker.postMessage({
                type: "warmup_barrier",
                token: state._warmupBarrierToken
              });
            else state._warmupReleaseAllowed = 1;
            if (typeof opts.onAudioReady === "function") opts.onAudioReady(state);
          }
          return state;
        },
        function (err) {
          state.audioStage = "audio-start-failed";
          state.audioReady = false;
          state.error = String(err && err.message ? err.message : err);
          throw err;
        }
      );
      state._startPromise = state._startPromise.then(
        function (s) {
          state._startPromise = null;
          return s;
        },
        function (err) {
          state._startPromise = null;
          throw err;
        }
      );
      return state._startPromise;
    };

    state.primeGesture = function () {
      /* On the first gesture startAudio creates the context synchronously.
       * Do not let HTMLMedia.play() consume activation before that happens. */
      if (state.audioCtx) {
        primeAudioGesture(state.audioCtx);
        primeHtmlMedia();
      }
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

    /* Android: Share→Copy Link blurs the window; closing the modal is a
     * touch that never fires window.focus — unduck here so audio/shader recover. */
    if (!state._pointerBlurClearBound && typeof document !== "undefined") {
      state._pointerBlurClearBound = 1;
      var unduck = function () { clearSoftBlurIfVisible(); };
      document.addEventListener("pointerdown", unduck, true);
      document.addEventListener("touchstart", unduck, true);
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
          if (st === "interrupted") {
            if (!state._backgroundMuted && !state._shutdownBegun)
              pauseForBackground("interrupted");
            return;
          }
          /* "suspended" is the default before the first gesture — not a hide. */
        });
      } catch (eLc) {}
    }
    state._bindAudioCtxLifecycle = bindAudioCtxLifecycle;
    if (state.audioCtx) bindAudioCtxLifecycle(state.audioCtx);

    if (!state._unloadBound && typeof window !== "undefined") {
      state._unloadBound = 1;
      var onPageHide = function (ev) {
        if (ev && ev.persisted) return;
        /* Android app switch: recover on return — do not destroy the graph. */
        if (state.mobile) {
          pauseForBackground("pagehide");
          return;
        }
        cancelBackgroundPause();
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
      state._retired = 1;
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
