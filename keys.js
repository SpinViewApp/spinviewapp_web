(function() {
    var canvas = null;
    var appKeyboardActive = true;

    function getCanvas() {
        if (!canvas) {
            canvas = document.getElementById("canvas");
        }
        return canvas;
    }

    function isTypingTarget(target) {
        var tag;

        if (!target) return false;

        tag = target.tagName ? target.tagName.toLowerCase() : "";
        if (tag === "input") return true;
        if (tag === "textarea") return true;
        if (tag === "select") return true;
        if (target.isContentEditable) return true;

        return false;
    }

    function isBrowserShortcutToKeep(ev) {
        var key = ev.key ? ev.key.toLowerCase() : "";
        var ctrl = !!ev.ctrlKey;
        var shift = !!ev.shiftKey;
        var alt = !!ev.altKey;
        var meta = !!ev.metaKey;

        if (key === "f5") return true;
        if (ctrl && key === "r") return true;
        if (meta && key === "r") return true;

        if (ctrl && key === "f5") return true;
        if (meta && shift && key === "r") return true;

        if (key === "f11") return true;
        if (key === "f12") return true;

        if (ctrl && shift && key === "i") return true;
        if (ctrl && shift && key === "j") return true;
        if (ctrl && shift && key === "c") return true;
        if (meta && alt && key === "i") return true;

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

        if (alt && key === "arrowleft") return true;
        if (alt && key === "arrowright") return true;
        if (meta && key === "[") return true;
        if (meta && key === "]") return true;

        return false;
    }

    function shouldCaptureKey(ev) {
        var c = getCanvas();
        var target = ev.target;

        if (isTypingTarget(target)) {
            return false;
        }

        if (isBrowserShortcutToKeep(ev)) {
            return false;
        }

        if (!appKeyboardActive) {
            return false;
        }

        if (c && document.activeElement && document.activeElement !== c) {
            return false;
        }

        return true;
    }

    function forwardKeyToApp(type, ev) {
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

    function activateKeyboardForApp() {
        var c = getCanvas();
        appKeyboardActive = true;
        if (c) {
            c.focus();
        }
    }

    function deactivateKeyboardForApp() {
        appKeyboardActive = false;
    }

    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);

    window.addEventListener("load", function() {
        var c = getCanvas();
        if (!c) return;

        c.addEventListener("pointerdown", function() {
            activateKeyboardForApp();
        });

        c.addEventListener("click", function() {
            activateKeyboardForApp();
        });
    });

    window.spinviewActivateKeyboard = activateKeyboardForApp;
    window.spinviewDeactivateKeyboard = deactivateKeyboardForApp;
})();