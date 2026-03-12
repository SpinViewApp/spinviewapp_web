
(function() {
    function isBrowserShortcutToKeep(ev) {
        var key = ev.key ? ev.key.toLowerCase() : "";
        var ctrl = !!ev.ctrlKey;
        var shift = !!ev.shiftKey;
        var alt = !!ev.altKey;
        var meta = !!ev.metaKey;

        /* Refresh */
        if (key === "f5") return true;
        if (ctrl && key === "r") return true;
        if (meta && key === "r") return true;

        /* Hard refresh */
        if (ctrl && key === "f5") return true;
        if (meta && shift && key === "r") return true;

        /* Browser / devtools / fullscreen common shortcuts */
        if (key === "f11") return true;
        if (key === "f12") return true;
        if (ctrl && shift && key === "i") return true;
        if (ctrl && shift && key === "j") return true;
        if (ctrl && shift && key === "c") return true;
        if (meta && alt && key === "i") return true;

        /* Address/search/save/print/tab management */
        if (ctrl && key === "l") return true;
        if (meta && key === "l") return true;
        if (ctrl && key === "t") return true;
        if (meta && key === "t") return true;
        if (ctrl && key === "w") return true;
        if (meta && key === "w") return true;
        if (ctrl && key === "n") return true;
        if (meta && key === "n") return true;
        if (ctrl && key === "f") return true;
        if (meta && key === "f") return true;
        if (ctrl && key === "p") return true;
        if (meta && key === "p") return true;
        if (ctrl && key === "s") return true;
        if (meta && key === "s") return true;

        /* History navigation */
        if (alt && key === "arrowleft") return true;
        if (alt && key === "arrowright") return true;
        if (meta && key === "[") return true;
        if (meta && key === "]") return true;

        return false;
    }

    function isTypingTarget(target) {
        if (!target) return false;

        var tag = target.tagName ? target.tagName.toLowerCase() : "";
        if (tag === "input") return true;
        if (tag === "textarea") return true;
        if (tag === "select") return true;
        if (target.isContentEditable) return true;

        return false;
    }

    function shouldCaptureKey(ev) {
        if (isTypingTarget(ev.target)) {
            return false;
        }

        if (isBrowserShortcutToKeep(ev)) {
            return false;
        }

        return true;
    }

    function forwardKeyToApp(type, ev) {
        /* Ici tu branches ton système input */
        console.log("[key]", type, ev.key, "code=", ev.code);
    }

    function onKey(ev) {
        if (!shouldCaptureKey(ev)) {
            return;
        }

        ev.preventDefault();
        ev.stopPropagation();

        forwardKeyToApp(ev.type, ev);
    }

    window.addEventListener("keydown", onKey, { passive: false, capture: true });
    window.addEventListener("keyup", onKey, { passive: false, capture: true });
})();
