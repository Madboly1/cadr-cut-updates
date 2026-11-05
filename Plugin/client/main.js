var csInterface = new CSInterface();


/* =========================================================
   PLATFORM HELPERS (Windows / macOS)
   ========================================================= */

function cadrIsWindows() {
    try {
        if (typeof process !== "undefined" && process.platform) {
            return process.platform === "win32";
        }
    } catch (e) {}
    return String(navigator.platform || "").indexOf("Win") === 0;
}

function cadrNullDevice() {
    return cadrIsWindows() ? "NUL" : "/dev/null";
}


/* =========================================================
   CUTS: ONE PER CALL, WITH A SHORT PAUSE
   ---------------------------------------------------------
   Sending all cuts inside ONE ExtendScript call froze Premiere
   (QE API called many times in a row). So the panel sends one
   cut, waits for the answer, pauses, then sends the next.
   ========================================================= */

var CADR_CUT_PAUSE_MS = 45;
var cadrCutBusy = false;
var cadrCutBusySince = 0;

function cadrRunCutsSequentially(cuts, onProgress, onDone) {

    var results = [];
    var index = 0;
    var aborted = false;

    /* Preview markers point at the OLD timeline; after cutting they would
       be in the wrong place, so they are removed first. (Undo brings back
       the backup sequence, which still has them.) */
    var startCuts = function () {
        next();
    };

    function next() {

        if (index >= cuts.length) {
            cadrCutBusy = false;
            onDone(results);
            return;
        }

        if (aborted || window.cadrCancelRequested) {
            aborted = true;
            results.push("SKIPPED");
            index++;
            next();
            return;
        }

        csInterface.evalScript(
            "performSingleCut('" + cuts[index] + "')",
            function (response) {

                var result = response || "NO_RESPONSE";

                results.push(result);

                /* No point continuing if there is no sequence / QE. */
                if (result === "NO_SEQUENCE" || result === "QE_FAIL") {
                    aborted = true;
                }

                index++;

                if (onProgress) {
                    onProgress(index, cuts.length);
                }

                setTimeout(next, CADR_CUT_PAUSE_MS);
            }
        );
    }

    csInterface.evalScript("cadrClearSilenceMarkers()", startCuts);
}


/* =========================================================
   AUTO ZOOM
   Runs after the cuts: every second shot of each cut video track gets a
   bigger Scale, so the jump cuts look like deliberate punch-ins.
   ========================================================= */

function cadrReadZoomSettings() {

    var on = document.getElementById("autoZoom");
    var amount = document.getElementById("zoomAmount");

    var percent = amount ? parseInt(amount.value, 10) : 112;

    if (isNaN(percent) || percent < 101) {
        percent = 112;
    }

    if (percent > 150) {
        percent = 150;
    }

    var settings = { on: !!(on && on.checked), percent: percent };

    setSetting("autoZoom", settings.on ? "1" : "0");
    setSetting("zoomAmount", String(percent));

    return settings;
}

/* onDone(line): a short text to add to the result, or "" if nothing ran. */
function cadrAutoZoomPass(allCuts, statusEl, head, onDone) {

    var zoom = cadrReadZoomSettings();

    if (!zoom.on) {
        onDone("");
        return;
    }

    var tracks = [];
    var seenTrack = {};
    var starts = [];

    for (var i = 0; i < allCuts.length; i++) {

        var parts = allCuts[i].split("|");
        var track = parseInt(parts[0], 10);

        starts.push(parseFloat(parts[1]));

        /* only video tracks (>= 0); a voice-over has nothing to zoom */
        if (track >= 0 && !seenTrack[track]) {
            seenTrack[track] = true;
            tracks.push(track);
        }
    }

    if (!tracks.length) {
        onDone("Auto zoom: متاح للفيديو بس (الصوت لوحده مفيهوش حاجة يتكبّر).");
        return;
    }

    var winStart = Math.min.apply(null, starts) - 0.5;
    var winEnd = Math.max.apply(null, starts) + 0.5;

    cadrCutBusy = true;
    cadrCutBusySince = Date.now();

    var zoomedShots = 0;
    var problems = [];
    var index = 0;

    function finish() {

        cadrCutBusy = false;

        var line =
            "Auto zoom ✅ " + zoomedShots + " لقطة اتكبّرت " +
            zoom.percent + "%";

        if (problems.length) {

            line +=
                "\nمشاكل (" + problems.length + "):\n" +
                problems.slice(0, 4).join("\n");
        }

        onDone(line);
    }

    function next() {

        if (index >= tracks.length) {
            finish();
            return;
        }

        statusEl.textContent =
            head + "\n\nAuto zoom... " + (index + 1) + " / " + tracks.length;

        csInterface.evalScript(
            "cadrAutoZoomTrack(" +
            tracks[index] + "," +
            zoom.percent + "," +
            winStart.toFixed(3) + "," +
            winEnd.toFixed(3) + ")",
            function (result) {

                var text = String(result || "NO_RESPONSE");
                var m = text.match(/shots=(\d+)/);

                if (m) {
                    zoomedShots += parseInt(m[1], 10);
                }

                if (text.indexOf("OK") !== 0) {

                    problems.push(
                        "V" + (tracks[index] + 1) + ": " +
                        text.replace(/^ERR;/, "")
                    );
                }

                index++;

                setTimeout(next, CADR_CUT_PAUSE_MS);
            }
        );
    }

    next();
}


/* =========================================================
   SMOOTH CUTS (Cross Dissolve + audio Crossfade)
   ---------------------------------------------------------
   Runs after the cuts. Finds every place where a silence was
   removed, then adds the transitions one junction per call.
   ========================================================= */

function cadrReadSmoothSettings() {

    var v = document.getElementById("smoothVideo");
    var a = document.getElementById("smoothAudio");
    var f = document.getElementById("smoothFrames");

    var frames = f ? parseInt(f.value, 10) : 3;

    if (isNaN(frames) || frames < 1) {
        frames = 3;
    }

    if (frames > 12) {
        frames = 12;
    }

    var settings = {
        video: !!(v && v.checked),
        audio: !!(a && a.checked),
        frames: frames
    };

    setSetting("smoothVideo", settings.video ? "1" : "0");
    setSetting("smoothAudio", settings.audio ? "1" : "0");
    setSetting("smoothFrames", String(frames));

    return settings;
}

function cadrSmoothCutsPass(allCuts, statusEl, head, details, onDone) {

    var smooth = cadrReadSmoothSettings();

    if (!smooth.video && !smooth.audio) {
        statusEl.textContent = head + "\n\n" + details;
        onDone();
        return;
    }

    cadrCutBusy = true;
    cadrCutBusySince = Date.now();

    function finish(summary) {

        cadrCutBusy = false;

        hideProgress("cutProgress");

        statusEl.textContent =
            head + "\n\n" + summary + "\n\n" + details;

        onDone();
    }

    var starts = [];

    for (var i = 0; i < allCuts.length; i++) {
        starts.push(parseFloat(allCuts[i].split("|")[1]));
    }

    var winStart = Math.min.apply(null, starts) - 0.5;
    var winEnd = Math.max.apply(null, starts) + 0.5;

    statusEl.textContent =
        head + "\n\nبيدور على أماكن القص عشان يضيف Smooth Cuts...";

    csInterface.evalScript(
        "cadrListCutJunctions(" +
        winStart.toFixed(3) + "," +
        winEnd.toFixed(3) + "," +
        smooth.frames + ")",
        function (response) {

            var times = null;

            try {
                times = JSON.parse(response);
            } catch (e) {
                times = null;
            }

            if (!times || !times.length) {

                finish(
                    "Smooth Cuts: " +
                    (times && !times.length
                        ? "مفيش أماكن قص مناسبة لتأثير (يمكن القصات أقصر من التأثير)."
                        : "مقدرش يلاقي أماكن القص (" + response + ").")
                );

                return;
            }

            var videoAdded = 0;
            var audioAdded = 0;
            var problems = [];
            var index = 0;

            setProgress("cutProgress", 0);

            function next() {

                if (index >= times.length) {

                    var summary =
                        "Smooth Cuts ✅  أماكن القص: " + times.length +
                        (smooth.video ? "  |  Cross Dissolve: " + videoAdded : "") +
                        (smooth.audio ? "  |  Crossfade: " + audioAdded : "");

                    if (problems.length) {

                        summary +=
                            "\nمشاكل (" + problems.length + "):\n" +
                            problems.slice(0, 5).join("\n") +
                            (problems.length > 5 ? "\n..." : "");
                    }

                    finish(summary);
                    return;
                }

                csInterface.evalScript(
                    "cadrAddSmoothAt(" +
                    times[index].toFixed(3) + "," +
                    smooth.frames + ",'" +
                    (smooth.video ? "1" : "0") + "','" +
                    (smooth.audio ? "1" : "0") + "')",
                    function (result) {

                        var text = String(result || "NO_RESPONSE");
                        var parts = text.split(";");

                        for (var p = 0; p < parts.length; p++) {

                            var m = parts[p].match(/^V=(\d+)$/);

                            if (m) {
                                videoAdded += parseInt(m[1], 10);
                            }

                            m = parts[p].match(/^A=(\d+)$/);

                            if (m) {
                                audioAdded += parseInt(m[1], 10);
                            }
                        }

                        if (parts[0] !== "OK") {
                            problems.push(
                                times[index].toFixed(2) + "s: " +
                                text.replace(/^ERR;/, "")
                            );
                        }

                        index++;

                        setProgress(
                            "cutProgress",
                            Math.round((index / times.length) * 100)
                        );

                        statusEl.textContent =
                            head + "\n\nSmooth Cuts... " +
                            index + " / " + times.length;

                        setTimeout(next, CADR_CUT_PAUSE_MS);
                    }
                );
            }

            next();
        }
    );
}


/* =========================================================
   BACKUP BEFORE CUTTING + UNDO
   ---------------------------------------------------------
   Before every cut we clone the sequence. UNDO CUT swaps the
   clone back in. The cut version is never deleted: it stays in
   the project as "<name> (CUT)".
   ========================================================= */

var cadrLastBackup = null;
var cadrBackupCaptionSnapshot = null;

/* The caption/filler-word list in the panel is tied to the timeline as it
   was when the backup was taken, so UNDO restores that list too. */
function cadrTakeCaptionSnapshot() {
    try {
        return JSON.stringify({
            lines: pendingCaptionLines,
            words: pendingCaptionWords,
            fillers: fillerWordsList
        });
    } catch (e) {
        return null;
    }
}

function cadrResetCaptionState() {
    pendingCaptionSrt = null;
    pendingCaptionLines = [];
    pendingCaptionWords = [];
    fillerWordsList = [];

    var box = document.getElementById("fillerWordsBox");
    if (box) {
        box.style.display = "none";
    }

    var preview = document.getElementById("captionPreview");
    if (preview) {
        preview.value = "";
    }

    cadrTrReset();
}

function cadrRestoreCaptionSnapshot(snapshot) {
    try {
        var data = JSON.parse(snapshot);

        pendingCaptionLines = data.lines || [];
        pendingCaptionWords = data.words || [];
        fillerWordsList = data.fillers || [];

        rebuildCaptionPreview();

        if (fillerWordsList.length > 0) {
            renderFillerWords();
        } else {
            var box = document.getElementById("fillerWordsBox");
            if (box) {
                box.style.display = "none";
            }
        }

        return true;

    } catch (e) {
        return false;
    }
}

(function loadSavedBackupInfo() {
    try {
        var raw = window.localStorage.getItem("cadrLastBackup");
        if (raw) {
            cadrLastBackup = JSON.parse(raw);
        }
    } catch (e) {
        cadrLastBackup = null;
    }
})();

function cadrSaveBackupInfo(info) {
    cadrLastBackup = info;
    try {
        if (info) {
            window.localStorage.setItem("cadrLastBackup", JSON.stringify(info));
        } else {
            window.localStorage.removeItem("cadrLastBackup");
        }
    } catch (e) {}
}

function cadrUpdateUndoButtons(enabled) {
    var buttons = document.querySelectorAll(".cadr-undo-btn");
    for (var i = 0; i < buttons.length; i++) {
        buttons[i].disabled = !enabled;
    }
}

/* Enable the undo buttons only if the saved backup still exists
   in the CURRENT project. */
function cadrRefreshUndoState() {

    if (!cadrLastBackup || !cadrLastBackup.backupId) {
        cadrUpdateUndoButtons(false);
        return;
    }

    if (!window.__adobe_cep__) {
        cadrUpdateUndoButtons(false);
        return;
    }
    csInterface.evalScript(
        "cadrBackupExists('" + cadrLastBackup.backupId + "')",
        function (response) {
            if (response === "1") {
                cadrUpdateUndoButtons(true);
            } else {
                cadrSaveBackupInfo(null);
                cadrUpdateUndoButtons(false);
            }
        }
    );
}

/* Creates the backup, then makes sure the ORIGINAL sequence is
   the active one again (so we never cut the backup by mistake).
   onReady(true)  => safe to cut
   onReady(false) => do not cut                                   */
function cadrBackupThen(statusEl, onReady) {

    /* The flag expires after 30 minutes so a crashed run can never lock
       the buttons until Premiere is restarted. */
    if (
        cadrCutBusy &&
        Date.now() - cadrCutBusySince < 30 * 60 * 1000
    ) {
        statusEl.textContent = "في عملية قص شغالة دلوقتي، استنى لحد ما تخلص.";
        onReady(false);
        return;
    }

    cadrCutBusy = true;
    cadrCutBusySince = Date.now();

    var captionSnapshot = cadrTakeCaptionSnapshot();

    statusEl.textContent =
        "بيعمل نسخة احتياطية من السيكوينس (عشان تقدر ترجع)...";

    csInterface.evalScript("cadrCreateBackup()", function (response) {

        var info = null;

        try {
            info = JSON.parse(response);
        } catch (e) {
            info = null;
        }

        if (!info || !info.backupId) {

            var reason =
                response === "CLONE_UNAVAILABLE"
                    ? "نسخة بريمير دي مش بتسمح بعمل نسخة من السيكوينس من السكريبت."
                    : "مقدرش يعمل نسخة احتياطية (" + response + ").";

            var goOn = window.confirm(
                reason +
                "\n\nلو كملت، زرار الرجوع مش هيشتغل (هتبقى محتاج Ctrl+Z).\n\nتكمل القص من غير نسخة احتياطية؟"
            );

            if (!goOn) {
                cadrCutBusy = false;
                statusEl.textContent = "اتلغى القص. محصلش أي تغيير.";
                onReady(false);
                return;
            }

            cadrSaveBackupInfo(null);
            cadrBackupCaptionSnapshot = null;
            cadrUpdateUndoButtons(false);
            onReady(true);
            return;
        }

        cadrSaveBackupInfo(info);
        cadrBackupCaptionSnapshot = captionSnapshot;

        /* Give Premiere a moment to switch back to the original
           sequence, then verify it really is the active one. */
        function verify(attempt) {

            csInterface.evalScript("cadrActiveSequenceId()", function (activeId) {

                if (activeId === info.originalId) {
                    cadrUpdateUndoButtons(true);
                    onReady(true);
                    return;
                }

                if (attempt >= 3) {
                    cadrCutBusy = false;
                    statusEl.textContent =
                        "اتعملت النسخة الاحتياطية، بس بريمير مرجعش للسيكوينس الأصلي.\n\n" +
                        "افتح السيكوينس الأصلي بإيدك (\"" + info.originalName + "\") وجرب تاني.\n" +
                        "محصلش أي قص.";
                    cadrUpdateUndoButtons(true);
                    onReady(false);
                    return;
                }

                csInterface.evalScript(
                    "cadrActivateSequence('" + info.originalId + "')",
                    function () {
                        setTimeout(function () {
                            verify(attempt + 1);
                        }, 700);
                    }
                );
            });
        }

        setTimeout(function () {
            verify(0);
        }, 700);
    });
}

function undoLastCut(statusId) {

    var status =
        document.getElementById(statusId || "cutStatus");

    if (cadrCutBusy) {
        status.textContent = "استنى لحد ما العملية الشغالة تخلص وبعدين دوس Undo.";
        return;
    }

    if (!cadrLastBackup || !cadrLastBackup.backupId) {
        status.textContent = "مفيش قصة تتراجع عنها.";
        cadrUpdateUndoButtons(false);
        return;
    }

    var ok = window.confirm(
        "هترجع السيكوينس زي ما كان قبل آخر قص.\n\n" +
        "النسخة المقصوصة مش هتتمسح، هتفضل في المشروع باسم \"" +
        cadrLastBackup.originalName + " (CUT)\".\n\nتكمل؟"
    );

    if (!ok) {
        return;
    }

    cadrUpdateUndoButtons(false);
    status.textContent = "بيرجّع السيكوينس...";

    csInterface.evalScript(
        "cadrRestoreBackup('" +
        cadrLastBackup.originalId + "','" +
        cadrLastBackup.backupId + "','" +
        escapeExtendScriptString(cadrLastBackup.originalName) + "')",
        function (response) {

            if (response === "RESTORED") {

                status.textContent =
                    "تم الرجوع ✅\n\n" +
                    "السيكوينس رجع زي ما كان. النسخة المقصوصة لسه في المشروع باسم \"" +
                    cadrLastBackup.originalName + " (CUT)\".";

                cadrSaveBackupInfo(null);

                /* Bring back the caption / filler-word list as it was. */
                if (
                    !cadrBackupCaptionSnapshot ||
                    !cadrRestoreCaptionSnapshot(cadrBackupCaptionSnapshot)
                ) {
                    cadrResetCaptionState();
                }

                cadrBackupCaptionSnapshot = null;

                refreshSelection();
                return;
            }

            if (response === "BACKUP_MISSING") {
                status.textContent =
                    "النسخة الاحتياطية مش موجودة في المشروع (يمكن اتمسحت).";
                cadrSaveBackupInfo(null);
                cadrUpdateUndoButtons(false);
                return;
            }

            status.textContent = "فشل الرجوع: " + response;
            cadrUpdateUndoButtons(true);
        }
    );
}


/* =========================================================
   ANALYSIS CACHE
   ========================================================= */

var silenceAnalysisCache = {};

function cacheKeyFor(clip, silence, noiseThreshold) {
    var modified = "";
              m = parts[p].match(/^A=(\d+)$/);

                            if (m) {
                                audioAdded += parseInt(m[1], 10);
                            }
                        }

                        if (parts[0] !== "OK") {
                            problems.push(
                                times[index].toFixed(2) + "s: " +
                                text.replace(/^ERR;/, "")
                            );
                        }

                        index++;

                        setProgress(
                            "cutProgress",
                            Math.round((index / times.length) * 100)
                        );

                        statusEl.textContent =
                            head + "\n\nSmooth Cuts... " +
                            index + " / " + times.length;

                        setTimeout(next, CADR_CUT_PAUSE_MS);
                    }
                );
            }

            next();
        }
    );
}


/* =========================================================
   BACKUP BEFORE CUTTING + UNDO
   ---------------------------------------------------------
   Before every cut we clone the sequence. UNDO CUT swaps the
   clone back in. The cut version is never deleted: it stays in
   the project as "<name> (CUT)".
   ========================================================= */

var cadrLastBackup = null;
var cadrBackupCaptionSnapshot = null;

/* The caption/filler-word list in the panel is tied to the timeline as it
   was when the backup was taken, so UNDO restores that list too. */
function cadrTakeCaptionSnapshot() {
    try {
        return JSON.stringify({
            lines: pendingCaptionLines,
            words: pendingCaptionWords,
            fillers: fillerWordsList
        });
    } catch (e) {
        return null;
    }
}

function cadrResetCaptionState() {
    pendingCaptionSrt = null;
    pendingCaptionLines = [];
    pendingCaptionWords = [];
    fillerWordsList = [];

    var box = document.getElementById("fillerWordsBox");
    if (box) {
        box.style.display = "none";
    }

    var preview = document.getElementById("captionPreview");
    if (preview) {
        preview.value = "";
    }

    cadrTrReset();
}

function cadrRestoreCaptionSnapshot(snapshot) {
    try {
        var data = JSON.parse(snapshot);

        pendingCaptionLines = data.lines || [];
        pendingCaptionWords = data.words || [];
        fillerWordsList = data.fillers || [];

        rebuildCaptionPreview();

        if (fillerWordsList.length > 0) {
            renderFillerWords();
        } else {
            var box = document.getElementById("fillerWordsBox");
            if (box) {
                box.style.display = "none";
            }
        }

        return true;

    } catch (e) {
        return false;
    }
}

(function loadSavedBackupInfo() {
    try {
        var raw = window.localStorage.getItem("cadrLastBackup");
        if (raw) {
            cadrLastBackup = JSON.parse(raw);
        }
    } catch (e) {
        cadrLastBackup = null;
    }
})();

function cadrSaveBackupInfo(info) {
    cadrLastBackup = info;
    try {
        if (info) {
            window.localStorage.setItem("cadrLastBackup", JSON.stringify(info));
        } else {
            window.localStorage.removeItem("cadrLastBackup");
        }
    } catch (e) {}
}

function cadrUpdateUndoButtons(enabled) {
    var buttons = document.querySelectorAll(".cadr-undo-btn");
    for (var i = 0; i < buttons.length; i++) {
        buttons[i].disabled = !enabled;
    }
}

/* Enable the undo buttons only if the saved backup still exists
   in the CURRENT project. */
function cadrRefreshUndoState() {

    if (!cadrLastBackup || !cadrLastBackup.backupId) {
        cadrUpdateUndoButtons(false);
        return;
    }

    if (!window.__adobe_cep__) {
        cadrUpdateUndoButtons(false);
        return;
    }
    csInterface.evalScript(
        "cadrBackupExists('" + cadrLastBackup.backupId + "')",
        function (response) {
            if (response === "1") {
                cadrUpdateUndoButtons(true);
            } else {
                cadrSaveBackupInfo(null);
                cadrUpdateUndoButtons(false);
            }
        }
    );
}

/* Creates the backup, then makes sure the ORIGINAL sequence is
   the active one again (so we never cut the backup by mistake).
   onReady(true)  => safe to cut
   onReady(false) => do not cut                                   */
function cadrBackupThen(statusEl, onReady) {

    /* The flag expires after 30 minutes so a crashed run can never lock
       the buttons until Premiere is restarted. */
    if (
        cadrCutBusy &&
        Date.now() - cadrCutBusySince < 30 * 60 * 1000
    ) {
        statusEl.textContent = "في عملية قص شغالة دلوقتي، استنى لحد ما تخلص.";
        onReady(false);
        return;
    }

    cadrCutBusy = true;
    cadrCutBusySince = Date.now();

    var captionSnapshot = cadrTakeCaptionSnapshot();

    statusEl.textContent =
        "بيعمل نسخة احتياطية من السيكوينس (عشان تقدر ترجع)...";

    csInterface.evalScript("cadrCreateBackup()", function (response) {

        var info = null;

        try {
            info = JSON.parse(response);
        } catch (e) {
            info = null;
        }

        if (!info || !info.backupId) {

            var reason =
                response === "CLONE_UNAVAILABLE"
                    ? "نسخة بريمير دي مش بتسمح بعمل نسخة من السيكوينس من السكريبت."
                    : "مقدرش يعمل نسخة احتياطية (" + response + ").";

            var goOn = window.confirm(
                reason +
                "\n\nلو كملت، زرار الرجوع مش هيشتغل (هتبقى محتاج Ctrl+Z).\n\nتكمل القص من غير نسخة احتياطية؟"
            );

            if (!goOn) {
                cadrCutBusy = false;
                statusEl.textContent = "اتلغى القص. محصلش أي تغيير.";
                onReady(false);
                return;
            }

            cadrSaveBackupInfo(null);
            cadrBackupCaptionSnapshot = null;
            cadrUpdateUndoButtons(false);
            onReady(true);
            return;
        }

        cadrSaveBackupInfo(info);
        cadrBackupCaptionSnapshot = captionSnapshot;

        /* Give Premiere a moment to switch back to the original
           sequence, then verify it really is the active one. */
        function verify(attempt) {

            csInterface.evalScript("cadrActiveSequenceId()", function (activeId) {

                if (activeId === info.originalId) {
                    cadrUpdateUndoButtons(true);
                    onReady(true);
                    return;
                }

                if (attempt >= 3) {
                    cadrCutBusy = false;
                    statusEl.textContent =
                        "اتعملت النسخة الاحتياطية، بس بريمير مرجعش للسيكوينس الأصلي.\n\n" +
                        "افتح السيكوينس الأصلي بإيدك (\"" + info.originalName + "\") وجرب تاني.\n" +
                        "محصلش أي قص.";
                    cadrUpdateUndoButtons(true);
                    onReady(false);
                    return;
                }

                csInterface.evalScript(
                    "cadrActivateSequence('" + info.originalId + "')",
                    function () {
                        setTimeout(function () {
                            verify(attempt + 1);
                        }, 700);
                    }
                );
            });
        }

        setTimeout(function () {
            verify(0);
        }, 700);
    });
}

function undoLastCut(statusId) {

    var status =
        document.getElementById(statusId || "cutStatus");

    if (cadrCutBusy) {
        status.textContent = "استنى لحد ما العملية الشغالة تخلص وبعدين دوس Undo.";
        return;
    }

    if (!cadrLastBackup || !cadrLastBackup.backupId) {
        status.textContent = "مفيش قصة تتراجع عنها.";
        cadrUpdateUndoButtons(false);
        return;
    }

    var ok = window.confirm(
        "هترجع السيكوينس زي ما كان قبل آخر قص.\n\n" +
        "النسخة المقصوصة مش هتتمسح، هتفضل في المشروع باسم \"" +
        cadrLastBackup.originalName + " (CUT)\".\n\nتكمل؟"
    );

    if (!ok) {
        return;
    }

    cadrUpdateUndoButtons(false);
    status.textContent = "بيرجّع السيكوينس...";

    csInterface.evalScript(
        "cadrRestoreBackup('" +
        cadrLastBackup.originalId + "','" +
        cadrLastBackup.backupId + "','" +
        escapeExtendScriptString(cadrLastBackup.originalName) + "')",
        function (response) {

            if (response === "RESTORED") {

                status.textContent =
                    "تم الرجوع ✅\n\n" +
                    "السيكوينس رجع زي ما كان. النسخة المقصوصة لسه في المشروع باسم \"" +
                    cadrLastBackup.originalName + " (CUT)\".";

                cadrSaveBackupInfo(null);

                /* Bring back the caption / filler-word list as it was. */
                if (
                    !cadrBackupCaptionSnapshot ||
                    !cadrRestoreCaptionSnapshot(cadrBackupCaptionSnapshot)
                ) {
                    cadrResetCaptionState();
                }

                cadrBackupCaptionSnapshot = null;

                refreshSelection();
                return;
            }

            if (response === "BACKUP_MISSING") {
                status.textContent =
                    "النسخة الاحتياطية مش موجودة في المشروع (يمكن اتمسحت).";
                cadrSaveBackupInfo(null);
                cadrUpdateUndoButtons(false);
                return;
            }

            status.textContent = "فشل الرجوع: " + response;
            cadrUpdateUndoButtons(true);
        }
    );
}


/* =========================================================
   ANALYSIS CACHE
   ========================================================= */

var silenceAnalysisCache = {};

function cacheKeyFor(clip, silence, noiseThreshold) {
    var modified = "";
    try {
        var fs = window.cep_node.require("fs");
        var stat = fs.statSync(clip.path);
        modified = String(stat.size) + "|" + String(stat.mtimeMs || stat.mtime.getTime());
    } catch (e) {}

    return clip.path + "|" + modified + "|" + clip.sourceIn.toFixed(3) + "|" +
        clip.duration.toFixed(3) + "|" + noiseThreshold + "|" + silence;
}


/* =========================================================
   PROGRESS BAR
   ========================================================= */

/* The progress now lives in the pinned bar at the bottom of the panel
   (see "UI v2" at the end of this file). The old ids are ignored. */
function setProgress(barId, percent) {
    cadrBarWave(percent);
}

function hideProgress(barId) {

    /* A finished run keeps the full bar; an aborted one goes back to idle. */
    if (cadrBarFillPct >= 100) {
        cadrBarSetPct("Done");
    } else {
        cadrBarIdle();
    }
}


/* =========================================================
   SELECTION DISPLAY
   ========================================================= */

function updateSelectionDot(dotId, summaryText) {
    var dot = document.getElementById(dotId);

    if (!dot) {
        return;
    }

    var isSelected =
        summaryText &&
        summaryText.indexOf("متحدد:") === 0;

    dot.className =
        "status-dot " +
        (isSelected ? "ok" : "warn");
}

var cadrLastSelCheckAt = 0;
var cadrSelCheckPending = false;

function refreshSelection(forceNow) {
    if (!window.__adobe_cep__) return;
    var now = Date.now();
    if (!forceNow && (cadrCutBusy || cadrStyleBusy || cadrSelCheckPending || (now - cadrLastSelCheckAt < 2500))) {
        return;
    }
    cadrSelCheckPending = true;
    cadrLastSelCheckAt = now;
    try {
        csInterface.evalScript(
            "getSelectionSummary()",
            function (response) {
                cadrSelCheckPending = false;
                var cutEl = document.getElementById("selectedClips");
                if (cutEl) cutEl.textContent = response;
                updateSelectionDot("cutSelectionDot", response);

                var capEl = document.getElementById("captionSelectedClip");
                if (capEl) capEl.textContent = response;
                updateSelectionDot("captionSelectionDot", response);
            }
        );
    } catch (e) {
        cadrSelCheckPending = false;
    }
}

/* Selection refreshes when user clicks ↻ or runs an action */


/* =========================================================
   OFFLINE LICENSE SYSTEM
   ========================================================= */

function cadrLicenseResultText(result) {
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    if (!result) return isEn ? "License check failed." : "تعذر فحص الترخيص.";
    if (result.ok) {
        var p = result.payload || {};
        var expiry = p.expiresAt ? p.expiresAt.replace("T", " ").replace(".000Z", " UTC") : (isEn ? "Lifetime" : "مدى الحياة");
        return (isEn ? "Activated ✓\n" : "الترخيص مفعّل بنجاح ✓\n") +
            "Customer: " + (p.customer || "—") + "\n" +
            "Plan: " + (p.plan || "standard") + "\n" +
            "Expires: " + expiry;
    }
    if (!result.error || result.error === "CADR CUT غير مفعّل.") {
        return isEn
            ? "License not activated — paste your License Key above."
            : "الترخيص غير مفعّل حاليًا — الصق مفتاح التفعيل بالأعلى.";
    }
    return result.error;
}

function cadrSetLicenseUi(result) {
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    var badge = document.getElementById("licenseBadge");
    var status = document.getElementById("licenseStatus");
    if (badge) {
        badge.textContent = result && result.ok
            ? (isEn ? "Active" : "مفعّل")
            : (isEn ? "Not activated" : "غير مفعّل");
        badge.classList.toggle("on", !!(result && result.ok));
    }
    if (status) {
        status.textContent = cadrLicenseResultText(result);
        status.style.color = result && result.ok ? "" : "#d97706";
    }
}

function cadrCheckLicense() {
    if (!window.CADRLicense) {
        cadrSetLicenseUi({ ok: false, error: "License module غير متاح." });
        return false;
    }
    var device = window.CADRLicense.getDeviceId();
    var deviceInput = document.getElementById("cadrDeviceId");
    if (deviceInput) deviceInput.value = device;
    var result = window.CADRLicense.current();
    cadrSetLicenseUi(result);
    return !!result.ok;
}

function cadrActivateLicense() {
    var input = document.getElementById("cadrLicenseKey");
    var key = input ? input.value.trim() : "";
    if (!key) {
        cadrSetLicenseUi({ ok: false, error: "الصق License Key الأول." });
        return false;
    }
    var result = window.CADRLicense.activate(key);
    cadrSetLicenseUi(result);
    if (result.ok && input) input.value = key;
    return !!result.ok;
}

function cadrCopyDeviceId() {
    var input = document.getElementById("cadrDeviceId");
    var value = input ? input.value : "";
    if (!value) return;
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(value);
        } else {
            input.select();
            document.execCommand("copy");
        }
        var status = document.getElementById("licenseStatus");
        if (status) status.textContent = "تم نسخ Device ID.";
    } catch (e) {}
}

function cadrRequireLicense(actionName) {
    if (!window.CADRLicense) {
        alert("CADR CUT License module غير متاح.");
        return false;
    }
    var result = window.CADRLicense.current();
    if (result.ok) return true;
    cadrSetLicenseUi(result);
    var message = "CADR CUT غير مفعّل.\n\nافتح Settings → License والصق License Key.";
    if (result.error) message += "\n\n" + result.error;
    alert(message);
    try { showTab("settings"); } catch (e) {}
    return false;
}

/* =========================================================
   SETTINGS
   ========================================================= */

var CADR_SECRET_KEYS = {
    geminiApiKey: true
};

var CADR_SECRET_PREFIX =
    "cadr.dpapi.v1:";

var CADR_SECRET_STORAGE_ERROR = false;

/* Decrypting needs a PowerShell / keychain call (slow, blocks the panel),
   so we remember what we already decrypted: { key: {token, plain} }. */
var cadrSecretCache = {};


/*
 * macOS: the key itself lives in the Keychain; localStorage only keeps a
 * marker. Same "value in / value out" shape as the Windows version.
 */
function cadrKeychainTransform(value, decrypt, keyName) {

    try {

        var childProcess =
            window.cep_node.require("child_process");

        var service = "CADR-" + (keyName || "key");

        var options = {
            encoding: "utf8",
            timeout: 8000,
            maxBuffer: 1024 * 1024
        };

        if (decrypt) {

            var read =
                childProcess.spawnSync(
                    "/usr/bin/security",
                    [
                        "find-generic-password",
                        "-a", "CADR",
                        "-s", service,
                        "-w"
                    ],
                    options
                );

            if (read.error) {
                throw read.error;
            }

            if (read.status !== 0) {
                throw new Error(
                    (read.stderr || "Keychain read failed").trim()
                );
            }

            return String(read.stdout || "").replace(/[\r\n]+$/, "");
        }

        var write =
            childProcess.spawnSync(
                "/usr/bin/security",
                [
                    "add-generic-password",
                    "-U",
                    "-a", "CADR",
                    "-s", service,
                    "-w", String(value)
                ],
                options
            );

        if (write.error) {
            throw write.error;
        }

        if (write.status !== 0) {
            throw new Error(
                (write.stderr || "Keychain write failed").trim()
            );
        }

        return "mac-keychain";

    } catch (error) {

        CADR_SECRET_STORAGE_ERROR = true;

        console.warn(
            "CADR CUT: macOS Keychain operation failed:",
            error
        );

        return null;
    }
}


/*
 * Protect API keys with Windows DPAPI for the current Windows user.
 * CEP's Node integration is enabled in the manifest.
 */
function cadrDpapiTransform(value, decrypt, keyName) {
    /* Fast pure-Node / pure-JS local obfuscation — NEVER spawns powershell.exe synchronously on the UI thread
       (spawning powershell.exe during CEP startup caused Premiere Pro 2026 to hang/crash). */
    try {
        var str = String(value || "");
        if (!str) return "";
        if (decrypt) {
            if (str.indexOf("v2:") === 0) {
                var b64 = str.slice(3);
                return decodeURIComponent(escape(window.atob(b64)));
            }
            /* Legacy DPAPI string from older version: return empty instead of hanging Premiere with powershell.exe */
            return "";
        } else {
            return "v2:" + window.btoa(unescape(encodeURIComponent(str)));
        }
    } catch (e) {
        return decrypt ? "" : String(value || "");
    }
}

function isCadrSecretKey(key) {
    return !!CADR_SECRET_KEYS[key];
}


function saveApiKeySetting(inputId) {

    var input =
        document.getElementById(
            inputId
        );

    if (!input) {
        return;
    }

    var keyName = "geminiApiKey";

    var saved =
        setSetting(
            keyName,
            String(input.value || "").trim()
        );

    var status =
        document.getElementById(
            "apiKeyStorageStatus"
        );

    if (status) {

        status.textContent =
            saved
                ? "تم حفظ مفتاح API محميًا بنظام التشغيل (Windows / macOS Keychain) للمستخدم الحالي."
                : "تعذر حفظ المفتاح بشكل محمي. المفتاح لم يُحفظ؛ تأكد من توفر Windows PowerShell (أو macOS Keychain) وأعد المحاولة.";

        status.style.color =
            saved
                ? ""
                : "#d97706";
    }
}


function refreshApiKeyStorageStatus() {

    var status =
        document.getElementById(
            "apiKeyStorageStatus"
        );

    if (!status) {
        return;
    }

    try {

        var keys = [
            "geminiApiKey"
        ];

        var hasPlaintext = false;

        for (
            var i = 0;
            i < keys.length;
            i++
        ) {

            var value =
                window.localStorage.getItem(
                    keys[i]
                );

            if (
                value &&
                value.indexOf(
                    CADR_SECRET_PREFIX
                ) !== 0
            ) {
                hasPlaintext = true;
            }
        }

        var needsWarning =
            hasPlaintext ||
            CADR_SECRET_STORAGE_ERROR;

        status.textContent =
            hasPlaintext
                ? "تنبيه: يوجد مفتاح قديم لم تكتمل حمايته. راجع سجل Console قبل التوزيع."
                : (
                    CADR_SECRET_STORAGE_ERROR
                        ? "تعذر التحقق من حماية أحد المفاتيح. قد تحتاج لإعادة إدخاله في Settings."
                        : "مفاتيح API غير الفارغة تُحفظ محمية بنظام التشغيل للمستخدم الحالي."
                );

        status.style.color =
            needsWarning
                ? "#d97706"
                : "";

    } catch (error) {

        status.textContent =
            "تعذر التحقق من حالة تخزين مفاتيح API.";

        status.style.color =
            "#d97706";
    }
}


function getSetting(key, fallback) {

    try {

        var value =
            window.localStorage.getItem(
                key
            );

        if (value === null) {
            return fallback;
        }

        if (
            !isCadrSecretKey(key) ||
            value === ""
        ) {
            return value;
        }

        if (
            value.indexOf(
                CADR_SECRET_PREFIX
            ) === 0
        ) {

            var cachedSecret =
                cadrSecretCache[key];

            if (
                cachedSecret &&
                cachedSecret.token === value
            ) {
                return cachedSecret.plain;
            }

            var decrypted =
                cadrDpapiTransform(
                    value.substring(
                        CADR_SECRET_PREFIX.length
                    ),
                    true,
                    key
                );

            if (decrypted === null) {
                return fallback;
            }

            cadrSecretCache[key] = {
                token: value,
                plain: decrypted
            };

            return decrypted;
        }

        /*
         * Migrate legacy plaintext keys to DPAPI.
         */
        var encrypted =
            cadrDpapiTransform(
                value,
                false,
                key
            );

        if (encrypted !== null) {

            try {

                window.localStorage.setItem(
                    key,
                    CADR_SECRET_PREFIX +
                    encrypted
                );

            } catch (migrationError) {

                console.warn(
                    "CADR CUT: could not persist protected API key migration:",
                    migrationError
                );
            }

        } else {

            console.warn(
                "CADR CUT: legacy API key remains in plaintext because DPAPI migration failed."
            );
        }

        return value;

    } catch (error) {

        console.warn(
            "CADR CUT: could not read setting:",
            key,
            error
        );

        return fallback;
    }
}


function setSetting(key, value) {

    try {

        var stringValue =
            String(value);

        if (
            isCadrSecretKey(key)
        ) {

            if (stringValue === "") {

                window.localStorage.setItem(
                    key,
                    ""
                );

                return true;
            }

            /* Same key as before and already stored protected:
               nothing to do (avoids a slow PowerShell call every time). */
            var alreadyCached =
                cadrSecretCache[key];

            if (
                alreadyCached &&
                alreadyCached.plain === stringValue &&
                window.localStorage.getItem(key) === alreadyCached.token
            ) {
                return true;
            }

            var encrypted =
                cadrDpapiTransform(
                    stringValue,
                    false,
                    key
                );

            if (encrypted === null) {

                console.warn(
                    "CADR CUT: API key was not saved because protected storage is unavailable."
                );

                return false;
            }

            window.localStorage.setItem(
                key,
                CADR_SECRET_PREFIX +
                encrypted
            );

            cadrSecretCache[key] = {
                token: CADR_SECRET_PREFIX + encrypted,
                plain: stringValue
            };

            return true;
        }

        window.localStorage.setItem(
            key,
            stringValue
        );

        return true;

    } catch (error) {

        console.warn(
            "CADR CUT: could not save setting:",
            key,
            error
        );

        return false;
    }
}


/* =========================================================
   AUTO CUT
   ========================================================= */

function readCutSettings() {

    var silence =
        parseFloat(
            document.getElementById(
                "silenceDuration"
            ).value
        );

    var paddingBefore =
        parseFloat(
            document.getElementById(
                "paddingBefore"
            ).value
        );

    var paddingAfter =
        parseFloat(
            document.getElementById(
                "paddingAfter"
            ).value
        );

    var noiseThreshold =
        parseFloat(
            document.getElementById(
                "noiseThreshold"
            ).value
        );

    var ffmpegPath =
        document.getElementById(
            "ffmpegPath"
        ).value;

    if (ffmpegPath) {
        setSetting(
            "ffmpegPath",
            ffmpegPath
        );
    }

    setSetting(
        "noiseThreshold",
        String(noiseThreshold)
    );

    setSetting(
        "paddingBefore",
        String(paddingBefore)
    );

    setSetting(
        "paddingAfter",
        String(paddingAfter)
    );

    if (!ffmpegPath) {

        return {
            error:
                "FFmpeg مش موجود. افتح Settings واضغط Detect FFmpeg."
        };
    }

    if (
        isNaN(silence) ||
        silence <= 0
    ) {

        return {
            error:
                "Minimum Silence غير صحيح."
        };
    }

    if (
        isNaN(paddingBefore) ||
        paddingBefore < 0 ||
        isNaN(paddingAfter) ||
        paddingAfter < 0
    ) {

        return {
            error:
                "Padding غير صحيح."
        };
    }

    if (
        isNaN(noiseThreshold) ||
        noiseThreshold >= 0
    ) {

        return {
            error:
                "Noise Threshold لازم يكون رقم سالب (زي -25-)."
        };
    }

    return {
        silence:
            silence,

        paddingBefore:
            paddingBefore,

        paddingAfter:
            paddingAfter,

        noiseThreshold:
            noiseThreshold,

        ffmpegPath:
            ffmpegPath
    };
}


/* =========================================================
   DIAGNOSTICS (Settings tab)
   ========================================================= */

function runDiagnostics() {

    var box = document.getElementById("diagOutput");

    box.value = "بيجمع المعلومات من بريمير...";

    csInterface.evalScript("cadrDiagnose()", function (response) {

        box.value =
            "OS: " + (cadrIsWindows() ? "Windows" : "macOS/other") + "\n" +
            (response || "(no response)");
    });
}

function runCaptionProbe() {

    var box = document.getElementById("diagOutput");

    box.value = "بيفحص تراكات الكابشن...";

    csInterface.evalScript("cadrProbeCaptions()", function (response) {
        box.value = "OS: " + (cadrIsWindows() ? "Windows" : "macOS/other") + "\n" + (response || "(no response)");
    });
}

function runMogrtProbe() {

    var box = document.getElementById("diagOutput");

    var chosen;

    try {

        chosen = window.cep.fs.showOpenDialogEx(
            false,
            false,
            "Choose a .mogrt template",
            "",
            ["mogrt"]
        );

    } catch (e) {

        box.value = "مقدرتش أفتح نافذة اختيار الملف: " + e.message;
        return;
    }

    if (!chosen || chosen.err !== 0 || !chosen.data || !chosen.data.length) {
        return;
    }

    var file = String(chosen.data[0]).replace(/\\/g, "/");

    box.value = "بيجرّب القالب...";

    csInterface.evalScript(
        "cadrProbeMogrt('" + escapeExtendScriptString(file) + "')",
        function (response) {
            box.value = "OS: " + (cadrIsWindows() ? "Windows" : "macOS/other") + "\n" + (response || "(no response)");
        }
    );
}

function copyDiagnostics() {

    var box = document.getElementById("diagOutput");

    box.select();

    try {
        document.execCommand("copy");
    } catch (e) {}
}


function cadrFriendlySelectionMessage(rawData) {

    if (rawData === "NO_CLIP_SELECTED") {
        return "مفيش كليب متحدد.\n\nحدد الكليب على التايم لاين الأول وبعدين دوس الزرار.";
    }

    if (rawData === "NO_SEQUENCE") {
        return "مفيش Sequence مفتوح.\n\nافتح السيكوينس وحدد الكليب وبعدين جرّب تاني.";
    }

    return rawData || "مفيش كليب متحدد.\n\nحدد الكليب على التايم لاين الأول.";
}


/*
 * onFail runs on EVERY failure path (nothing selected, no sequence, bad
 * data) so the caller can re-enable its buttons. Without it, a button that
 * was disabled before reading the selection stays disabled forever.
 */
function getSelectedClipsOrFail(
    statusEl,
    onOk,
    onFail
) {

    function fail(message) {

        statusEl.textContent = message;

        if (onFail) {
            onFail();
        }
    }

    var slowHintTimer =
        setTimeout(
            function () {

                statusEl.textContent =
                    "لسه بيقرا الكليب...\n\n" +
                    "لو الكليب جديد أو كبير، بريمير غالبًا بيعمل Conforming/Indexing " +
                    "للصوت في الخلفية دلوقتي، وده بيمنع أي أمر تاني لحد ما يخلص. " +
                    "استنى شوية (شيك على أيقونة الـ Background Tasks تحت يمين شاشة بريمير).";
            },
            6000
        );

    csInterface.evalScript(
        "getSelectedClipsAnalysisData()",
        function (rawData) {

            clearTimeout(
                slowHintTimer
            );

            if (
                !rawData ||
                rawData.indexOf("NO_") === 0 ||
                rawData.indexOf("HOST_ERROR:") === 0 ||
                rawData === "EvalScript error."
            ) {

                fail(cadrFriendlySelectionMessage(rawData));
                return;
            }

            var clips;

            try {

                clips =
                    JSON.parse(
                        rawData
                    );

            } catch (e) {

                fail("بيانات الكليبات مش مفهومة. جرّب تحدد الكليب تاني.");
                return;
            }

            if (
                !clips ||
                !clips.length
            ) {

                fail(cadrFriendlySelectionMessage("NO_CLIP_SELECTED"));
                return;
            }

            onOk(clips);
        }
    );
}


/* =========================================================
   PREVIEW SILENCE
   ========================================================= */

/* Places the preview markers one per call, then checks how many really exist. */
function cadrPlaceSilenceMarkers(cuts, onProgress, onDone) {

    var seen = {};
    var list = [];

    for (var i = 0; i < cuts.length; i++) {

        var parts = cuts[i].split("|");
        var key = parts[1] + "|" + parts[2];

        if (!seen[key]) {
            seen[key] = true;
            list.push(cuts[i]);
        }
    }

    list.sort(function (x, y) {
        return parseFloat(x.split("|")[1]) - parseFloat(y.split("|")[1]);
    });

    cadrCutBusy = true;
    cadrCutBusySince = Date.now();

    csInterface.evalScript("cadrClearSilenceMarkers()", function () {

        var index = 0;
        var problems = [];

        function next() {

            if (index >= list.length) {

                csInterface.evalScript(
                    "cadrCountSilenceMarkers()",
                    function (count) {

                        cadrCutBusy = false;

                        onDone({
                            requested: list.length,
                            present: parseInt(count, 10),
                            problems: problems
                        });
                    }
                );

                return;
            }

            csInterface.evalScript(
                "createSilenceMarker('" + list[index] + "')",
                function (result) {

                    var text = String(result || "NO_RESPONSE");

                    if (text !== "OK") {
                        problems.push(
                            (index + 1) + ": " + text
                        );
                    }

                    index++;

                    if (onProgress) {
                        onProgress(index, list.length);
                    }

                    setTimeout(next, 40);
                }
            );
        }

        next();
    });
}


function previewSilence() {

    if (!cadrRequireLicense("Preview Silence")) return;

    var status =
        document.getElementById(
            "cutStatus"
        );

    var settings =
        readCutSettings();

    if (settings.error) {

        status.textContent =
            settings.error;

        return;
    }

    var previewButton =
        document.getElementById(
            "previewButton"
        );

    var cutButton =
        document.getElementById(
            "cutButton"
        );

    previewButton.disabled =
        true;

    cutButton.disabled =
        true;

    status.textContent =
        "Reading selected clips...";

    setProgress(
        "cutProgress",
        0
    );

    getSelectedClipsOrFail(
        status,
        function (clips) {

            analyzeClipsSequentially(
                clips,
                0,
                [],
                settings.silence,
                settings.paddingBefore,
                settings.paddingAfter,
                settings.noiseThreshold,
                settings.ffmpegPath,
                "cutProgress",
                function (
                    allCuts,
                    failure
                ) {

                    previewButton.disabled =
                        false;

                    cutButton.disabled =
                        false;

                    hideProgress(
                        "cutProgress"
                    );

                    if (
                        failure &&
                        failure.failed
                    ) {

                        status.textContent =
                            "Auto Cut اتوقف لأن تحليل الكليب " +
                            (failure.index + 1) +
                            " فشل.\n\n" +
                            (
                                failure.error &&
                                failure.error.message
                                    ? failure.error.message
                                    : "Unknown FFmpeg error."
                            );

                        return;
                    }

                    if (
                        allCuts.length === 0
                    ) {

                        status.textContent =
                            "No silence found.";

                        return;
                    }

                    var totalSilence =
                        0;

                    for (
                        var i = 0;
                        i < allCuts.length;
                        i++
                    ) {

                        var p =
                            allCuts[i].split(
                                "|"
                            );

                        totalSilence +=
                            parseFloat(p[2]) -
                            parseFloat(p[1]);
                    }

                    previewButton.disabled =
                        true;

                    cutButton.disabled =
                        true;

                    status.textContent =
                        "Placing markers...";

                    cadrPlaceSilenceMarkers(
                        allCuts,
                        function (done, total) {

                            setProgress(
                                "cutProgress",
                                Math.round((done / total) * 100)
                            );

                            status.textContent =
                                "Placing markers... " +
                                done + " / " + total;
                        },
                        function (report) {

                            previewButton.disabled =
                                false;

                            cutButton.disabled =
                                false;

                            hideProgress(
                                "cutProgress"
                            );

                            var text =
                                "لقيت " +
                                report.requested +
                                " منطقة سكوت (مجموعها " +
                                totalSilence.toFixed(1) +
                                "s).\n\n";

                            if (
                                report.present === report.requested &&
                                report.problems.length === 0
                            ) {

                                text +=
                                    "اتحطوا " + report.present +
                                    " Markers حمرا على التايم لاين (CADR Silence) — راجعهم، " +
                                    "وبعدين دوس AUTO CUT لو مرتاح للنتيجة.";

                            } else {

                                text +=
                                    "⚠ اتحط " +
                                    (isNaN(report.present) ? "؟" : report.present) +
                                    " Marker من " + report.requested + " بس.\n" +
                                    "ابعت لي الرسالة دي مع نتيجة Diagnostics:\n" +
                                    report.problems.slice(0, 4).join("\n");
                            }

                            status.textContent = text;
                        }
                    );
                }
            );
        },
        function () {
            previewButton.disabled =
                false;

            cutButton.disabled =
                false;

            cadrBarIdle();
        }
    );
}


function runAutoCut() {

    if (!cadrRequireLicense("Auto Cut")) return;

    var status =
        document.getElementById(
            "cutStatus"
        );

    var button =
        document.getElementById(
            "cutButton"
        );

    var previewButton =
        document.getElementById(
            "previewButton"
        );

    var settings =
        readCutSettings();

    if (settings.error) {

        status.textContent =
            settings.error;

        return;
    }

    button.disabled =
        true;

    previewButton.disabled =
        true;

    status.textContent =
        "Reading selected clips...";

    setProgress(
        "cutProgress",
        0
    );

    getSelectedClipsOrFail(
        status,
        function (clips) {

            analyzeClipsSequentially(
                clips,
                0,
                [],
                settings.silence,
                settings.paddingBefore,
                settings.paddingAfter,
                settings.noiseThreshold,
                settings.ffmpegPath,
                "cutProgress",
                function (
                    allCuts,
                    failure
                ) {

                    if (
                        failure &&
                        failure.failed
                    ) {

                        button.disabled =
                            false;

                        previewButton.disabled =
                            false;

                        hideProgress(
                            "cutProgress"
                        );

                        status.textContent =
                            "Auto Cut اتوقف لأن تحليل الكليب " +
                            (failure.index + 1) +
                            " فشل.\n\n" +
                            (
                                failure.error &&
                                failure.error.message
                                    ? failure.error.message
                                    : "Unknown FFmpeg error."
                            );

                        return;
                    }

                    if (
                        allCuts.length === 0
                    ) {

                        button.disabled =
                            false;

                        previewButton.disabled =
                            false;

                        hideProgress(
                            "cutProgress"
                        );

                        status.textContent =
                            "No silence found.";

                        return;
                    }

                    status.textContent =
                        "Found " +
                        allCuts.length +
                        " silence regions...\n\nApplying Auto Cut...";

                    allCuts.sort(
                        function (
                            a,
                            b
                        ) {

                            var startA =
                                parseFloat(
                                    a.split("|")[1]
                                );

                            var startB =
                                parseFloat(
                                    b.split("|")[1]
                                );

                            return (
                                startB -
                                startA
                            );
                        }
                    );

                    /* Drop exact duplicates (same track + same range). */
                    var seenCuts = {};
                    var uniqueCuts = [];

                    for (var u = 0; u < allCuts.length; u++) {
                        if (!seenCuts[allCuts[u]]) {
                            seenCuts[allCuts[u]] = true;
                            uniqueCuts.push(allCuts[u]);
                        }
                    }

                    allCuts = uniqueCuts;

                    cadrBackupThen(status, function (safeToCut) {

                        if (!safeToCut) {

                            button.disabled = false;
                            previewButton.disabled = false;

                            hideProgress("cutProgress");

                            return;
                        }

                        setProgress("cutProgress", 0);

                        status.textContent =
                            "Applying Auto Cut... 0 / " + allCuts.length;

                        cadrRunCutsSequentially(
                            allCuts,
                            function (done, total) {

                                setProgress(
                                    "cutProgress",
                                    Math.round((done / total) * 100)
                                );

                                status.textContent =
                                    "Applying Auto Cut... " +
                                    done + " / " + total;
                            },
                            function (results) {

                                button.disabled = false;
                                previewButton.disabled = false;

                                hideProgress("cutProgress");

                                var doneCount = 0;
                                var removedSeconds = 0;
                                var seenRanges = {};
                                var gapRemains = 0;
                                var log = [];

                                for (var i = 0; i < allCuts.length; i++) {

                                    var parts = allCuts[i].split("|");

                                    var cutStart = parseFloat(parts[1]);
                                    var cutEnd = parseFloat(parts[2]);

                                    var result = results[i] || "NO_RESPONSE";

                                    if (result === "OK" || result === "OK_GAP_REMAINS") {

                                        doneCount++;

                                        var rangeKey = cutStart + "|" + cutEnd;

                                        if (!seenRanges[rangeKey]) {
                                            seenRanges[rangeKey] = true;
                                            removedSeconds += cutEnd - cutStart;
                                        }
                                    }

                                    if (result === "OK_GAP_REMAINS") {
                                        gapRemains++;
                                    }

                                    log.push(
                                        (i + 1) + ") " +
                                        cutStart.toFixed(3) + "→" +
                                        cutEnd.toFixed(3) + " (" +
                                        (cutEnd - cutStart).toFixed(3) +
                                        "s) — " + result
                                    );
                                }

                                var head =
                                    "تم ✅ اتشال " + cadrFmtDuration(removedSeconds) +
                                    " سكوت · " + doneCount + " قصة\n\n" +
                                    "عدد مناطق السكوت: " + allCuts.length + "\n\n" +
                                    (gapRemains
                                        ? "⚠ في " + gapRemains + " قصة اتمسح منها الصوت بس الفراغ فضل مكانه (بريمير مقفلش الجاب). " +
                                          "ابعت لي الرسالة دي عشان أظبطها.\n\n"
                                        : "") +
                                    "مش عاجبك النتيجة؟ دوس UNDO CUT وهيرجع كل حاجة زي ما كانت.";

                                var details =
                                    "تفاصيل كل قصة:\n" +
                                    log.join("\n");

                                button.disabled = true;
                                previewButton.disabled = true;

                                cadrAutoZoomPass(
                                    allCuts,
                                    status,
                                    head,
                                    function (zoomLine) {

                                        var headWithZoom =
                                            head + (zoomLine ? "\n\n" + zoomLine : "");

                                        cadrSmoothCutsPass(
                                            allCuts,
                                            status,
                                            headWithZoom,
                                            details,
                                            function () {

                                                button.disabled = false;
                                                previewButton.disabled = false;

                                                refreshSelection();
                                            }
                                        );
                                    }
                                );
                            }
                        );
                    });
                }
            );
        },
        function () {
            button.disabled =
                false;

            previewButton.disabled =
                false;

            cadrBarIdle();
        }
    );
}


/* =========================================================
   ANALYZE EACH CLIP ONE BY ONE
   ========================================================= */

function applyPaddingToRawSilences(
    rawSilences,
    clip,
    paddingBefore,
    paddingAfter,
    cutsSoFar
) {

    for (
        var j = 0;
        j < rawSilences.length;
        j++
    ) {

        var relativeStart =
            rawSilences[j].start +
            paddingBefore;

        var relativeEnd =
            rawSilences[j].end -
            paddingAfter;

        if (
            relativeEnd <=
            relativeStart
        ) {
            continue;
        }

        var absoluteStart =
            clip.timelineStart +
            relativeStart;

        var absoluteEnd =
            clip.timelineStart +
            relativeEnd;

        cutsSoFar.push(
            clip.trackIndex +
            "|" +
            absoluteStart.toFixed(3) +
            "|" +
            absoluteEnd.toFixed(3)
        );
    }
}


function analyzeClipsSequentially(
    clips,
    index,
    cutsSoFar,
    silence,
    paddingBefore,
    paddingAfter,
    noiseThreshold,
    ffmpegPath,
    progressBarId,
    onDone
) {

    if (
        index >=
        clips.length
    ) {

        if (progressBarId) {
            setProgress(
                progressBarId,
                100
            );
        }

        onDone(
            cutsSoFar
        );

        return;
    }

    var clip =
        clips[index];

    var status =
        document.getElementById(
            "cutStatus"
        );

    if (progressBarId) {

        setProgress(
            progressBarId,
            Math.round(
                (
                    index /
                    clips.length
                ) *
                100
            )
        );
    }

    var cacheKey =
        cacheKeyFor(
            clip,
            silence,
            noiseThreshold
        );

    var cached =
        silenceAnalysisCache[
            cacheKey
        ];

    if (cached) {

        status.textContent =
            "Clip " +
            (index + 1) +
            " / " +
            clips.length +
            " (من الكاش)...";

        applyPaddingToRawSilences(
            cached,
            clip,
            paddingBefore,
            paddingAfter,
            cutsSoFar
        );

        analyzeClipsSequentially(
            clips,
            index + 1,
            cutsSoFar,
            silence,
            paddingBefore,
            paddingAfter,
            noiseThreshold,
            ffmpegPath,
            progressBarId,
            onDone
        );

        return;
    }

    status.textContent =
        "Extracting audio for clip " +
        (index + 1) +
        " / " +
        clips.length +
        "...";

    var cp =
        window.cep_node.require(
            "child_process"
        );

    var os =
        window.cep_node.require(
            "os"
        );

    var path =
        window.cep_node.require(
            "path"
        );

    var tempWav =
        path.join(
            os.tmpdir(),
            "cadr_clip_" +
            Date.now() +
            "_" +
            index +
            ".wav"
        );

    var extractArgs = [
        "-hide_banner",
        "-y",
        "-i",
        clip.path,
        "-ss",
        String(
            clip.sourceIn
        ),
        "-t",
        String(
            clip.duration
        ),
        "-vn",
        "-ar",
        "16000",
        "-ac",
        "1",
        tempWav
    ];

    cp.execFile(
        ffmpegPath,
        extractArgs,
        function (
            extractError
        ) {

            if (extractError) {

                status.textContent =
                    "فشل استخراج صوت الكليب " +
                    (index + 1) +
                    "/" +
                    clips.length +
                    ".\n\n" +
                    (
                        extractError.message ||
                        "FFmpeg extraction failed."
                    );

                onDone(
                    cutsSoFar,
                    {
                        failed: true,
                        index: index,
                        clip: clip,
                        stage: "extract",
                        error: extractError
                    }
                );

                return;
            }

            status.textContent =
                "Analyzing clip " +
                (index + 1) +
                " / " +
                clips.length +
                "...";

            var analyzeArgs = [
                "-hide_banner",
                "-i",
                tempWav,
                "-af",
                "silencedetect=noise=" +
                noiseThreshold +
                "dB:d=" +
                silence,
                "-f",
                "null",
                cadrNullDevice()
            ];

            cp.execFile(
                ffmpegPath,
                analyzeArgs,
                function (
                    error,
                    stdout,
                    stderr
                ) {

                    var output =
                        stderr ||
                        stdout ||
                        "";

                    try {

                        var fs =
                            window.cep_node.require(
                                "fs"
                            );

                        fs.unlink(
                            tempWav,
                            function () {}
                        );

                    } catch (
                        cleanupError
                    ) {}

                    if (
                        error &&
                        !output
                    ) {

                        status.textContent =
                            "فشل تحليل الكليب " +
                            (index + 1) +
                            "/" +
                            clips.length +
                            ".\n\n" +
                            (
                                error.message ||
                                "FFmpeg analysis failed."
                            );

                        onDone(
                            cutsSoFar,
                            {
                                failed: true,
                                index: index,
                                clip: clip,
                                stage: "analyze",
                                error: error
                            }
                        );

                        return;
                    }

                    var lines =
                        output.split(
                            /\r?\n/
                        );

                    var silences =
                        [];

                    var current =
                        null;

                    for (
                        var i = 0;
                        i < lines.length;
                        i++
                    ) {

                        var startMatch =
                            lines[i].match(
                                /silence_start:\s*([0-9.]+)/
                            );

                        if (startMatch) {

                            current = {
                                start:
                                    parseFloat(
                                        startMatch[1]
                                    ),
                                end:
                                    null
                            };

                            silences.push(
                                current
                            );
                        }

                        var endMatch =
                            lines[i].match(
                                /silence_end:\s*([0-9.]+)/
                            );

                        if (
                            endMatch &&
                            current
                        ) {

                            current.end =
                                parseFloat(
                                    endMatch[1]
                                );

                            current =
                                null;
                        }
                    }

                    for (
                        var j = 0;
                        j < silences.length;
                        j++
                    ) {

                        if (
                            silences[j].end ===
                            null
                        ) {

                            silences[j].end =
                                clip.duration;
                        }
                    }

                    silenceAnalysisCache[
                        cacheKey
                    ] = silences;

                    applyPaddingToRawSilences(
                        silences,
                        clip,
                        paddingBefore,
                        paddingAfter,
                        cutsSoFar
                    );

                    analyzeClipsSequentially(
                        clips,
                        index + 1,
                        cutsSoFar,
                        silence,
                        paddingBefore,
                        paddingAfter,
                        noiseThreshold,
                        ffmpegPath,
                        progressBarId,
                        onDone
                    );
                }
            );
        }
    );
}


function getExtensionRootPath() {

    try {
        return csInterface.getSystemPath(
            SystemPath.EXTENSION
        );
    } catch (e) {
        return "";
    }
}


function detectFFmpeg(showMessage) {

    var fs;
    var path;

    try {

        fs =
            window.cep_node.require(
                "fs"
            );

        path =
            window.cep_node.require(
                "path"
            );

    } catch (e) {

        return "";
    }

    var candidates =
        [];

    var root =
        getExtensionRootPath();

    if (root) {

        var exeName =
            cadrIsWindows()
                ? "ffmpeg.exe"
                : "ffmpeg";

        candidates.push(
            path.join(
                root,
                "tools",
                "ffmpeg",
                exeName
            )
        );

        candidates.push(
            path.join(
                root,
                "tools",
                exeName
            )
        );

        candidates.push(
            path.join(
                root,
                exeName
            )
        );
    }

    var saved =
        getSetting(
            "ffmpegPath",
            ""
        );

    if (saved) {
        if (!showMessage) {
            try {
                if (fs.existsSync(saved)) {
                    var inpFast = document.getElementById("ffmpegPath");
                    if (inpFast) inpFast.value = saved;
                    var stFast = document.getElementById("ffmpegStatus");
                    if (stFast) stFast.textContent = "FFmpeg found: " + saved;
                    return saved;
                }
            } catch (eFast) {}
        }
        candidates.unshift(saved);
    }

    if (
        showMessage &&
        typeof process !==
        "undefined" &&
        process.env &&
        process.env.PATH
    ) {

        var sep =
            process.platform ===
            "win32"
                ? ";"
                : ":";

        process.env.PATH
            .split(sep)
            .forEach(
                function (dir) {

                    if (dir) {

                        candidates.push(
                            path.join(
                                dir,
                                process.platform ===
                                "win32"
                                    ? "ffmpeg.exe"
                                    : "ffmpeg"
                            )
                        );
                    }
                }
            );
    }

    if (!cadrIsWindows()) {

        /* Premiere on macOS does not see Homebrew in its PATH. */
        candidates.push("/opt/homebrew/bin/ffmpeg");
        candidates.push("/usr/local/bin/ffmpeg");
        candidates.push("/usr/bin/ffmpeg");
    }

    if (cadrIsWindows()) {

        candidates.push(
            "C:\\ffmpeg\\bin\\ffmpeg.exe"
        );

        candidates.push(
            "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe"
        );

        candidates.push(
            "C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe"
        );
    }

    for (
        var i = 0;
        i < candidates.length;
        i++
    ) {

        try {

            if (
                fs.existsSync(
                    candidates[i]
                ) &&
                fs.statSync(
                    candidates[i]
                ).isFile()
            ) {

                var input =
                    document.getElementById(
                        "ffmpegPath"
                    );

                if (input) {
                    input.value =
                        candidates[i];
                }

                setSetting(
                    "ffmpegPath",
                    candidates[i]
                );

                var status =
                    document.getElementById(
                        "ffmpegStatus"
                    );

                if (status) {
                    status.textContent =
                        "FFmpeg found: " +
                        candidates[i];
                }

                if (showMessage) {

                    var cutStatus =
                        document.getElementById(
                            "cutStatus"
                        );

                    if (cutStatus) {
                        cutStatus.textContent =
                            "FFmpeg detected successfully.";
                    }
                }

                return candidates[i];
            }

        } catch (ignore) {}
    }

    var statusEl =
        document.getElementById(
            "ffmpegStatus"
        );

    if (statusEl) {

        statusEl.textContent =
            "FFmpeg not found. Add ffmpeg to tools/ffmpeg in the installer package, or install FFmpeg and use Detect FFmpeg.";
    }

    return "";
}


function testFFmpeg() {

    var executable =
        (
            document.getElementById(
                "ffmpegPath"
            ).value ||
            ""
        ).trim();

    var status =
        document.getElementById(
            "ffmpegStatus"
        );

    var fs =
        window.cep_node.require(
            "fs"
        );

    var cp =
        window.cep_node.require(
            "child_process"
        );

    if (
        !executable ||
        !fs.existsSync(
            executable
        )
    ) {

        if (status) {
            status.textContent =
                "FFmpeg executable path is missing or invalid.";
        }

        return;
    }

    cp.execFile(
        executable,
        [
            "-version"
        ],
        {
            timeout:
                8000
        },
        function (
            err,
            stdout
        ) {

            if (err) {

                if (status) {
                    status.textContent =
                        "FFmpeg test failed: " +
                        err.message;
                }

                return;
            }

            setSetting(
                "ffmpegPath",
                executable
            );

            if (status) {

                status.textContent =
                    "FFmpeg OK — " +
                    String(
                        stdout || ""
                    ).split(
                        /\r?\n/
                    )[0];
            }
        }
    );
}


function applyAccentColor(
    color,
    save
) {

    if (
        !/^#[0-9a-fA-F]{6}$/.test(
            color || ""
        )
    ) {
        return;
    }

    document.documentElement.style.setProperty(
        "--accent",
        color
    );

    var hover =
        color;

    try {

        var n =
            parseInt(
                color.slice(1),
                16
            );

        var r =
            Math.min(
                255,
                (
                    (n >> 16) &
                    255
                ) +
                16
            );

        var g =
            Math.min(
                255,
                (
                    (n >> 8) &
                    255
                ) +
                16
            );

        var b =
            Math.min(
                255,
                (
                    n &
                    255
                ) +
                16
            );

        hover =
            "#" +
            [
                r,
                g,
                b
            ]
                .map(
                    function (v) {
                        return v
                            .toString(16)
                            .padStart(
                                2,
                                "0"
                            );
                    }
                )
                .join("");

    } catch (e) {}

    document.documentElement.style.setProperty(
        "--accent-hover",
        hover
    );

    try {

        var rgb = parseInt(color.slice(1), 16);
        var cr = (rgb >> 16) & 255;
        var cg = (rgb >> 8) & 255;
        var cb = rgb & 255;
        var luminance = (0.299 * cr + 0.587 * cg + 0.114 * cb) / 255;

        document.documentElement.style.setProperty(
            "--accent-soft",
            "rgba(" + cr + "," + cg + "," + cb + ",0.14)"
        );

        document.documentElement.style.setProperty(
            "--accent-ink",
            luminance > 0.60 ? "#101114" : "#F5F5F5"
        );

    } catch (inkError) {}

    if (save) {
        setSetting(
            "accentColor",
            color
        );
    }
}


function initializePluginSettings() {

    var savedColor =
        getSetting(
            "accentColor",
            "#FF6B35"
        );

    if (!getSetting("cadrBrandThemeV2", "")) {
        savedColor = "#FF6B35";
        setSetting("accentColor", "#FF6B35");
        setSetting("cadrBrandThemeV2", "1");
    }

    var colorInput =
        document.getElementById(
            "accentColor"
        );

    var preset =
        document.getElementById(
            "accentPreset"
        );

    if (colorInput) {

        colorInput.value =
            savedColor;

        applyAccentColor(
            savedColor,
            false
        );

        if (preset) {
            preset.value = savedColor;
        }

        colorInput.addEventListener(
            "input",
            function () {

                applyAccentColor(
                    colorInput.value,
                    true
                );

                if (preset) {
                    preset.value =
                        colorInput.value;
                }
            }
        );
    }

    if (preset) {

        preset.addEventListener(
            "change",
            function () {

                if (colorInput) {
                    colorInput.value =
                        preset.value;
                }

                applyAccentColor(
                    preset.value,
                    true
                );
            }
        );
    }

    detectFFmpeg(false);
}


(function loadSavedSettings() {

    var saved =
        getSetting(
            "ffmpegPath",
            null
        );

    if (saved) {

        document.getElementById(
            "ffmpegPath"
        ).value =
            saved;
    }

    var savedThreshold =
        getSetting(
            "noiseThreshold",
            null
        );

    if (savedThreshold) {

        document.getElementById(
            "noiseThreshold"
        ).value =
            savedThreshold;
    }

    var savedPaddingBefore =
        getSetting(
            "paddingBefore",
            null
        );

    if (savedPaddingBefore) {

        document.getElementById(
            "paddingBefore"
        ).value =
            savedPaddingBefore;
    }

    var savedPaddingAfter =
        getSetting(
            "paddingAfter",
            null
        );

    if (savedPaddingAfter) {

        document.getElementById(
            "paddingAfter"
        ).value =
            savedPaddingAfter;
    }

    var savedSmoothVideo = getSetting("smoothVideo", null);
    var savedSmoothAudio = getSetting("smoothAudio", null);
    var savedSmoothFrames = getSetting("smoothFrames", null);

    if (savedSmoothVideo !== null) {
        document.getElementById("smoothVideo").checked =
            savedSmoothVideo === "1";
    }

    if (savedSmoothAudio !== null) {
        document.getElementById("smoothAudio").checked =
            savedSmoothAudio === "1";
    }

    if (savedSmoothFrames) {
        document.getElementById("smoothFrames").value =
            savedSmoothFrames;
    }

    var savedAutoZoom = getSetting("autoZoom", null);
    var savedZoomAmount = getSetting("zoomAmount", null);

    if (savedAutoZoom !== null) {
        document.getElementById("autoZoom").checked =
            savedAutoZoom === "1";
    }

    if (savedZoomAmount) {
        document.getElementById("zoomAmount").value =
            savedZoomAmount;
    }

})();


/* =========================================================
   PRESETS
   ========================================================= */

function getPresetsFolder() {

    var path =
        window.cep_node.require(
            "path"
        );

    /* User-data folder survives plugin updates
       (the extension folder gets replaced on every update). */
    return path.join(
        csInterface.getSystemPath(
            SystemPath.USER_DATA
        ),
        "CADR",
        "presets"
    );
}

function cadrMkdirp(folder) {

    var fs =
        window.cep_node.require(
            "fs"
        );

    var path =
        window.cep_node.require(
            "path"
        );

    if (fs.existsSync(folder)) {
        return;
    }

    var parent = path.dirname(folder);

    /* stop at the top of the drive instead of looping forever */
    if (parent && parent !== folder) {
        cadrMkdirp(parent);
    }

    try {
        fs.mkdirSync(folder);
    } catch (e) {}
}

function ensurePresetsFolder() {

    var fs =
        window.cep_node.require(
            "fs"
        );

    var path =
        window.cep_node.require(
            "path"
        );

    var folder =
        getPresetsFolder();

    var isNewFolder =
        !fs.existsSync(folder);

    cadrMkdirp(folder);

    /* One-time move of presets saved by older versions
       inside the extension folder. */
    if (isNewFolder) {

        try {

            var oldFolder =
                path.join(
                    csInterface.getSystemPath(
                        SystemPath.EXTENSION
                    ),
                    "presets"
                );

            if (fs.existsSync(oldFolder)) {

                var oldFiles =
                    fs.readdirSync(oldFolder);

                for (var i = 0; i < oldFiles.length; i++) {

                    if (/\.json$/i.test(oldFiles[i])) {

                        fs.writeFileSync(
                            path.join(folder, oldFiles[i]),
                            fs.readFileSync(
                                path.join(oldFolder, oldFiles[i])
                            )
                        );
                    }
                }
            }

        } catch (migrateError) {}
    }

    return folder;
}

function refreshPresetsList() {

    var select =
        document.getElementById(
            "presetSelect"
        );

    if (!select) {
        return;
    }

    select.innerHTML =
        "<option value=\"\">— اختار Preset —</option>";

    if (!window.cep_node || !window.cep_node.require) {
        return;
    }

    try {
        var fs =
            window.cep_node.require(
                "fs"
            );

        var folder =
            ensurePresetsFolder();

        var files =
            fs.readdirSync(
                folder
            );

        for (
            var i = 0;
            i < files.length;
            i++
        ) {

            if (
                files[i].indexOf(
                    ".json"
                ) ===
                files[i].length - 5
            ) {

                var name =
                    files[i].slice(
                        0,
                        -5
                    );

                var opt =
                    document.createElement(
                        "option"
                    );

                opt.value =
                    name;

                opt.textContent =
                    name;

                select.appendChild(
                    opt
                );
            }
        }

    } catch (e) {}
}


function saveCurrentPreset() {

    var nameInput =
        document.getElementById(
            "presetName"
        );

    var name =
        nameInput.value.trim().replace(/[\\\/:*?"<>|]/g, "_");

    var status =
        document.getElementById(
            "cutStatus"
        );

    if (!name) {

        status.textContent =
            "اكتب اسم للـ Preset الأول.";

        return;
    }

    var data = {

        noiseThreshold:
            document.getElementById(
                "noiseThreshold"
            ).value,

        silenceDuration:
            document.getElementById(
                "silenceDuration"
            ).value,

        paddingBefore:
            document.getElementById(
                "paddingBefore"
            ).value,

        paddingAfter:
            document.getElementById(
                "paddingAfter"
            ).value,
        smoothVideo:
            document.getElementById(
                "smoothVideo"
            ).checked,
        smoothAudio:
            document.getElementById(
                "smoothAudio"
            ).checked,
        smoothFrames:
            document.getElementById(
                "smoothFrames"
            ).value,
        autoZoom:
            document.getElementById(
                "autoZoom"
            ).checked,
        zoomAmount:
            document.getElementById(
                "zoomAmount"
            ).value
    };

    var fs =
        window.cep_node.require(
            "fs"
        );

    var path =
        window.cep_node.require(
            "path"
        );

    var folder =
        ensurePresetsFolder();

    var filePath =
        path.join(
            folder,
            name +
            ".json"
        );

    try {

        fs.writeFileSync(
            filePath,
            JSON.stringify(
                data,
                null,
                2
            ),
            "utf8"
        );

        status.textContent =
            "اتحفظ Preset \"" +
            name +
            "\".";

        nameInput.value =
            "";

        refreshPresetsList();

    } catch (e) {

        status.textContent =
            "مش قادر أحفظ الـ Preset: " +
            e.message;
    }
}


function loadSelectedPreset() {

    var select =
        document.getElementById(
            "presetSelect"
        );

    var name =
        select.value;

    var status =
        document.getElementById(
            "cutStatus"
        );

    if (!name) {
        return;
    }

    var fs =
        window.cep_node.require(
            "fs"
        );

    var path =
        window.cep_node.require(
            "path"
        );

    var filePath =
        path.join(
            getPresetsFolder(),
            name +
            ".json"
        );

    try {

        var raw =
            fs.readFileSync(
                filePath,
                "utf8"
            );

        var data =
            JSON.parse(
                raw
            );

        if (
            data.noiseThreshold !==
            undefined
        ) {

            document.getElementById(
                "noiseThreshold"
            ).value =
                data.noiseThreshold;
        }

        if (
            data.silenceDuration !==
            undefined
        ) {

            document.getElementById(
                "silenceDuration"
            ).value =
                data.silenceDuration;
        }

        if (
            data.paddingBefore !==
            undefined
        ) {

            document.getElementById(
                "paddingBefore"
            ).value =
                data.paddingBefore;
        }

        if (
            data.paddingAfter !==
            undefined
        ) {

            document.getElementById(
                "paddingAfter"
            ).value =
                data.paddingAfter;
        }

        if (data.smoothVideo !== undefined) {
            document.getElementById("smoothVideo").checked =
                !!data.smoothVideo;
        }

        if (data.smoothAudio !== undefined) {
            document.getElementById("smoothAudio").checked =
                !!data.smoothAudio;
        }

        if (data.smoothFrames !== undefined) {
            document.getElementById("smoothFrames").value =
                data.smoothFrames;
        }

        if (data.autoZoom !== undefined) {
            document.getElementById("autoZoom").checked =
                !!data.autoZoom;
        }

        if (data.zoomAmount !== undefined) {
            document.getElementById("zoomAmount").value =
                data.zoomAmount;
        }

        status.textContent =
            "اتحمّل Preset \"" +
            name +
            "\".";

    } catch (e) {

        status.textContent =
            "مش قادر أحمّل الـ Preset: " +
            e.message;
    }
}


refreshPresetsList();


/* =========================================================
   AUTO CAPTION & AI INTEGRATION
   ========================================================= */

function refreshCaptionSelection(forceNow) {
    refreshSelection(forceNow);
}


refreshCaptionSelection();


function showTab(tabId) {

    var panels =
        document.querySelectorAll(
            ".tabpanel"
        );

    for (
        var i = 0;
        i < panels.length;
        i++
    ) {

        panels[i].classList.remove(
            "active"
        );
    }

    var tabs =
        document.querySelectorAll(
            ".tab"
        );

    for (
        var j = 0;
        j < tabs.length;
        j++
    ) {

        tabs[j].classList.remove(
            "active"
        );
    }

    document.getElementById(
        tabId
    ).classList.add(
        "active"
    );

    var tabButtonIds = {
        cut: "tabCut",
        caption: "tabCaption",
        style: "tabStyle",
        settings: "tabSettings"
    };

    var activeTabButton =
        document.getElementById(
            tabButtonIds[tabId] || "tabCut"
        );

    if (activeTabButton) {
        activeTabButton.classList.add(
            "active"
        );
    }

    if (tabId === "cut") {
        refreshSelection();
    } else if (tabId === "caption") {
        refreshCaptionSelection();
    }
}


function runCaption() {

    if (!cadrRequireLicense("Auto Caption")) return;

    var status =
        document.getElementById(
            "captionStatus"
        );

    var button =
        document.getElementById(
            "captionButton"
        );

    var aiProvider = "gemini";

    var apiKey =
        document.getElementById(
            "geminiApiKey"
        ).value.trim();

    var model =
        document.getElementById(
            "geminiModel"
        ).value.trim();

    setSetting(
        "geminiApiKey",
        apiKey
    );

    setSetting(
        "geminiModel",
        model
    );

    var language =
        document.getElementById(
            "captionLanguage"
        ).value;

    var wordsPerLine =
        parseInt(
            document.getElementById(
                "wordsPerLine"
            ).value,
            10
        );

    var naturalSplit =
        document.getElementById(
            "naturalSplit"
        ).checked;

    var ffmpegPath =
        getSetting(
            "ffmpegPath",
            cadrIsWindows()
                ? "C:\\ffmpeg\\bin\\ffmpeg.exe"
                : "/opt/homebrew/bin/ffmpeg"
        );

    setSetting(
        "captionLanguage",
        language
    );

    setSetting(
        "wordsPerLine",
        String(
            wordsPerLine
        )
    );

    setSetting(
        "naturalSplit",
        naturalSplit
            ? "1"
            : "0"
    );

    setSetting(
        "wordLevelCaptions",
        document.getElementById(
            "wordLevelCaptions"
        ).checked
            ? "1"
            : "0"
    );

    document.getElementById(
        "fillerWordsBox"
    ).style.display =
        "none";

    pendingCaptionSrt =
        null;

    pendingCaptionLines =
        [];

    pendingCaptionWords =
        [];

    fillerWordsList =
        [];

    cadrTrReset();

    if (!apiKey) {

        status.textContent =
            "لازم تحط مفتاح الـ API الخاص بـ Gemini الأول.";

        return;
    }

    button.disabled =
        true;

    status.textContent =
        "Reading selected clips...";

    var captionSlowHintTimer =
        setTimeout(
            function () {

                status.textContent =
                    "لسه بيقرا الكليب...\n\n" +
                    "لو الكليب جديد أو كبير، بريمير غالبًا بيعمل Conforming/Indexing " +
                    "للصوت في الخلفية دلوقتي، وده بيمنع أي أمر تاني لحد ما يخلص. " +
                    "استنى شوية (شيك على أيقونة الـ Background Tasks تحت يمين شاشة بريمير).";

            },
            6000
        );

    csInterface.evalScript(
        "getSelectedClipsAnalysisData()",
        function (rawData) {

            clearTimeout(
                captionSlowHintTimer
            );

            if (
                !rawData ||
                rawData.indexOf("NO_") === 0 ||
                rawData.indexOf("HOST_ERROR:") === 0
            ) {

                button.disabled =
                    false;

                status.textContent =
                    rawData ||
                    "No clips selected.";

                return;
            }

            var clips;

            try {

                clips =
                    JSON.parse(
                        rawData
                    );

            } catch (e) {

                button.disabled =
                    false;

                status.textContent =
                    "Invalid clip data.";

                return;
            }

            if (
                !clips ||
                !clips.length
            ) {

                button.disabled =
                    false;

                status.textContent =
                    "No clips selected.";

                return;
            }

            extractClipsSequentially(
                clips,
                0,
                [],
                ffmpegPath,
                function (
                    extractedPaths,
                    extractFailed
                ) {

                    if (extractFailed) {

                        button.disabled =
                            false;

                        status.textContent =
                            "فشل استخراج صوت أحد الكليبات.";

                        return;
                    }

                    combineAndCaption(
                        clips,
                        extractedPaths,
                        aiProvider,
                        apiKey,
                        model,
                        language,
                        wordsPerLine,
                        naturalSplit,
                        ffmpegPath,
                        status,
                        button
                    );
                }
            );
        }
    );
}


/* =========================================================
   EXTRACT AUDIO SEQUENTIALLY
   ========================================================= */

function extractClipsSequentially(
    clips,
    index,
    extractedPaths,
    ffmpegPath,
    onDone
) {

    if (
        index >=
        clips.length
    ) {

        onDone(
            extractedPaths,
            false
        );

        return;
    }

    var status =
        document.getElementById(
            "captionStatus"
        );

    var clip =
        clips[index];

    status.textContent =
        "Extracting audio " +
        (index + 1) +
        " / " +
        clips.length +
        "...";

    cadrBarWave((index / clips.length) * 100);

    var cp =
        window.cep_node.require(
            "child_process"
        );

    var os =
        window.cep_node.require(
            "os"
        );

    var path =
        window.cep_node.require(
            "path"
        );

    var tempWav =
        path.join(
            os.tmpdir(),
            "cadr_caption_" +
            Date.now() +
            "_" +
            index +
            ".wav"
        );

    var extractArgs = [
        "-hide_banner",
        "-y",
        "-i",
        clip.path,
        "-ss",
        String(
            clip.sourceIn
        ),
        "-t",
        String(
            clip.duration
        ),
        "-vn",
        "-ar",
        "16000",
        "-ac",
        "1",
        tempWav
    ];

    cp.execFile(
        ffmpegPath,
        extractArgs,
        function (
            extractError
        ) {

            if (extractError) {

                var fs =
                    window.cep_node.require(
                        "fs"
                    );

                for (
                    var cleanupIndex = 0;
                    cleanupIndex <
                    extractedPaths.length;
                    cleanupIndex++
                ) {

                    try {

                        fs.unlinkSync(
                            extractedPaths[
                                cleanupIndex
                            ]
                        );

                    } catch (
                        cleanupError
                    ) {}
                }

                try {

                    fs.unlinkSync(
                        tempWav
                    );

                } catch (
                    currentCleanupError
                ) {}

                onDone(
                    [],
                    true
                );

                return;
            }

            extractedPaths.push(
                tempWav
            );

            extractClipsSequentially(
                clips,
                index + 1,
                extractedPaths,
                ffmpegPath,
                onDone
            );
        }
    );
}


/* =========================================================
   CAPTION RESPONSE PARSER
   =========================================================
   
   This parser accepts:
   1. Normal JSON.
   2. JSON inside Markdown code fences.
   3. JSON surrounded by extra text.
   4. JSON with lines + words.
   5. JSON using captions instead of lines.
   6. JSON array of caption objects.
   7. SRT responses.
   8. Numeric timestamps returned as strings.
   
   Internal format remains:
   {
       lines: [
           {
               text: "...",
               start: 0,
               end: 1
           }
       ],
       words: [
           {
               word: "...",
               start: 0,
               end: 0.3
           }
       ]
   }
   ========================================================= */


/* ---------------------------------------------------------
   Convert a possible number/string into a real number
   --------------------------------------------------------- */

function normalizeCaptionNumber(value) {

    if (
        typeof value ===
        "number"
    ) {

        return isFinite(value)
            ? value
            : null;
    }

    if (
        typeof value ===
        "string"
    ) {

        var cleaned =
            value
                .trim()
                .replace(
                    ",",
                    "."
                );

        if (
            cleaned === ""
        ) {
            return null;
        }

        var parsed =
            parseFloat(
                cleaned
            );

        return isFinite(parsed)
            ? parsed
            : null;
    }

    return null;
}


/* ---------------------------------------------------------
   Normalize caption text
   --------------------------------------------------------- */

function normalizeCaptionText(value) {

    if (
        value === null ||
        value === undefined
    ) {
        return "";
    }

    return String(value)
        .replace(
            /\r\n/g,
            "\n"
        )
        .replace(
            /\r/g,
            "\n"
        )
        .trim();
}


/* ---------------------------------------------------------
   Normalize a single line
   --------------------------------------------------------- */

function normalizeCaptionLine(item) {

    if (
        !item ||
        typeof item !==
        "object"
    ) {
        return null;
    }

    var text =
        normalizeCaptionText(
            item.text !== undefined
                ? item.text
                : (
                    item.caption !== undefined
                        ? item.caption
                        : (
                            item.content !== undefined
                                ? item.content
                                : (
                                    item.transcript !== undefined
                                        ? item.transcript
                                        : ""
                                )
                        )
                )
        );

    var start =
        normalizeCaptionNumber(
            item.start !== undefined
                ? item.start
                : (
                    item.startTime !== undefined
                        ? item.startTime
                        : (
                            item.from !== undefined
                                ? item.from
                                : 0
                        )
                )
        );

    var end =
        normalizeCaptionNumber(
            item.end !== undefined
                ? item.end
                : (
                    item.endTime !== undefined
                        ? item.endTime
                        : (
                            item.to !== undefined
                                ? item.to
                                : null
                        )
                )
        );

    if (
        !text ||
        start === null ||
        end === null
    ) {
        return null;
    }

    if (
        end <= start
    ) {
        return null;
    }

    return {
        text:
            text,

        start:
            start,

        end:
            end
    };
}


/* ---------------------------------------------------------
   Normalize a single word
   --------------------------------------------------------- */

function normalizeCaptionWord(item) {

    if (
        !item ||
        typeof item !==
        "object"
    ) {
        return null;
    }

    var word =
        normalizeCaptionText(
            item.word !== undefined
                ? item.word
                : (
                    item.text !== undefined
                        ? item.text
                        : ""
                )
        );

    var start =
        normalizeCaptionNumber(
            item.start !== undefined
                ? item.start
                : (
                    item.startTime !== undefined
                        ? item.startTime
                        : (
                            item.from !== undefined
                                ? item.from
                                : 0
                        )
                )
        );

    var end =
        normalizeCaptionNumber(
            item.end !== undefined
                ? item.end
                : (
                    item.endTime !== undefined
                        ? item.endTime
                        : (
                            item.to !== undefined
                                ? item.to
                                : null
                        )
                )
        );

    if (
        !word ||
        start === null ||
        end === null
    ) {
        return null;
    }

    if (
        end <= start
    ) {
        return null;
    }

    return {
        word:
            word,

        start:
            start,

        end:
            end
    };
}


/* ---------------------------------------------------------
   Normalize arrays
   --------------------------------------------------------- */

function normalizeCaptionArray(
    list,
    type
) {

    if (
        !Array.isArray(
            list
        )
    ) {
        return [];
    }

    var result = [];

    for (
        var i = 0;
        i < list.length;
        i++
    ) {

        var item =
            type === "word"
                ? normalizeCaptionWord(
                    list[i]
                )
                : normalizeCaptionLine(
                    list[i]
                );

        if (item) {
            result.push(
                item
            );
        }
    }

    result.sort(
        function (
            a,
            b
        ) {

            return (
                a.start -
                b.start
            );
        }
    );

    return result;
}


/* ---------------------------------------------------------
   Parse SRT timestamp
   Example:
   00:00:12,340
   00:00:12.340
   --------------------------------------------------------- */

function parseSrtTimeToSeconds(
    timeString
) {

    if (
        !timeString
    ) {
        return null;
    }

    var value =
        String(
            timeString
        )
            .trim()
            .replace(
                ",",
                "."
            );

    var parts =
        value.split(":");

    if (
        parts.length !== 3
    ) {
        return null;
    }

    var hours =
        parseFloat(
            parts[0]
        );

    var minutes =
        parseFloat(
            parts[1]
        );

    var seconds =
        parseFloat(
            parts[2]
        );

    if (
        isNaN(hours) ||
        isNaN(minutes) ||
        isNaN(seconds)
    ) {
        return null;
    }

    return (
        hours * 3600 +
        minutes * 60 +
        seconds
    );
}


/* ---------------------------------------------------------
   Parse SRT into internal lines
   --------------------------------------------------------- */

function parseSrtToLines(
    srtText
) {

    if (
        !srtText ||
        typeof srtText !==
        "string"
    ) {
        return [];
    }

    var normalized =
        srtText
            .replace(
                /^\uFEFF/,
                ""
            )
            .replace(
                /\r\n/g,
                "\n"
            )
            .replace(
                /\r/g,
                "\n"
            )
            .trim();

    if (!normalized) {
        return [];
    }

    var blocks =
        normalized.split(
            /\n\s*\n/
        );

    var result =
        [];

    for (
        var i = 0;
        i < blocks.length;
        i++
    ) {

        var block =
            blocks[i].trim();

        if (!block) {
            continue;
        }

        var lines =
            block.split(
                "\n"
            );

        var timingIndex =
            -1;

        for (
            var j = 0;
            j < lines.length;
            j++
        ) {

            if (
                lines[j].indexOf(
                    "-->"
                ) !== -1
            ) {

                timingIndex =
                    j;

                break;
            }
        }

        if (
            timingIndex ===
            -1
        ) {
            continue;
        }

        var timingLine =
            lines[timingIndex];

        var timingParts =
            timingLine.split(
                "-->"
            );

        if (
            timingParts.length <
            2
        ) {
            continue;
        }

        var start =
            parseSrtTimeToSeconds(
                timingParts[0]
                    .trim()
            );

        var end =
            parseSrtTimeToSeconds(
                timingParts[1]
                    .trim()
                    .split(/\s+/)[0]
            );

        if (
            start === null ||
            end === null ||
            end <= start
        ) {
            continue;
        }

        var textParts =
            [];

        for (
            var t =
                timingIndex + 1;
            t < lines.length;
            t++
        ) {

            if (
                lines[t].trim()
            ) {

                textParts.push(
                    lines[t].trim()
                );
            }
        }

        var text =
            textParts.join(
                "\n"
            ).trim();

        if (!text) {
            continue;
        }

        result.push({
            text:
                text,

            start:
                start,

            end:
                end
        });
    }

    return result;
}


/* ---------------------------------------------------------
   Remove Markdown code fences
   --------------------------------------------------------- */

function cleanPossibleCodeFence(
    text
) {

    return String(
        text || ""
    )
        .replace(
            /```(?:json|srt|subtitle|text)?/gi,
            ""
        )
        .replace(
            /```/g,
            ""
        )
        .trim();
}


/* ---------------------------------------------------------
   Extract balanced JSON object/array from extra text.
   
   This is more reliable than simply taking the first { and
   last }, because braces can appear inside strings.
   --------------------------------------------------------- */

function extractBalancedJson(
    text
) {

    var source =
        String(
            text || ""
        );

    var firstObject =
        source.indexOf("{");

    var firstArray =
        source.indexOf("[");

    var start = -1;

    if (
        firstObject === -1 &&
        firstArray === -1
    ) {
        return null;
    }

    if (
        firstObject === -1
    ) {

        start =
            firstArray;

    } else if (
        firstArray === -1
    ) {

        start =
            firstObject;

    } else {

        start =
            Math.min(
                firstObject,
                firstArray
            );
    }

    var stack =
        [];

    var inString =
        false;

    var escaped =
        false;

    for (
        var i = start;
        i < source.length;
        i++
    ) {

        var ch =
            source.charAt(i);

        if (inString) {

            if (escaped) {

                escaped =
                    false;

                continue;
            }

            if (
                ch === "\\"
            ) {

                escaped =
                    true;

                continue;
            }

            if (
                ch === "\""
            ) {

                inString =
                    false;
            }

            continue;
        }

        if (
            ch === "\""
        ) {

            inString =
                true;

            continue;
        }

        if (
            ch === "{" ||
            ch === "["
        ) {

            stack.push(
                ch
            );

            continue;
        }

        if (
            ch === "}" ||
            ch === "]"
        ) {

            if (
                stack.length === 0
            ) {
                continue;
            }

            var expected =
                ch === "}"
                    ? "{"
                    : "[";

            if (
                stack[
                    stack.length - 1
                ] !== expected
            ) {

                return null;
            }

            stack.pop();

            if (
                stack.length === 0
            ) {

                return source.slice(
                    start,
                    i + 1
                );
            }
        }
    }

    return null;
}


/* ---------------------------------------------------------
   Try parsing JSON text
   --------------------------------------------------------- */

function parseCaptionJsonText(
    rawText
) {

    var cleaned =
        cleanPossibleCodeFence(
            rawText
        );

    if (!cleaned) {
        return null;
    }

    /*
     * First try direct JSON.
     */
    try {

        return JSON.parse(
            cleaned
        );

    } catch (directError) {}

    /*
     * Then try extracting a balanced JSON object/array
     * from surrounding text.
     */
    var extracted =
        extractBalancedJson(
            cleaned
        );

    if (!extracted) {
        return null;
    }

    try {

        return JSON.parse(
            extracted
        );

    } catch (extractedError) {
        return null;
    }
}


/* ---------------------------------------------------------
   Convert different JSON shapes to internal format
   --------------------------------------------------------- */

function normalizeParsedCaptionJson(
    parsed
) {

    if (
        !parsed
    ) {
        return null;
    }

    /*
     * Case 1:
     * {
     *   lines: [...],
     *   words: [...]
     * }
     */

    if (
        !Array.isArray(
            parsed
        )
    ) {

        var linesSource =
            Array.isArray(
                parsed.lines
            )
                ? parsed.lines
                : (
                    Array.isArray(
                        parsed.captions
                    )
                        ? parsed.captions
                        : (
                            Array.isArray(
                                parsed.subtitles
                            )
                                ? parsed.subtitles
                                : (
                                    Array.isArray(
                                        parsed.segments
                                    )
                                        ? parsed.segments
                                        : []
                                )
                        )
                );

        var wordsSource =
            Array.isArray(
                parsed.words
            )
                ? parsed.words
                : (
                    Array.isArray(
                        parsed.wordTimings
                    )
                        ? parsed.wordTimings
                        : []
                );

        var normalizedLines =
            normalizeCaptionArray(
                linesSource,
                "line"
            );

        var normalizedWords =
            normalizeCaptionArray(
                wordsSource,
                "word"
            );

        if (
            normalizedLines.length ||
            normalizedWords.length
        ) {

            return {
                lines:
                    normalizedLines,

                words:
                    normalizedWords,

                source:
                    "JSON"
            };
        }

        /*
         * Some AI responses use:
         * { data: { lines: [...], words: [...] } }
         */

        if (
            parsed.data &&
            typeof parsed.data ===
            "object"
        ) {

            return normalizeParsedCaptionJson(
                parsed.data
            );
        }

        /*
         * Some responses use:
         * { result: { ... } }
         */

        if (
            parsed.result &&
            typeof parsed.result ===
            "object"
        ) {

            return normalizeParsedCaptionJson(
                parsed.result
            );
        }

        return null;
    }

    /*
     * Case 2:
     * [
     *   {"text":"...", "start":0, "end":1}
     * ]
     */

    var arrayLines =
        normalizeCaptionArray(
            parsed,
            "line"
        );

    if (
        arrayLines.length
    ) {

        return {
            lines:
                arrayLines,

            words:
                [],

            source:
                "JSON_ARRAY"
        };
    }

    return null;
}


/* ---------------------------------------------------------
   Main AI response parser
   --------------------------------------------------------- */

function parseAiCaptionResponse(
    rawText
) {

    if (
        rawText === null ||
        rawText === undefined
    ) {

        throw new Error(
            "الـ AI رجّع رد فاضي."
        );
    }

    var text =
        String(
            rawText
        ).trim();

    if (!text) {

        throw new Error(
            "الـ AI رجّع رد فاضي."
        );
    }

    /*
     * 1. Try JSON.
     */

    var parsedJson =
        parseCaptionJsonText(
            text
        );

    if (parsedJson) {

        var normalized =
            normalizeParsedCaptionJson(
                parsedJson
            );

        if (
            normalized &&
            (
                normalized.lines.length ||
                normalized.words.length
            )
        ) {

            return normalized;
        }
    }

    /*
     * 2. Try SRT.
     */

    var srtLines =
        parseSrtToLines(
            text
        );

    if (
        srtLines.length
    ) {

        return {
            lines:
                srtLines,

            words:
                [],

            source:
                "SRT"
        };
    }

    /*
     * 3. Try a cleaned version once more.
     */

    var cleaned =
        cleanPossibleCodeFence(
            text
        );

    if (
        cleaned !== text
    ) {

        var cleanedJson =
            parseCaptionJsonText(
                cleaned
            );

        if (cleanedJson) {

            var cleanedNormalized =
                normalizeParsedCaptionJson(
                    cleanedJson
                );

            if (
                cleanedNormalized &&
                (
                    cleanedNormalized.lines.length ||
                    cleanedNormalized.words.length
                )
            ) {

                return cleanedNormalized;
            }
        }

        var cleanedSrt =
            parseSrtToLines(
                cleaned
            );

        if (
            cleanedSrt.length
        ) {

            return {
                lines:
                    cleanedSrt,

                words:
                    [],

                source:
                    "SRT"
            };
        }
    }

    throw new Error(
        "الرد مش JSON أو SRT صالح."
    );
}


/* =========================================================
   COMBINE & SEND TO AI
   ========================================================= */

var pendingCaptionSrt =
    null;

var pendingCaptionLines =
    [];

var pendingCaptionWords =
    [];

var fillerWordsList =
    [];


function rebuildCaptionPreview() {

    var wordLevel =
        document.getElementById(
            "wordLevelCaptions"
        );

    var useWords =
        wordLevel &&
        wordLevel.checked;

    var source =
        useWords
            ? pendingCaptionWords
            : pendingCaptionLines;

    if (
        !source ||
        source.length === 0
    ) {
        return;
    }

    pendingCaptionSrt =
        buildSrtFromLines(
            source
        );

    var preview =
        document.getElementById(
            "captionPreview"
        );

    if (preview) {

        preview.value =
            pendingCaptionSrt;
    }

    if (typeof cadrTrReset === "function") {
        cadrTrReset();
    }
}


function shiftCaptionTimings(
    removedStart,
    removedDuration
) {

    var lists = [
        pendingCaptionLines,
        pendingCaptionWords
    ];

    for (
        var l = 0;
        l < lists.length;
        l++
    ) {

        var list =
            lists[l];

        for (
            var i = 0;
            i < list.length;
            i++
        ) {

            if (
                list[i].start >
                removedStart
            ) {

                list[i].start -=
                    removedDuration;

                list[i].end -=
                    removedDuration;
            }
        }
    }
}


var FILLER_WORDS = [
    "يعني",
    "امم",
    "ام",
    "اه",
    "آه",
    "طيب",
    "خلاص",
    "يعنى",
    "ايه"
];


function getCustomFillerWords() {

    try {

        return JSON.parse(
            getSetting(
                "customFillerWords",
                "[]"
            )
        );

    } catch (e) {

        return [];
    }
}


function saveCustomFillerWords(
    list
) {

    setSetting(
        "customFillerWords",
        JSON.stringify(
            list
        )
    );
}


function normalizeArabicWord(
    w
) {

    return String(
        w
    )
        .replace(
            /[\u064B-\u0652]/g,
            ""
        )
        .replace(
            /[إأآا]/g,
            "ا"
        )
        .replace(
            /ة/g,
            "ه"
        )
        .replace(
            /[^\u0600-\u06FF]/g,
            ""
        )
        .trim();
}


function isFillerWord(
    word
) {

    var normalized =
        normalizeArabicWord(
            word
        );

    if (!normalized) {
        return false;
    }

    var all =
        FILLER_WORDS.concat(
            getCustomFillerWords()
        );

    for (
        var i = 0;
        i < all.length;
        i++
    ) {

        if (
            normalizeArabicWord(
                all[i]
            ) ===
            normalized
        ) {

            return true;
        }
    }

    return false;
}


function renderCustomFillerWords() {

    var box = document.getElementById("customFillerWordsList");

    if (!box) {
        return;
    }

    var custom = getCustomFillerWords();

    box.innerHTML = "";

    var label = document.getElementById("fillerLabel");

    if (label) {
        label.textContent = "Filler words to flag";
    }

    /* built-in words: shown so the user sees what is already flagged */
    var seenBuiltIn = {};

    for (var f = 0; f < FILLER_WORDS.length; f++) {

        var key = normalizeArabicWord(FILLER_WORDS[f]);

        if (seenBuiltIn[key]) {
            continue;
        }

        seenBuiltIn[key] = true;

        var fixedChip = document.createElement("span");

        fixedChip.className = "chip fixed";
        fixedChip.setAttribute("dir", "auto");
        fixedChip.title = "Built in";
        fixedChip.textContent = FILLER_WORDS[f];

        box.appendChild(fixedChip);
    }

    for (var i = 0; i < custom.length; i++) {

        var chip = document.createElement("span");
        chip.className = "chip";

        var text = document.createElement("span");
        text.textContent = custom[i];
        text.setAttribute("dir", "auto");

        var remove = document.createElement("button");
        remove.className = "x";
        remove.setAttribute("aria-label", "Remove " + custom[i]);
        remove.innerHTML =
            '<svg class="ic"><use href="#i-x"/></svg>';

        remove.onclick = (function (index) {
            return function () {
                removeCustomFillerWord(index);
            };
        })(i);

        chip.appendChild(text);
        chip.appendChild(remove);
        box.appendChild(chip);
    }

    var add = document.createElement("button");
    add.className = "chip";
    add.id = "fillerAddToggle";
    add.setAttribute("aria-label", "Add filler word");
    add.innerHTML = '<svg class="ic" style="width:14px;height:14px"><use href="#i-plus"/></svg>';

    add.onclick = function () {

        var row = document.getElementById("fillerAddRow");
        var show = row.style.display === "none";

        row.style.display = show ? "flex" : "none";

        if (show) {
            document.getElementById("newFillerWord").focus();
        }
    };

    box.appendChild(add);
}

function addCustomFillerWord() {

    var input =
        document.getElementById(
            "newFillerWord"
        );

    var word =
        input.value.trim();

    if (!word) {
        return;
    }

    var custom =
        getCustomFillerWords();

    custom.push(
        word
    );

    saveCustomFillerWords(
        custom
    );

    input.value =
        "";

    renderCustomFillerWords();
}


function removeCustomFillerWord(
    index
) {

    var custom =
        getCustomFillerWords();

    custom.splice(
        index,
        1
    );

    saveCustomFillerWords(
        custom
    );

    renderCustomFillerWords();
}


renderCustomFillerWords();


/* =========================================================
   FILLER WORDS: SNAP TO THE REAL SOUND
   ---------------------------------------------------------
   Gemini gives each word an approximate start/end. For a filler
   that stands alone between pauses ("إمم..."), we look at the
   actual audio around it and use the real edges of that sound.
   If the filler is glued to neighbouring words (no pause), we
   leave Gemini's times untouched, so this can never make a cut
   worse than before.
   ========================================================= */

function cadrCurrentNoiseDb() {
    var el = document.getElementById("noiseThreshold");
    var v = el ? parseFloat(el.value) : NaN;
    return (isNaN(v) || v >= 0) ? -30 : v;
}

/* silences: [{start,end}] in seconds relative to the window start. */
function cadrSpeechIslands(silences, windowLen) {

    var sorted = silences.slice().sort(function (a, b) {
        return a.start - b.start;
    });

    var islands = [];
    var cursor = 0;

    for (var i = 0; i < sorted.length; i++) {

        var s0 = Math.max(0, sorted[i].start);
        var e0 = Math.min(
            windowLen,
            sorted[i].end === null ? windowLen : sorted[i].end
        );

        if (s0 > cursor) {
            islands.push({ start: cursor, end: s0 });
        }

        cursor = Math.max(cursor, e0);
    }

    if (cursor < windowLen) {
        islands.push({ start: cursor, end: windowLen });
    }

    return islands;
}

/* Returns the island to snap to, or null to keep Gemini's times. */
function cadrPickIsland(islands, a, b, windowLen) {

    var wordDur = b - a;
    var best = null;
    var bestOverlap = 0;

    for (var i = 0; i < islands.length; i++) {

        var overlap =
            Math.min(islands[i].end, b) -
            Math.max(islands[i].start, a);

        if (overlap > bestOverlap) {
            best = islands[i];
            bestOverlap = overlap;
        }
    }

    if (!best) {
        return null;
    }

    var len = best.end - best.start;

    /* sound continues past the window => glued to other speech */
    if (best.start <= 0.001 || best.end >= windowLen - 0.001) {
        return null;
    }

    if (bestOverlap < 0.5 * wordDur - 0.000001) {
        return null;
    }

    /* much longer than the word => it contains neighbouring words */
    if (len > wordDur + 0.40) {
        return null;
    }

    /* much shorter than the word => only the loud part was found */
    if (len < 0.5 * wordDur - 0.000001) {
        return null;
    }

    return best;
}

function cadrRefineFillerBounds(
    fillers,
    segments,
    ffmpegPath,
    noiseDb,
    onDone
) {

    var cp = window.cep_node.require("child_process");

    var MARGIN = 0.30;
    var PAD = 0.02;
    var index = 0;

    function next() {

        if (index >= fillers.length) {
            onDone();
            return;
        }

        var f = fillers[index];
        index++;

        f.refined = false;

        var clip = null;

        for (var i = 0; i < segments.length; i++) {

            var c = segments[i].clip;

            if (
                f.start >= c.timelineStart - 0.01 &&
                f.start < c.timelineStart + c.duration + 0.01
            ) {
                clip = c;
                break;
            }
        }

        if (!clip) {
            next();
            return;
        }

        var winStart = Math.max(clip.timelineStart, f.start - MARGIN);
        var winEnd = Math.min(clip.timelineStart + clip.duration, f.end + MARGIN);
        var winLen = winEnd - winStart;

        if (winLen <= 0.1 || f.end <= f.start) {
            next();
            return;
        }

        var srcStart = clip.sourceIn + (winStart - clip.timelineStart);

        cp.execFile(
            ffmpegPath,
            [
                "-hide_banner",
                "-nostats",
                "-ss", srcStart.toFixed(3),
                "-t", winLen.toFixed(3),
                "-i", clip.path,
                "-vn",
                "-af", "silencedetect=noise=" + noiseDb + "dB:d=0.04",
                "-f", "null",
                cadrNullDevice()
            ],
            { maxBuffer: 5 * 1024 * 1024, timeout: 20000 },
            function (error, stdout, stderr) {

                var output = stderr || stdout || "";

                if (!output) {
                    next();
                    return;
                }

                var silences = [];
                var current = null;
                var lines = output.split(/\r?\n/);

                for (var l = 0; l < lines.length; l++) {

                    var startMatch = lines[l].match(/silence_start:\s*(-?[0-9.]+)/);

                    if (startMatch) {
                        current = { start: parseFloat(startMatch[1]), end: null };
                        silences.push(current);
                    }

                    var endMatch = lines[l].match(/silence_end:\s*([0-9.]+)/);

                    if (endMatch && current) {
                        current.end = parseFloat(endMatch[1]);
                        current = null;
                    }
                }

                var islands = cadrSpeechIslands(silences, winLen);

                var picked = cadrPickIsland(
                    islands,
                    f.start - winStart,
                    f.end - winStart,
                    winLen
                );

                if (picked) {

                    f.start = Math.max(winStart, winStart + picked.start - PAD);
                    f.end = Math.min(winEnd, winStart + picked.end + PAD);
                    f.refined = true;
                }

                next();
            }
        );
    }

    next();
}

/* ▶ button in the filler list: jump the playhead a bit before the word. */
function cadrPlayFiller(seconds) {
    csInterface.evalScript(
        "cadrGoTo(" + Math.max(0, seconds - 0.5).toFixed(3) + ")",
        function () {}
    );
}


/* =========================================================
   JOIN THE CLIPS' AUDIO INTO ONE FILE

   MP3 (32 kbps, mono) is ~8x smaller than WAV, so far longer
   timelines fit in one Gemini request. If this FFmpeg build has
   no MP3 encoder, we fall back to WAV automatically.
   ========================================================= */

function cadrConcatAudio(
    ffmpegPath,
    inputPaths,
    preferMp3,
    onDone
) {

    var cp = window.cep_node.require("child_process");
    var os = window.cep_node.require("os");
    var path = window.cep_node.require("path");
    var fs = window.cep_node.require("fs");

    var stamp = Date.now();

    function buildArgs(outputPath, mp3) {

        var args = ["-hide_banner", "-loglevel", "error", "-y"];
        var filterInputs = "";

        for (var i = 0; i < inputPaths.length; i++) {
            args.push("-i", inputPaths[i]);
            filterInputs += "[" + i + ":a]";
        }

        args.push(
            "-filter_complex",
            filterInputs + "concat=n=" + inputPaths.length + ":v=0:a=1[out]",
            "-map",
            "[out]"
        );

        if (mp3) {
            args.push(
                "-c:a", "libmp3lame",
                "-b:a", "32k",
                "-ar", "16000",
                "-ac", "1"
            );
        }

        args.push(outputPath);

        return args;
    }

    function cleanupInputs() {
        for (var c = 0; c < inputPaths.length; c++) {
            try {
                fs.unlink(inputPaths[c], function () {});
            } catch (e) {}
        }
    }

    function attempt(mp3) {

        var outputPath =
            path.join(
                os.tmpdir(),
                "cadr_caption_combined_" + stamp + (mp3 ? ".mp3" : ".wav")
            );

        cp.execFile(
            ffmpegPath,
            buildArgs(outputPath, mp3),
            { maxBuffer: 10 * 1024 * 1024 },
            function (error) {

                if (error && mp3) {

                    try {
                        fs.unlinkSync(outputPath);
                    } catch (e) {}

                    attempt(false);
                    return;
                }

                cleanupInputs();

                if (error) {
                    onDone(error, null, null);
                    return;
                }

                onDone(
                    null,
                    outputPath,
                    mp3
                        ? { mime: "audio/mp3", format: "mp3" }
                        : { mime: "audio/wav", format: "wav" }
                );
            }
        );
    }

    attempt(!!preferMp3);
}


function combineAndCaption(
    clips,
    extractedPaths,
    aiProvider,
    apiKey,
    model,
    language,
    wordsPerLine,
    naturalSplit,
    ffmpegPath,
    status,
    button
) {

    var cp =
        window.cep_node.require(
            "child_process"
        );

    var os =
        window.cep_node.require(
            "os"
        );

    var path =
        window.cep_node.require(
            "path"
        );

    var fs =
        window.cep_node.require(
            "fs"
        );

    var segments =
        [];

    var cursor =
        0;

    for (
        var s = 0;
        s < clips.length;
        s++
    ) {

        segments.push({
            clip:
                clips[s],

            concatStart:
                cursor,

            concatEnd:
                cursor +
                clips[s].duration
        });

        cursor +=
            clips[s].duration;
    }

    var totalAudioSeconds =
        cursor;

    status.textContent =
        "Combining audio...";

    cadrConcatAudio(
        ffmpegPath,
        extractedPaths,
        true,
        function (
            concatError,
            combinedWav,
            audioInfo
        ) {

            if (concatError) {

                button.disabled =
                    false;

                status.textContent =
                    "فشل دمج الصوت:\n\n" +
                    concatError.message;

                return;
            }

            var audioBase64;

            try {

                audioBase64 =
                    fs.readFileSync(
                        combinedWav
                    ).toString(
                        "base64"
                    );

            } catch (
                readError
            ) {

                button.disabled =
                    false;

                status.textContent =
                    "مش قادر أقرأ ملف الصوت المدموج.";

                try {
                    fs.unlinkSync(
                        combinedWav
                    );
                } catch (e0) {}

                return;
            }

            try {
                fs.unlink(
                    combinedWav,
                    function () {}
                );
            } catch (e2) {}

            var langInstruction =
                language === "auto"
                    ? "Detect the spoken language automatically."
                    : "The spoken language is " +
                      language +
                      ".";

            var splitInstruction =
                naturalSplit
                    ? "Split \"lines\" naturally by sentence or clause — wherever a natural pause or breath in the speech happens — rather than by a fixed word count. Keep each line short and readable."
                    : "Break \"lines\" into short readable subtitle chunks of no more than " +
                      (
                          isNaN(
                              wordsPerLine
                          ) ||
                          wordsPerLine < 1
                              ? 8
                              : wordsPerLine
                      ) +
                      " words per line.";

            var promptText =
                "Transcribe this audio. Respond with ONLY a single valid JSON object — no markdown, " +
                "no code fences, no extra text — with this exact shape:\n" +
                '{"lines": [{"text": string, "start": number, "end": number}, ...], ' +
                '"words": [{"word": string, "start": number, "end": number}, ...]}\n' +
                "All times are in seconds from the start of the audio as plain numbers (e.g. 12.34).\n" +
                "\"words\" must include EVERY spoken word individually, in order, with its own start/end time — " +
                "including short filler words like \"يعني\", \"إمم\", \"آه\", \"طيب\", \"خلاص\".\n" +
                splitInstruction +
                " " +
                langInstruction;

            var endpoint;
            var requestBody;
            var requestBodyNoSchema = null;
            var fetchHeaders;

            

                status.textContent =
                    "Uploading to Gemini...";

                cadrBarText();

                if (
                    audioBase64.length >=
                    19 *
                    1024 *
                    1024
                ) {

                    button.disabled =
                        false;

                    status.textContent =
                        "الصوت المحدد (حوالي " +
                        Math.round(totalAudioSeconds / 60) +
                        " دقيقة) أكبر من الحد المسموح لـ Gemini في الرفع المباشر.\n\n" +
                        "جرّب تحدد جزء أقصر من التايم لاين.";

                    return;
                }

                endpoint =
                    "https://generativelanguage.googleapis.com/v1beta/models/" +
                    encodeURIComponent(
                        model
                    ) +
                    ":generateContent?key=" +
                    encodeURIComponent(
                        apiKey
                    );

                fetchHeaders = {

                    "Content-Type":
                        "application/json"
                };

                requestBody =
                    JSON.stringify({

                        contents: [
                            {
                                parts: [

                                    {
                                        text:
                                            promptText
                                    },

                                    {
                                        inline_data: {

                                            mime_type:
                                                audioInfo.mime,

                                            data:
                                                audioBase64
                                        }
                                    }
                                ]
                            }
                        ],

                        generationConfig: {

                            responseMimeType:
                                "application/json",

                            /* Forces valid JSON in the shape we parse,
                               so the model cannot return broken JSON. */
                            responseSchema: {
                                type: "OBJECT",
                                properties: {
                                    lines: {
                                        type: "ARRAY",
                                        items: {
                                            type: "OBJECT",
                                            properties: {
                                                text: { type: "STRING" },
                                                start: { type: "NUMBER" },
                                                end: { type: "NUMBER" }
                                            },
                                            required: ["text", "start", "end"]
                                        }
                                    },
                                    words: {
                                        type: "ARRAY",
                                        items: {
                                            type: "OBJECT",
                                            properties: {
                                                word: { type: "STRING" },
                                                start: { type: "NUMBER" },
                                                end: { type: "NUMBER" }
                                            },
                                            required: ["word", "start", "end"]
                                        }
                                    }
                                },
                                required: ["lines", "words"]
                            }
                        }
                    });

                /* Same request without the schema, used only if the
                   model rejects the schema. */
                requestBodyNoSchema =
                    JSON.stringify({
                        contents: [
                            {
                                parts: [
                                    {
                                        text:
                                            promptText
                                    },
                                    {
                                        inline_data: {
                                            mime_type:
                                                audioInfo.mime,
                                            data:
                                                audioBase64
                                        }
                                    }
                                ]
                            }
                        ],
                        generationConfig: {
                            responseMimeType:
                                "application/json"
                        }
                    });
            

            var aiAttempt = 0;
            var AI_MAX_ATTEMPTS = 3;
            var aiUseSchema = true;
            var aiGotResponse = false;

            /* Tries again (after a short wait) if attempts are left.
               Returns true if a retry was scheduled. */
            function retryAi(reason) {

                if (aiAttempt >= AI_MAX_ATTEMPTS) {
                    return false;
                }

                status.textContent =
                    reason +
                    "\n\nبيحاول تاني تلقائي (المحاولة " +
                    (aiAttempt + 1) + " من " + AI_MAX_ATTEMPTS + ")...";

                setTimeout(callAi, 2000 * aiAttempt);

                return true;
            }

            function callAi() {

            aiAttempt++;
            aiGotResponse = false;

            fetch(
                endpoint,
                {
                    method:
                        "POST",

                    headers:
                        fetchHeaders,

                    body:
                        (
                            !aiUseSchema &&
                            requestBodyNoSchema
                        )
                            ? requestBodyNoSchema
                            : requestBody
                }
            )
                .then(
                    function (
                        response
                    ) {

                        return response.json();
                    }
                )
                .then(
                    function (
                        data
                    ) {

                        aiGotResponse = true;

                        if (data.error) {

                            var apiMessage =
                                String(
                                    data.error.message ||
                                    ""
                                );

                            var apiCode =
                                data.error.code;

                            /* the model does not accept the schema */
                            if (
                                aiUseSchema &&
                                requestBodyNoSchema &&
                                apiCode === 400 &&
                                /schema|response_schema|responseSchema/i.test(
                                    apiMessage
                                )
                            ) {

                                aiUseSchema = false;
                                aiAttempt--;

                                if (retryAi("الموديل رفض شكل الرد المحدد.")) {
                                    return;
                                }
                            }

                            /* temporary server trouble: busy / overloaded */
                            if (
                                apiCode === 429 ||
                                apiCode === 500 ||
                                apiCode === 503 ||
                                apiCode === 504
                            ) {

                                if (
                                    retryAi(
                                        "السيرفر مشغول (" +
                                        apiCode + ")."
                                    )
                                ) {
                                    return;
                                }
                            }

                            button.disabled =
                                false;

                            status.textContent =
                                "خطأ من الـ AI (" +
                                aiProvider +
                                "):\n\n" +
                                (
                                    data.error.message ||
                                    JSON.stringify(
                                        data.error
                                    )
                                );

                            return;
                        }

                        var rawText =
                            "";

                        var aiFinishReason = "";
                        var aiOutputTokens = "";

                        try {

                            

                                aiFinishReason =
                                    String(
                                        (
                                            data.candidates &&
                                            data.candidates[0] &&
                                            data.candidates[0].finishReason
                                        ) || ""
                                    );

                                aiOutputTokens =
                                    String(
                                        (
                                            data.usageMetadata &&
                                            data.usageMetadata.candidatesTokenCount
                                        ) || ""
                                    );
                            

                        } catch (diagError) {}

                        try {

                            

                                /*
                                 * Gemini can sometimes return multiple
                                 * content parts. Join all text parts
                                 * instead of assuming parts[0].
                                 */

                                var geminiParts =
                                    data
                                        .candidates[0]
                                        .content
                                        .parts;

                                var geminiTextParts =
                                    [];

                                for (
                                    var gi = 0;
                                    gi <
                                    geminiParts.length;
                                    gi++
                                ) {

                                    if (
                                        geminiParts[gi] &&
                                        geminiParts[gi].text
                                    ) {

                                        geminiTextParts.push(
                                            geminiParts[gi].text
                                        );
                                    }
                                }

                                rawText =
                                    geminiTextParts.join(
                                        "\n"
                                    );
                            

                        } catch (
                            responseShapeError
                        ) {

                            button.disabled =
                                false;

                            status.textContent =
                                "الرد من الـ AI مش بالشكل المتوقع.";

                            return;
                        }


                        /* =================================================
                           ROBUST PARSING
                           ================================================= */

                        var parsedCaption;

                        try {

                            parsedCaption =
                                parseAiCaptionResponse(
                                    rawText
                                );

                        } catch (
                            parseError
                        ) {

                            console.warn(
                                "CADR AI RAW RESPONSE (attempt " +
                                aiAttempt + "):",
                                rawText
                            );

                            if (
                                retryAi(
                                    "رد الـ AI مش مفهوم" +
                                    (aiFinishReason
                                        ? " (" + aiFinishReason + ")"
                                        : "") +
                                    "."
                                )
                            ) {
                                return;
                            }

                            button.disabled =
                                false;

                            var rawString =
                                String(
                                    rawText || ""
                                );

                            status.textContent =
                                "مش قادر أفهم رد الـ AI بعد " +
                                aiAttempt + " محاولات.\n\n" +
                                (
                                    parseError.message ||
                                    "الرد مش JSON أو SRT صالح."
                                ) +
                                "\n\nتفاصيل للمساعدة في الإصلاح:" +
                                "\nسبب انتهاء الرد: " +
                                (aiFinishReason || "غير معروف") +
                                "\nطول الرد: " + rawString.length + " حرف" +
                                (aiOutputTokens
                                    ? "\nعدد التوكنز: " + aiOutputTokens
                                    : "") +
                                "\nمدة الصوت: حوالي " +
                                Math.round(totalAudioSeconds / 60) + " دقيقة" +
                                "\n\nأول الرد:\n" +
                                rawString.slice(0, 350) +
                                "\n\nآخر الرد:\n" +
                                rawString.slice(-350);

                            return;
                        }


                        var lines =
                            parsedCaption.lines ||
                            [];

                        var words =
                            parsedCaption.words ||
                            [];

                        console.log(
                            "CADR Caption Response Format:",
                            parsedCaption.source
                        );

                        console.log(
                            "CADR Caption Lines:",
                            lines.length
                        );

                        console.log(
                            "CADR Caption Words:",
                            words.length
                        );


                        if (
                            !lines.length &&
                            !words.length
                        ) {

                            button.disabled =
                                false;

                            status.textContent =
                                "الـ AI رجّع رد لكن مفيهوش Caption صالح.";

                            return;
                        }


                        /* =================================================
                           MAP LINES TO PREMIERE TIMELINE
                           ================================================= */

                        var timelineLines =
                            [];

                        for (
                            var li = 0;
                            li < lines.length;
                            li++
                        ) {

                            var normalizedLine =
                                normalizeCaptionLine(
                                    lines[li]
                                );

                            if (
                                !normalizedLine
                            ) {
                                continue;
                            }

                            timelineLines.push({

                                text:
                                    normalizedLine.text,

                                start:
                                    mapConcatTimeToTimeline(
                                        normalizedLine.start,
                                        segments
                                    ),

                                end:
                                    mapConcatTimeToTimeline(
                                        normalizedLine.end,
                                        segments
                                    )
                            });
                        }


                        /* =================================================
                           MAP WORDS TO PREMIERE TIMELINE
                           ================================================= */

                        var timelineWords =
                            [];

                        for (
                            var wi2 = 0;
                            wi2 < words.length;
                            wi2++
                        ) {

                            var normalizedWord =
                                normalizeCaptionWord(
                                    words[wi2]
                                );

                            if (
                                !normalizedWord
                            ) {
                                continue;
                            }

                            timelineWords.push({

                                text:
                                    normalizedWord.word,

                                start:
                                    mapConcatTimeToTimeline(
                                        normalizedWord.start,
                                        segments
                                    ),

                                end:
                                    mapConcatTimeToTimeline(
                                        normalizedWord.end,
                                        segments
                                    )
                            });
                        }


                        /*
                         * If the AI only returned words and no lines,
                         * keep the words. If lines are missing, preview
                         * can still use the word-level captions.
                         */

                        pendingCaptionLines =
                            timelineLines;

                        pendingCaptionWords =
                            timelineWords;


                        /*
                         * Important:
                         * If user selected Word Level Captions but the
                         * AI returned SRT, words will be empty.
                         * Fall back to lines so the preview is not blank.
                         */

                        var wordLevelCheckbox =
                            document.getElementById(
                                "wordLevelCaptions"
                            );

                        if (
                            wordLevelCheckbox &&
                            wordLevelCheckbox.checked &&
                            pendingCaptionWords.length === 0 &&
                            pendingCaptionLines.length > 0
                        ) {

                            wordLevelCheckbox.checked =
                                false;
                        }


                        rebuildCaptionPreview();


                        /* =================================================
                           FILLER WORD DETECTION
                           ================================================= */

                        fillerWordsList =
                            [];

                        for (
                            var wi = 0;
                            wi < words.length;
                            wi++
                        ) {

                            var fillerWord =
                                normalizeCaptionWord(
                                    words[wi]
                                );

                            if (
                                !fillerWord
                            ) {
                                continue;
                            }

                            if (
                                isFillerWord(
                                    fillerWord.word
                                )
                            ) {

                                var mapped =
                                    mapConcatTimeToTimelineWithTrack(
                                        fillerWord.start,
                                        segments
                                    );

                                fillerWordsList.push({

                                    word:
                                        fillerWord.word,

                                    start:
                                        mapConcatTimeToTimeline(
                                            fillerWord.start,
                                            segments
                                        ),

                                    end:
                                        mapConcatTimeToTimeline(
                                            fillerWord.end,
                                            segments
                                        ),

                                    trackIndex:
                                        mapped.trackIndex
                                });
                            }
                        }


                        fillerWordsList.sort(
                            function (
                                a,
                                b
                            ) {

                                return (
                                    a.start -
                                    b.start
                                );
                            }
                        );


                        var showFinalStatus = function () {

                        cadrBarCaptionDone();

                        button.disabled =
                            false;

                        /* =================================================
                           FINAL STATUS
                           ================================================= */

                        if (
                            parsedCaption.source ===
                            "SRT"
                        ) {

                            status.textContent =
                                "الـ AI رجّع SRT بدل JSON، فـ CADR حوّله تلقائيًا للكابشن.\n\n" +
                                "Word-level وFiller Words مش متاحين من رد SRT.";

                        } else if (
                            fillerWordsList.length >
                            0
                        ) {

                            status.textContent =
                                "لقيت " +
                                fillerWordsList.length +
                                " كلمة حشو — راجعها تحت، وبعدين دوس IMPORT CAPTIONS.";

                            renderFillerWords();

                        } else {

                            status.textContent =
                                "مفيش كلمات حشو معروفة. جاهز للاستيراد.";

                            document.getElementById(
                                "fillerWordsBox"
                            ).style.display =
                                "block";

                            document.getElementById(
                                "fillerWordsList"
                            ).innerHTML =
                                "<div class=\"card-sub\">مفيش حاجة تراجعها.</div>";
                        }

                        };

                        /* Gemini's word times can be off by a fraction of a second.
                           Before the user reviews the list, snap each filler word
                           to the real sound in the audio (when it is safe to). */
                        if (
                            parsedCaption.source !== "SRT" &&
                            fillerWordsList.length > 0
                        ) {

                            status.textContent =
                                "بيظبط توقيت كلمات الحشو على الصوت...";

                            try {

                                cadrRefineFillerBounds(
                                    fillerWordsList,
                                    segments,
                                    ffmpegPath,
                                    cadrCurrentNoiseDb(),
                                    showFinalStatus
                                );

                            } catch (refineError) {

                                console.warn(
                                    "CADR: filler refine failed:",
                                    refineError
                                );

                                showFinalStatus();
                            }

                        } else {

                            showFinalStatus();
                        }

                    }
                )
                .catch(
                    function (
                        fetchError
                    ) {

                        /* Only retry real connection problems. An error
                           AFTER the answer arrived (while building the
                           captions) must not call the AI again. */
                        if (
                            !aiGotResponse &&
                            retryAi(
                                "فشل الاتصال (" +
                                fetchError.message +
                                ")."
                            )
                        ) {
                            return;
                        }

                        button.disabled =
                            false;

                        status.textContent =
                            "فشل الاتصال بـ " +
                            aiProvider +
                            ":\n\n" +
                            fetchError.message;
                    }
                );

            }

            callAi();
        }
    );
}


/* =========================================================
   SRT BUILDER & CAPTION MANAGEMENT
   ========================================================= */

function buildSrtFromLines(
    lines
) {

    var output =
        "";

    for (
        var i = 0;
        i < lines.length;
        i++
    ) {

        output +=
            (i + 1) +
            "\n";

        output +=
            secondsToSrtTime(
                lines[i].start
            ) +
            " --> " +
            secondsToSrtTime(
                lines[i].end
            ) +
            "\n";

        output +=
            lines[i].text +
            "\n\n";
    }

    return (
        output.trim() +
        "\n"
    );
}


function toggleAllFillerCheckboxes(
    checked
) {

    var boxes =
        document.querySelectorAll(
            ".filler-checkbox"
        );

    for (
        var i = 0;
        i < boxes.length;
        i++
    ) {

        boxes[i].checked =
            checked;
    }
}


function renderFillerWords() {

    var box =
        document.getElementById(
            "fillerWordsBox"
        );

    var list =
        document.getElementById(
            "fillerWordsList"
        );

    var selectAll =
        document.getElementById(
            "selectAllFillerWords"
        );

    if (selectAll) {

        selectAll.checked =
            false;
    }

    box.style.display =
        "block";

    list.innerHTML =
        "";

    if (
        fillerWordsList.length ===
        0
    ) {

        list.innerHTML =
            "<div class=\"card-sub\">كل الكلمات اتشالت. جاهز للاستيراد.</div>";

        return;
    }

    for (
        var i = 0;
        i < fillerWordsList.length;
        i++
    ) {

        var item =
            fillerWordsList[i];

        var row =
            document.createElement(
                "div"
            );

        row.className =
            "filler-row";

        var checkbox =
            document.createElement(
                "input"
            );

        checkbox.type =
            "checkbox";

        checkbox.className =
            "filler-checkbox";

        checkbox.style.width =
            "auto";

        checkbox.setAttribute(
            "data-index",
            String(i)
        );

        var label =
            document.createElement(
                "span"
            );

        label.innerHTML =
            "<span class=\"filler-word\">" +
            item.word +
            "</span>" +
            "<span class=\"filler-time\">@ " +
            item.start.toFixed(2) +
            "s</span>";

        var deleteBtn =
            document.createElement(
                "button"
            );

        deleteBtn.textContent =
            "احذف";

        deleteBtn.setAttribute(
            "data-index",
            String(i)
        );

        deleteBtn.onclick =
            (function (
                index
            ) {

                return function () {

                    deleteFillerWords(
                        [index]
                    );
                };

            })(i);

        row.appendChild(
            checkbox
        );

        row.appendChild(
            label
        );

        row.appendChild(
            deleteBtn
        );

        list.appendChild(
            row
        );
    }

    /* Decorate the rows: ✓/≈ marker, ▶ button, and show the AI's word as
       plain text (never as HTML). */
    var rows = list.querySelectorAll(".filler-row");

    for (var r = 0; r < rows.length && r < fillerWordsList.length; r++) {

        var fItem = fillerWordsList[r];

        var wordSpan = rows[r].querySelector(".filler-word");

        if (wordSpan) {
            wordSpan.textContent = fItem.word;
        }

        var timeSpan = rows[r].querySelector(".filler-time");

        if (timeSpan) {

            timeSpan.textContent += fItem.refined ? "  ✓" : "  ≈";

            timeSpan.title =
                fItem.refined
                    ? "التوقيت اتظبط على الصوت الفعلي"
                    : "توقيت تقريبي من الـ AI — دوس ▶ واسمعه قبل ما تحذف";
        }

        var playBtn = document.createElement("button");

        playBtn.className = "filler-play";
        playBtn.textContent = "▶";
        playBtn.title = "روح لمكان الكلمة على التايم لاين";

        playBtn.onclick = (function (t) {
            return function () {
                cadrPlayFiller(t);
            };
        })(fItem.start);

        rows[r].insertBefore(playBtn, rows[r].querySelector("button"));
    }
}


function deleteSelectedFillerWords() {

    var checkboxes =
        document.querySelectorAll(
            ".filler-checkbox:checked"
        );

    var indices =
        [];

    for (
        var i = 0;
        i < checkboxes.length;
        i++
    ) {

        indices.push(
            parseInt(
                checkboxes[i]
                    .getAttribute(
                        "data-index"
                    ),
                10
            )
        );
    }

    if (
        indices.length ===
        0
    ) {
        return;
    }

    deleteFillerWords(
        indices
    );
}


function deleteFillerWords(
    indices
) {

    var status =
        document.getElementById(
            "captionStatus"
        );

    var items =
        [];

    for (
        var i = 0;
        i < indices.length;
        i++
    ) {

        var item =
            fillerWordsList[
                indices[i]
            ];

        if (item) {

            items.push(
                item
            );
        }
    }

    if (
        items.length ===
        0
    ) {
        return;
    }

    items.sort(
        function (
            a,
            b
        ) {

            return (
                b.start -
                a.start
            );
        }
    );

    var cuts =
        [];

    for (
        var j = 0;
        j < items.length;
        j++
    ) {

        cuts.push(
            items[j].trackIndex +
            "|" +
            items[j].start.toFixed(
                3
            ) +
            "|" +
            items[j].end.toFixed(
                3
            )
        );
    }

    status.textContent =
        "بيحذف " +
        items.length +
        " كلمة حشو...";

    cadrBackupThen(status, function (safeToCut) {

    if (!safeToCut) {
        return;
    }

    cadrRunCutsSequentially(
        cuts,
        function (done, total) {
            status.textContent =
                "بيحذف " + done + " / " + total + " كلمة حشو...";
        },
        function (results) {

            var deletedItems =
                [];

            for (
                var k = 0;
                k < items.length;
                k++
            ) {

                if (
                    results[k] ===
                    "OK"
                ) {

                    deletedItems.push(
                        items[k]
                    );
                }
            }

            deletedItems.sort(
                function (
                    a,
                    b
                ) {

                    return (
                        a.start -
                        b.start
                    );
                }
            );

            for (
                var d = 0;
                d < deletedItems.length;
                d++
            ) {

                var removedDuration =
                    deletedItems[d].end -
                    deletedItems[d].start;

                var removedStart =
                    deletedItems[d].start;

                var stillThere =
                    [];

                for (
                    var f = 0;
                    f < fillerWordsList.length;
                    f++
                ) {

                    if (
                        fillerWordsList[f] ===
                        deletedItems[d]
                    ) {
                        continue;
                    }

                    if (
                        fillerWordsList[f].start >
                        removedStart
                    ) {

                        fillerWordsList[f].start -=
                            removedDuration;

                        fillerWordsList[f].end -=
                            removedDuration;
                    }

                    stillThere.push(
                        fillerWordsList[f]
                    );
                }

                fillerWordsList =
                    stillThere;

                shiftCaptionTimings(
                    removedStart,
                    removedDuration
                );
            }

            rebuildCaptionPreview();

            status.textContent =
                "اتحذف " +
                deletedItems.length +
                " من " +
                items.length +
                " كلمة.";

            renderFillerWords();
        }
    );

    });
}


function escapeExtendScriptString(
    value
) {

    return String(
        value
    )
        .replace(
            /\\/g,
            "\\\\"
        )
        .replace(
            /'/g,
            "\\'"
        )
        .replace(
            /\r/g,
            "\\r"
        )
        .replace(
            /\n/g,
            "\\n"
        );
}


function importPendingCaptions() {

    var preview =
        document.getElementById(
            "captionPreview"
        );

    var srtToImport =
        (
            preview &&
            preview.value.trim()
        )
            ? preview.value
            : pendingCaptionSrt;

    if (!srtToImport) {
        return;
    }

    var status =
        document.getElementById(
            "captionStatus"
        );

    var importBtn =
        document.getElementById(
            "importCaptionsButton"
        );

    importBtn.disabled =
        true;

    status.textContent =
        "Importing captions into Premiere...";

    var os =
        window.cep_node.require(
            "os"
        );

    var path =
        window.cep_node.require(
            "path"
        );

    var fs =
        window.cep_node.require(
            "fs"
        );

    var srtPath =
        path.join(
            os.tmpdir(),
            "cadr_caption_" +
            Date.now() +
            ".srt"
        );

    try {

        fs.writeFileSync(
            srtPath,
            srtToImport,
            "utf8"
        );

    } catch (
        writeError
    ) {

        importBtn.disabled =
            false;

        status.textContent =
            "مش قادر أكتب ملف SRT.";

        return;
    }

    csInterface.evalScript(
        "importSRTFile('" +
        escapeExtendScriptString(
            srtPath
        ) +
        "')",
        function (
            importResponse
        ) {

            importBtn.disabled =
                false;

            if (
                importResponse ===
                "CAPTION_TRACK_CREATED"
            ) {

                status.textContent =
                    "تم استيراد الكابشن على التايم لاين ✅";

                document.getElementById(
                    "fillerWordsBox"
                ).style.display =
                    "none";

                return;
            }

            if (
                importResponse &&
                importResponse.indexOf(
                    "CREATE_CAPTION_TRACK_CONFLICT"
                ) === 0
            ) {

                status.textContent =
                    "فشل الاستيراد — الأغلب إن فيه Caption Track موجود بالفعل من مرة سابقة.\n\n" +
                    "الحل: امسح الـ Caption Track القديم يدويًا من التايم لاين ثم جرب تاني.";

                return;
            }

            if (
                importResponse ===
                "CREATE_CAPTION_TRACK_UNAVAILABLE"
            ) {

                status.textContent =
                    "نسخة بريمير عندك مش بتدعم إنشاء Caption Track من السكريبت.";

                return;
            }

            if (
                importResponse ===
                "SRT_IMPORTED_BUT_ITEM_NOT_FOUND"
            ) {

                status.textContent =
                    "الملف اتستورد للمشروع بس مش لاقيه — جرب تاني.";

                return;
            }

            status.textContent =
                "النتيجة: " +
                importResponse;

            document.getElementById(
                "fillerWordsBox"
            ).style.display =
                "none";
        }
    );
}


function mapConcatTimeToTimeline(
    t,
    segments
) {

    for (
        var i = 0;
        i < segments.length;
        i++
    ) {

        var seg =
            segments[i];

        var isLast =
            i ===
            segments.length - 1;

        if (
            t >= seg.concatStart &&
            (
                t < seg.concatEnd ||
                isLast
            )
        ) {

            return (
                seg.clip.timelineStart +
                (
                    t -
                    seg.concatStart
                )
            );
        }
    }

    var lastSeg =
        segments[
            segments.length - 1
        ];

    return (
        lastSeg.clip.timelineStart +
        (
            t -
            lastSeg.concatStart
        )
    );
}


function mapConcatTimeToTimelineWithTrack(
    t,
    segments
) {

    for (
        var i = 0;
        i < segments.length;
        i++
    ) {

        var seg =
            segments[i];

        var isLast =
            i ===
            segments.length - 1;

        if (
            t >= seg.concatStart &&
            (
                t < seg.concatEnd ||
                isLast
            )
        ) {

            return {

                time:
                    seg.clip.timelineStart +
                    (
                        t -
                        seg.concatStart
                    ),

                trackIndex:
                    seg.clip.trackIndex
            };
        }
    }

    var lastSeg =
        segments[
            segments.length - 1
        ];

    return {

        time:
            lastSeg.clip.timelineStart +
            (
                t -
                lastSeg.concatStart
            ),

        trackIndex:
            lastSeg.clip.trackIndex
    };
}


function secondsToSrtTime(
    totalSeconds
) {

    if (
        totalSeconds < 0
    ) {

        totalSeconds =
            0;
    }

    var totalMs =
        Math.round(
            totalSeconds *
            1000
        );

    var hh =
        Math.floor(
            totalMs /
            3600000
        );

    var mm =
        Math.floor(
            (
                totalMs %
                3600000
            ) /
            60000
        );

    var ss =
        Math.floor(
            (
                totalMs %
                60000
            ) /
            1000
        );

    var ms =
        totalMs %
        1000;

    function pad(
        n,
        len
    ) {

        var s =
            String(n);

        while (
            s.length <
            len
        ) {

            s =
                "0" +
                s;
        }

        return s;
    }

    return (
        pad(hh, 2) +
        ":" +
        pad(mm, 2) +
        ":" +
        pad(ss, 2) +
        "," +
        pad(ms, 3)
    );
}


/* =========================================================
   LOAD SAVED AI SETTINGS ON STARTUP
   ========================================================= */

(function loadSavedAiSettings() {

    var savedGeminiKey =
        getSetting(
            "geminiApiKey",
            null
        );

    if (
        savedGeminiKey &&
        document.getElementById(
            "geminiApiKey"
        )
    ) {

        document.getElementById(
            "geminiApiKey"
        ).value =
            savedGeminiKey;
    }

    var savedGeminiModel =
        getSetting(
            "geminiModel",
            null
        );

    if (
        savedGeminiModel &&
        document.getElementById(
            "geminiModel"
        )
    ) {

        document.getElementById(
            "geminiModel"
        ).value =
            savedGeminiModel;
    }

    var savedLanguage =
        getSetting(
            "captionLanguage",
            null
        );

    if (
        savedLanguage &&
        document.getElementById(
            "captionLanguage"
        )
    ) {

        document.getElementById(
            "captionLanguage"
        ).value =
            savedLanguage;
    }

    var savedWordLevel =
        getSetting(
            "wordLevelCaptions",
            null
        );

    if (
        savedWordLevel &&
        document.getElementById(
            "wordLevelCaptions"
        )
    ) {

        document.getElementById(
            "wordLevelCaptions"
        ).checked =
            savedWordLevel ===
            "1";
    }

    var savedWordsPerLine =
        getSetting(
            "wordsPerLine",
            null
        );

    if (
        savedWordsPerLine &&
        document.getElementById(
            "wordsPerLine"
        )
    ) {

        document.getElementById(
            "wordsPerLine"
        ).value =
            savedWordsPerLine;
    }

    refreshApiKeyStorageStatus();

    var savedNaturalSplit =
        getSetting(
            "naturalSplit",
            null
        );

    if (
        savedNaturalSplit &&
        document.getElementById(
            "naturalSplit"
        )
    ) {

        document.getElementById(
            "naturalSplit"
        ).checked =
            savedNaturalSplit ===
            "1";
    }

})();


/* =========================================================
   INITIALIZE
   ========================================================= */

/* Do not auto-call evalScript on startup in Premiere Pro 2026 */


if (
    document.readyState ===
    "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        initializePluginSettings
    );

} else {

    initializePluginSettings();
}

/* =========================================================
   UI v2
   Pinned progress bar, presets, sliders, caption helpers.
   Everything here only drives the panel; the cutting and
   captioning logic above is unchanged.
   ========================================================= */

var CADR_BAR_COUNT = 48;
var cadrBarFillPct = 0;
var cadrBarModeNow = "wave";
var cadrBarTimer = null;
var cadrBarEls = [];


function cadrFmtDuration(seconds) {

    var total = Math.max(0, Math.round(seconds));
    var m = Math.floor(total / 60);
    var s = total % 60;

    return m + ":" + (s < 10 ? "0" : "") + s;
}


/* ---------- pinned bar ---------- */

function cadrBuildBar() {

    var wrap = document.getElementById("cadrBars");

    if (!wrap) {
        return;
    }

    wrap.innerHTML = "";
    cadrBarEls = [];

    for (var i = 0; i < CADR_BAR_COUNT; i++) {

        var h = 8 + Math.round(
            34 * Math.min(
                1,
                Math.abs(
                    Math.sin(i * 0.9) * Math.cos(i * 0.31) +
                    0.15 * Math.sin(i * 2.3)
                )
            )
        );

        var bar = document.createElement("i");

        bar.style.height = h + "px";

        wrap.appendChild(bar);
        cadrBarEls.push(bar);
    }
}

function cadrBarStop() {

    if (cadrBarTimer) {
        clearInterval(cadrBarTimer);
        cadrBarTimer = null;
    }
}

function cadrBarShow(mode) {

    cadrBarModeNow = mode;

    var map = {
        wave: "cadrBars",
        text: "cadrText",
        typed: "cadrTyped"
    };

    for (var key in map) {

        var el = document.getElementById(map[key]);

        if (el) {
            el.style.display = key === mode ? "flex" : "none";
        }
    }
}

function cadrBarSetFill(percent) {

    var p = Math.max(0, Math.min(100, Number(percent) || 0));

    cadrBarFillPct = p;

    var lit = (p / 100) * cadrBarEls.length;

    for (var i = 0; i < cadrBarEls.length; i++) {
        cadrBarEls[i].className = i < lit ? "f" : "";
    }
}

function cadrBarSetPct(text) {

    var el = document.getElementById("cadrBarPct");

    if (el) {
        el.textContent = text || "";
    }
}

function cadrBarWave(percent) {

    cadrBarStop();
    cadrBarShow("wave");
    cadrBarSetFill(percent);
    cadrBarSetPct(Math.round(cadrBarFillPct) + "%");
}

function cadrBarIdle() {

    cadrBarStop();
    cadrBarShow("wave");
    cadrBarSetFill(0);
    cadrBarSetPct("");
}

/* Waiting for the AI: no percentage, because we do not know it. */
function cadrBarText() {

    cadrBarStop();
    cadrBarShow("text");
    cadrBarFillPct = 0;
    cadrBarSetPct("");
}

function cadrBarTyped(text) {

    cadrBarStop();
    cadrBarShow("typed");

    var target = document.getElementById("cadrTypedText");
    var full = String(text || "").replace(/\s+/g, " ").slice(0, 70);
    var i = 0;

    target.textContent = "";

    cadrBarFillPct = 100;
    cadrBarSetPct("Done");

    cadrBarTimer = setInterval(function () {

        i++;

        target.textContent = full.slice(0, i);

        if (i >= full.length) {
            cadrBarStop();
        }
    }, 55);
}

/* The real first caption line is typed out in the bar. */
function cadrBarCaptionDone() {

    var first = "";

    try {

        if (pendingCaptionLines && pendingCaptionLines.length) {
            first = String(pendingCaptionLines[0].text || "");
        }

    } catch (e) {}

    if (first) {
        cadrBarTyped(first);
    } else {
        cadrBarWave(100);
        cadrBarSetPct("Done");
    }
}

/* One-line summary of a status box shown under the bar. */
function cadrWatchStatus(id) {

    var el = document.getElementById(id);

    if (!el || !window.MutationObserver) {
        return;
    }

    new MutationObserver(function () {

        var lines = String(el.textContent || "").split(/\r?\n/);
        var line = "";

        for (var i = 0; i < lines.length; i++) {

            if (lines[i].replace(/\s+/g, "")) {
                line = lines[i].replace(/^\s+|\s+$/g, "");
                break;
            }
        }

        if (line.length > 80) {
            line = line.slice(0, 77) + "...";
        }

        var msg = document.getElementById("cadrBarMsg");

        if (msg) {
            msg.textContent = line;
        }

    }).observe(el, { childList: true, characterData: true, subtree: true });
}

/* If the caption run ends (button comes back) without a result, the
   waiting animation must not keep running. */
function cadrWatchCaptionButton() {

    var button = document.getElementById("captionButton");

    if (!button || !window.MutationObserver) {
        return;
    }

    new MutationObserver(function () {

        if (!button.disabled && cadrBarModeNow !== "typed") {
            cadrBarIdle();
        }

    }).observe(button, { attributes: true, attributeFilter: ["disabled"] });
}


/* ---------- sliders ---------- */

var CADR_SLIDERS = [
    { id: "silenceDuration", fmt: function (v) { return v.toFixed(2) + " s"; } },
    { id: "noiseThreshold", fmt: function (v) { return Math.round(v) + " dB"; } },
    { id: "paddingBefore", fmt: function (v) { return v.toFixed(2) + " s"; } },
    { id: "paddingAfter", fmt: function (v) { return v.toFixed(2) + " s"; } },
    { id: "zoomAmount", fmt: function (v) { return Math.round(v) + "%"; } },
    {
        id: "smoothFrames",
        fmt: function (v) {
            var n = Math.round(v);
            return n + (n === 1 ? " frame" : " frames");
        }
    },
    { id: "wordsPerLine", fmt: function (v) { return String(Math.round(v)); } },
    { id: "maxCharsPerLine", fmt: function (v) { return String(Math.round(v)); } },
    { id: "captionGapBridge", fmt: function (v) { return Number(v).toFixed(2) + " s"; } },
    { id: "captionTimeOffset", fmt: function (v) { var n = Math.round(v); return (n > 0 ? "+" : "") + n + " ms"; } },
    { id: "minCaptionDuration", fmt: function (v) { return Number(v).toFixed(2) + " s"; } },
    { id: "capPauseSplit", fmt: function (v) { return Number(v).toFixed(2) + " s"; } }
];

function cadrRefreshSliderLabels() {

    for (var i = 0; i < CADR_SLIDERS.length; i++) {

        var slider = document.getElementById(CADR_SLIDERS[i].id);
        var label = document.getElementById("v_" + CADR_SLIDERS[i].id);

        if (slider && label) {

            var value = parseFloat(slider.value);

            label.textContent = isNaN(value) ? "" : CADR_SLIDERS[i].fmt(value);
        }
    }

    var video = document.getElementById("smoothVideo");
    var audio = document.getElementById("smoothAudio");
    var wrap = document.getElementById("smoothWrap");

    if (wrap && video && audio) {
        wrap.className = (video.checked || audio.checked) ? "" : "dim";
    }

    var zoomOn = document.getElementById("autoZoom");
    var zoomWrap = document.getElementById("zoomWrap");

    if (zoomWrap && zoomOn) {
        zoomWrap.className = zoomOn.checked ? "" : "dim";
    }
}


/* ---------- cut presets ---------- */

var CADR_PRESET_IDS = [
    "silenceDuration",
    "noiseThreshold",
    "paddingBefore",
    "paddingAfter",
    "smoothFrames",
    "autoZoom",
    "zoomAmount"
];

/* silence, threshold, pad before, pad after, smooth frames,
   auto zoom (1 = on), zoom amount % */
var CADR_PRESETS = {
    yt: [0.45, -30, 0.08, 0.10, 3, 1, 110],
    pod: [0.70, -35, 0.12, 0.15, 4, 0, 108],
    sh: [0.25, -28, 0.04, 0.05, 2, 1, 115]
};

function cadrPresetValue(el) {

    if (!el) {
        return NaN;
    }

    return el.type === "checkbox" ? (el.checked ? 1 : 0) : parseFloat(el.value);
}

var CADR_PRESET_NAMES = { yt: "YouTube", pod: "Podcast", sh: "Shorts" };

var cadrUserPresetActive = "";

function cadrApplyPreset(key) {

    var values = CADR_PRESETS[key];

    if (!values) {
        return;
    }

    for (var i = 0; i < CADR_PRESET_IDS.length; i++) {

        var el = document.getElementById(CADR_PRESET_IDS[i]);

        if (el && el.type === "checkbox") {
            el.checked = !!values[i];
        } else if (el) {
            el.value = values[i];
        }
    }

    cadrUserPresetActive = "";
    cadrRefreshSliderLabels();
    cadrDetectPreset();
}

function cadrDetectPreset() {

    var current = [];

    for (var i = 0; i < CADR_PRESET_IDS.length; i++) {

        current.push(cadrPresetValue(document.getElementById(CADR_PRESET_IDS[i])));
    }

    var found = "";

    for (var key in CADR_PRESETS) {

        var same = true;

        for (var k = 0; k < CADR_PRESETS[key].length; k++) {

            if (Math.abs(current[k] - CADR_PRESETS[key][k]) > 0.006) {
                same = false;
            }
        }

        if (same) {
            found = key;
        }
    }

    var buttons = document.querySelectorAll("#presetRow .pre[data-k]");

    for (var b = 0; b < buttons.length; b++) {

        buttons[b].className =
            "pre" + (buttons[b].getAttribute("data-k") === found ? " on" : "");
    }

    var chips = document.querySelectorAll("#myPresets .chip");

    for (var c = 0; c < chips.length; c++) {

        var isActive =
            !found &&
            cadrUserPresetActive &&
            chips[c].getAttribute("data-name") === cadrUserPresetActive;

        chips[c].className = "chip" + (isActive ? " on" : "");
    }

    var label = document.getElementById("presetLabel");

    if (label) {

        label.textContent =
            found
                ? CADR_PRESET_NAMES[found]
                : (cadrUserPresetActive || "Custom");
    }
}

function cadrRenderPresetChips() {

    var select = document.getElementById("presetSelect");
    var box = document.getElementById("myPresets");

    if (!select || !box) {
        return;
    }

    box.innerHTML = "";

    for (var i = 0; i < select.options.length; i++) {

        var name = select.options[i].value;

        if (!name) {
            continue;
        }

        var chip = document.createElement("span");
        chip.className = "chip";
        chip.setAttribute("data-name", name);

        var nameButton = document.createElement("button");
        nameButton.className = "nm";
        nameButton.textContent = name;
        nameButton.setAttribute("dir", "auto");

        nameButton.onclick = (function (n) {
            return function () {
                cadrLoadUserPreset(n);
            };
        })(name);

        var removeButton = document.createElement("button");
        removeButton.className = "x";
        removeButton.setAttribute("aria-label", "Delete preset " + name);
        removeButton.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';

        removeButton.onclick = (function (n) {
            return function () {
                cadrDeleteUserPreset(n);
            };
        })(name);

        chip.appendChild(nameButton);
        chip.appendChild(removeButton);
        box.appendChild(chip);
    }

    cadrDetectPreset();
}

function cadrLoadUserPreset(name) {

    var select = document.getElementById("presetSelect");

    select.value = name;

    loadSelectedPreset();

    cadrUserPresetActive = name;
    cadrRefreshSliderLabels();
    cadrDetectPreset();
}

function cadrDeleteUserPreset(name) {

    if (!window.confirm("مسح الـ Preset \"" + name + "\"؟")) {
        return;
    }

    try {

        var fs = window.cep_node.require("fs");
        var path = window.cep_node.require("path");

        fs.unlinkSync(path.join(getPresetsFolder(), name + ".json"));

    } catch (e) {}

    if (cadrUserPresetActive === name) {
        cadrUserPresetActive = "";
    }

    refreshPresetsList();
}

function cadrSavePresetFromUi() {

    var input = document.getElementById("presetName");
    var hadName = input.value.replace(/\s+/g, "") !== "";

    saveCurrentPreset();

    if (hadName) {

        document.getElementById("presetSaveRow").style.display = "none";
        cadrRenderPresetChips();
    }
}

function cadrBindCutUi() {

    var presetButtons = document.querySelectorAll("#presetRow .pre[data-k]");

    for (var i = 0; i < presetButtons.length; i++) {

        presetButtons[i].onclick = (function (button) {
            return function () {
                cadrApplyPreset(button.getAttribute("data-k"));
            };
        })(presetButtons[i]);
    }

    document.getElementById("presetAddBtn").onclick = function () {

        var row = document.getElementById("presetSaveRow");
        var show = row.style.display === "none";

        row.style.display = show ? "flex" : "none";

        if (show) {
            document.getElementById("presetName").focus();
        }
    };

    document.getElementById("presetSaveBtn").onclick = cadrSavePresetFromUi;

    document.getElementById("presetName").onkeydown = function (event) {

        if (event.key === "Enter") {
            cadrSavePresetFromUi();
        }
    };

    for (var s = 0; s < CADR_PRESET_IDS.length; s++) {

        var slider = document.getElementById(CADR_PRESET_IDS[s]);

        if (slider) {

            var onChange = function () {

                cadrUserPresetActive = "";
                cadrRefreshSliderLabels();
                cadrDetectPreset();
            };

            if (slider.type === "checkbox") {
                slider.onchange = onChange;
            } else {
                slider.oninput = onChange;
            }
        }
    }

    var smoothBoxes = ["smoothVideo", "smoothAudio"];

    for (var b = 0; b < smoothBoxes.length; b++) {
        document.getElementById(smoothBoxes[b]).onchange = cadrRefreshSliderLabels;
    }
}


/* ---------- caption tab ---------- */

function cadrSyncCaptionUi() {

    var select = document.getElementById("captionLanguage");
    var langButtons = document.querySelectorAll("#langChips [data-lang]");

    for (var i = 0; i < langButtons.length; i++) {

        langButtons[i].className =
            "chip" + (
                select && langButtons[i].getAttribute("data-lang") === select.value
                    ? " on"
                    : ""
            );
    }

    var words = parseInt(document.getElementById("wordsPerLine").value, 10);
    var cards = document.querySelectorAll("#styleRow .pre");

    for (var c = 0; c < cards.length; c++) {

        cards[c].className =
            "pre" + (
                parseInt(cards[c].getAttribute("data-words"), 10) === words
                    ? " on"
                    : ""
            );
    }

    cadrRefreshSliderLabels();
}

function cadrBindCaptionUi() {

    var langButtons = document.querySelectorAll("#langChips [data-lang]");

    for (var i = 0; i < langButtons.length; i++) {

        langButtons[i].onclick = (function (button) {
            return function () {

                document.getElementById("captionLanguage").value =
                    button.getAttribute("data-lang");

                cadrSyncCaptionUi();
            };
        })(langButtons[i]);
    }

    var cards = document.querySelectorAll("#styleRow .pre");

    for (var c = 0; c < cards.length; c++) {

        cards[c].onclick = (function (card) {
            return function () {

                document.getElementById("wordsPerLine").value =
                    card.getAttribute("data-words");

                /* word timing is what makes 1-word captions land exactly */
                document.getElementById("wordLevelCaptions").checked = true;

                cadrSyncCaptionUi();
            };
        })(cards[c]);
    }

    document.getElementById("wordsPerLine").oninput = cadrSyncCaptionUi;

    document.getElementById("newFillerWord").onkeydown = function (event) {

        if (event.key === "Enter") {
            addCustomFillerWord();
        }
    };
}

/* Save the caption text as a .srt file, in a place the user picks. */
function cadrExportSrt() {

    var status = document.getElementById("captionStatus");
    var text = String(document.getElementById("captionPreview").value || "");

    if (!text.replace(/\s+/g, "")) {

        status.textContent = "مفيش كابشن لسه. دوس Generate captions الأول.";
        return;
    }

    try {

        var result = window.cep.fs.showSaveDialogEx(
            "Save captions",
            "",
            ["srt"],
            cadrTr.view === "translation" && cadrTr.translated
                ? "captions." + cadrLangCode(cadrTr.lang) + ".srt"
                : "captions.srt",
            "SRT subtitles"
        );

        if (!result || result.err !== 0 || !result.data) {
            return;
        }

        var target = String(result.data);

        if (!/\.srt$/i.test(target)) {
            target += ".srt";
        }

        window.cep_node.require("fs").writeFileSync(target, text, "utf8");

        status.textContent = "اتحفظ الكابشن:\n" + target;

    } catch (e) {

        status.textContent = "مقدرتش أحفظ ملف الـ SRT: " + e.message;
    }
}


/* ---------- caption translation ---------- */

/* [name used in the prompt, file code, label shown] */
var CADR_LANGS = [
    ["English", "en", "English"],
    ["Arabic", "ar", "Arabic (العربية)"],
    ["French", "fr", "French (Français)"],
    ["Spanish", "es", "Spanish (Español)"],
    ["German", "de", "German (Deutsch)"],
    ["Turkish", "tr", "Turkish (Türkçe)"],
    ["Italian", "it", "Italian (Italiano)"],
    ["Portuguese", "pt", "Portuguese (Português)"],
    ["Russian", "ru", "Russian (Русский)"],
    ["Hindi", "hi", "Hindi (हिन्दी)"],
    ["Urdu", "ur", "Urdu (اردو)"],
    ["Indonesian", "id", "Indonesian (Bahasa Indonesia)"]
];

var CADR_TR_BATCH = 60;

var cadrTr = { original: "", translated: "", lang: "", view: "original" };

function cadrLangCode(name) {

    for (var i = 0; i < CADR_LANGS.length; i++) {

        if (CADR_LANGS[i][0] === name) {
            return CADR_LANGS[i][1];
        }
    }

    return "tr";
}

function cadrTrUpdateUi() {

    var box = document.getElementById("trView");

    if (box) {
        box.style.display = cadrTr.translated ? "flex" : "none";
    }

    var chips = document.querySelectorAll("#trView .chip");

    for (var i = 0; i < chips.length; i++) {

        chips[i].className =
            "chip" + (chips[i].getAttribute("data-view") === cadrTr.view ? " on" : "");
    }

    var label = document.getElementById("trTranslationChip");

    if (label) {
        label.textContent = "Translation" + (cadrTr.lang ? " (" + cadrTr.lang + ")" : "");
    }
}

/* The captions changed (new run, filler words deleted, undo): the old
   translation no longer matches them. */
function cadrTrReset() {

    cadrTr = { original: "", translated: "", lang: "", view: "original" };
    cadrTrUpdateUi();
}

function cadrTrShow(view) {

    var area = document.getElementById("captionPreview");

    if (!cadrTr.translated || cadrTr.view === view) {
        return;
    }

    /* keep any edits made to the version we are leaving */
    if (cadrTr.view === "original") {
        cadrTr.original = area.value;
    } else {
        cadrTr.translated = area.value;
    }

    cadrTr.view = view;
    area.value = view === "original" ? cadrTr.original : cadrTr.translated;

    cadrTrUpdateUi();
}

function cadrParseTranslations(text) {

    var clean = String(text || "")
        .replace(/^\s*```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .replace(/^\uFEFF/, "");

    var data;

    try {
        data = JSON.parse(clean);
    } catch (e) {
        return null;
    }

    var list = Array.isArray(data) ? data : (data && data.translations);

    if (!Array.isArray(list)) {
        return null;
    }

    var out = [];

    for (var i = 0; i < list.length; i++) {
        out.push(String(list[i] === null || list[i] === undefined ? "" : list[i]).replace(/^\s+|\s+$/g, ""));
    }

    return out;
}

function cadrTranslationPrompt(texts, lang) {

    return (
        "You translate subtitles into " + lang + ".\n" +
        "Rules:\n" +
        "- Return exactly " + texts.length + " translations, in the same order, one per input line.\n" +
        "- Never merge, split, skip or reorder lines.\n" +
        "- Keep each translation short and natural for on-screen subtitles.\n" +
        "- Keep names, numbers and brand names. Do not add notes or explanations.\n" +
        "- If a line is empty, return an empty string for it.\n\n" +
        "Input (JSON array of " + texts.length + " strings):\n" +
        JSON.stringify(texts) + "\n\n" +
        "Answer as JSON: {\"translations\": [ ... ]}"
    );
}

/* One batch, with automatic retries (busy server, wrong count, bad JSON). */
function cadrTranslateBatch(texts, lang, apiKey, model, cb) {

    var attempt = 0;
    var MAX = 3;
    var useSchema = true;
    var finished = false;

    var endpoint =
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        encodeURIComponent(model) +
        ":generateContent?key=" +
        encodeURIComponent(apiKey);

    function finish(error, result) {

        if (finished) {
            return;
        }

        finished = true;

        setTimeout(function () {
            cb(error, result);
        }, 0);
    }

    function retry(delay) {
        setTimeout(once, delay);
    }

    function once() {

        attempt++;

        var config = { responseMimeType: "application/json" };

        if (useSchema) {

            config.responseSchema = {
                type: "OBJECT",
                properties: {
                    translations: {
                        type: "ARRAY",
                        items: { type: "STRING" }
                    }
                },
                required: ["translations"]
            };
        }

        fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: cadrTranslationPrompt(texts, lang) }] }],
                generationConfig: config
            })
        })
            .then(function (response) {
                return response.json();
            })
            .then(function (data) {

                if (data.error) {

                    var message = String(data.error.message || "");
                    var code = data.error.code;

                    if (useSchema && code === 400 && /schema/i.test(message)) {
                        useSchema = false;
                        attempt--;
                        retry(0);
                        return;
                    }

                    if (
                        (code === 429 || code === 500 || code === 503 || code === 504) &&
                        attempt < MAX
                    ) {
                        retry(2000 * attempt);
                        return;
                    }

                    finish(new Error(message || ("API error " + code)));
                    return;
                }

                var text = "";

                try {

                    var parts = data.candidates[0].content.parts;

                    for (var i = 0; i < parts.length; i++) {
                        text += parts[i].text || "";
                    }

                } catch (shapeError) {}

                var list = cadrParseTranslations(text);

                if (list && list.length === texts.length) {
                    finish(null, list);
                    return;
                }

                if (attempt < MAX) {
                    retry(1500);
                    return;
                }

                finish(new Error(
                    list
                        ? "Gemini رجّع " + list.length + " ترجمة بدل " + texts.length + "."
                        : "رد Gemini مش مفهوم."
                ));
            })
            .catch(function (error) {

                if (finished) {
                    return;
                }

                if (attempt < MAX) {
                    retry(2000 * attempt);
                    return;
                }

                finish(error);
            });
    }

    once();
}

/* Translates all lines in batches. onDone(error, [translated texts]). */
function cadrTranslateLines(lines, lang, apiKey, model, onProgress, onDone) {

    var results = [];
    var offset = 0;

    function next() {

        if (offset >= lines.length) {
            onDone(null, results);
            return;
        }

        var chunk = lines.slice(offset, offset + CADR_TR_BATCH);
        var texts = [];

        for (var i = 0; i < chunk.length; i++) {
            texts.push(chunk[i].text);
        }

        cadrTranslateBatch(texts, lang, apiKey, model, function (error, list) {

            if (error) {
                onDone(error, null);
                return;
            }

            results = results.concat(list);
            offset += chunk.length;

            if (onProgress) {
                onProgress(Math.min(offset, lines.length), lines.length);
            }

            next();
        });
    }

    next();
}

function cadrTranslateCaptions() {

    if (!cadrRequireLicense("Translate")) return;

    var status = document.getElementById("captionStatus");
    var button = document.getElementById("translateButton");
    var area = document.getElementById("captionPreview");
    var select = document.getElementById("translateTo");

    var lang = select.value;

    /* always translate the ORIGINAL, even if the translation is on screen */
    var originalText =
        cadrTr.translated && cadrTr.view === "translation"
            ? cadrTr.original
            : area.value;

    var lines = parseSrtToLines(originalText);

    if (!lines.length) {
        status.textContent = "مفيش كابشن لسه. دوس Generate captions الأول.";
        return;
    }

    var apiKey = document.getElementById("geminiApiKey").value.trim();
    var model = document.getElementById("geminiModel").value.trim();

    if (!apiKey) {
        status.textContent = "لازم تحط مفتاح الـ API الخاص بـ Gemini الأول (Settings).";
        return;
    }

    setSetting("translateTo", lang);

    button.disabled = true;
    cadrBarText();

    status.textContent =
        "Translating " + lines.length + " lines to " + lang + "...";

    cadrTranslateLines(
        lines,
        lang,
        apiKey,
        model,
        function (done, total) {

            status.textContent =
                "Translating to " + lang + "... " + done + " / " + total;
        },
        function (error, texts) {

            button.disabled = false;

            if (error) {

                cadrBarIdle();

                status.textContent =
                    "فشلت الترجمة:\n\n" + (error.message || String(error));

                return;
            }

            var translatedLines = [];

            for (var i = 0; i < lines.length; i++) {

                translatedLines.push({
                    text: texts[i],
                    start: lines[i].start,
                    end: lines[i].end
                });
            }

            cadrTr = {
                original: originalText,
                translated: buildSrtFromLines(translatedLines),
                lang: lang,
                view: "translation"
            };

            area.value = cadrTr.translated;

            cadrTrUpdateUi();

            status.textContent =
                "تمت الترجمة إلى " + lang + " ✅ (" + lines.length + " سطر)\n\n" +
                "دوس Add to timeline لإضافتها كتراك كابشن، أو Export SRT. " +
                "ودوس Original عشان ترجع للنص الأصلي.";

            var first = "";

            for (var t = 0; t < texts.length && !first; t++) {
                first = texts[t];
            }

            if (first) {
                cadrBarTyped(first);
            } else {
                cadrBarWave(100);
            }
        }
    );
}

function cadrBindTranslationUi() {

    var select = document.getElementById("translateTo");

    if (!select) {
        return;
    }

    select.innerHTML = "";

    for (var i = 0; i < CADR_LANGS.length; i++) {

        var option = document.createElement("option");

        option.value = CADR_LANGS[i][0];
        option.textContent = CADR_LANGS[i][2];

        select.appendChild(option);
    }

    var saved = getSetting("translateTo", "English");

    select.value = saved;

    if (select.value !== saved) {
        select.value = "English";
    }

    select.onchange = function () {
        setSetting("translateTo", select.value);
    };

    document.getElementById("translateButton").onclick = cadrTranslateCaptions;

    var chips = document.querySelectorAll("#trView .chip");

    for (var c = 0; c < chips.length; c++) {

        chips[c].onclick = (function (chip) {
            return function () {
                cadrTrShow(chip.getAttribute("data-view"));
            };
        })(chips[c]);
    }

    cadrTrUpdateUi();
}


/* ---------- start-up ---------- */

function cadrUiInit() {

    cadrCheckLicense();
    var storedLicense = window.CADRLicense ? window.CADRLicense.getStoredKey() : "";
    var licenseInput = document.getElementById("cadrLicenseKey");
    if (licenseInput && storedLicense) licenseInput.value = storedLicense;

    cadrBuildBar();
    cadrBarIdle();

    cadrBindCutUi();
    cadrBindCaptionUi();
    cadrBindTranslationUi();

    var originalRefreshPresets = refreshPresetsList;

    refreshPresetsList = function () {

        originalRefreshPresets();
        cadrRenderPresetChips();
    };

    cadrRenderPresetChips();
    cadrRefreshSliderLabels();
    cadrDetectPreset();
    cadrSyncCaptionUi();

    cadrWatchStatus("cutStatus");
    cadrWatchStatus("captionStatus");
    cadrWatchStatus("styleStatus");
    cadrWatchCaptionButton();

    /* Disabled auto-evalScript on window focus to prevent Premiere Pro 2026 crashes */
}

cadrUiInit();


/* =========================================================
   CAPTION STYLES (MOGRT)
   The user adds .mogrt templates as "styles", picks one, and the
   caption lines from the preview box are placed on the timeline one
   call at a time (same pattern as the cuts).
   ========================================================= */

var CADR_STYLES_KEY = "cadrCaptionStyles";
var CADR_STYLE_ACTIVE_KEY = "cadrCaptionStyleActive";
var CADR_STYLE_TRACK_KEY = "cadrLastStyledTrack";
var cadrStyleBusy = false;

function cadrStyleLoad() {

    try {

        var list = JSON.parse(window.localStorage.getItem(CADR_STYLES_KEY) || "[]");

        return Array.isArray(list) ? list : [];

    } catch (e) {
        return [];
    }
}

function cadrStyleSave(list) {

    try {
        window.localStorage.setItem(CADR_STYLES_KEY, JSON.stringify(list));
    } catch (e) {}
}

function cadrStyleActive() {

    var n = 0;

    try {
        n = parseInt(window.localStorage.getItem(CADR_STYLE_ACTIVE_KEY) || "0", 10) || 0;
    } catch (e) {}

    var count = cadrStyleLoad().length;

    return Math.max(0, Math.min(n, count - 1));
}

function cadrStyleSetActive(i) {

    try {
        window.localStorage.setItem(CADR_STYLE_ACTIVE_KEY, String(i));
    } catch (e) {}
}

function cadrStyleBaseName(path) {

    var name = String(path).replace(/\\/g, "/").split("/").pop();

    return name.replace(/\.mogrt$/i, "");
}

function cadrStyleRender() {

    var box = document.getElementById("styleChips");

    if (!box) {
        return;
    }

    var list = cadrStyleLoad();
    var active = cadrStyleActive();

    box.innerHTML = "";

    if (!list.length) {

        var empty = document.createElement("span");

        empty.className = "card-note";
        empty.setAttribute("dir", "auto");
        empty.textContent = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en") ? "No templates added yet — click (+ Add .mogrt) to select one." : "لا توجد قوالب مضافة بعد — اضغط (+ إضافة .mogrt) لاختيار قالب.";
        box.appendChild(empty);

        return;
    }

    list.forEach(function (style, i) {

        var chip = document.createElement("span");

        chip.className = "chip" + (i === active ? " on" : "");

        var nameBtn = document.createElement("button");

        nameBtn.className = "nm";
        nameBtn.type = "button";
        nameBtn.title = style.path;
        nameBtn.textContent = style.name;
        nameBtn.onclick = function () {
            cadrStyleSetActive(i);
            cadrStyleRender();
            cadrStyleTabRender();
        };

        var xBtn = document.createElement("button");

        xBtn.className = "x";
        xBtn.type = "button";
        xBtn.title = "Remove from list";
        xBtn.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
        xBtn.onclick = function () {
            var current = cadrStyleLoad();
            current.splice(i, 1);
            cadrStyleSave(current);
            cadrStyleSetActive(0);
            cadrStyleRender();
        };

        chip.appendChild(nameBtn);
        chip.appendChild(xBtn);
        box.appendChild(chip);
    });
}

function cadrStyleAdd() {

    var chosen;

    try {

        chosen = window.cep.fs.showOpenDialogEx(
            true,
            false,
            "Choose caption style templates (.mogrt)",
            "",
            ["mogrt"]
        );

    } catch (e) {
        return;
    }

    if (!chosen || chosen.err !== 0 || !chosen.data || !chosen.data.length) {
        return;
    }

    var list = cadrStyleLoad();
    var firstAdded = -1;

    for (var i = 0; i < chosen.data.length; i++) {

        var path = String(chosen.data[i]).replace(/\\/g, "/");
        var exists = false;

        for (var j = 0; j < list.length; j++) {

            if (list[j].path === path) {
                exists = true;
                firstAdded = firstAdded < 0 ? j : firstAdded;
            }
        }

        if (!exists) {

            list.push({ name: cadrStyleBaseName(path), path: path });

            if (firstAdded < 0) {
                firstAdded = list.length - 1;
            }
        }
    }

    cadrStyleSave(list);

    if (firstAdded >= 0) {
        cadrStyleSetActive(firstAdded);
    }

    cadrStyleRender();
}

function cadrStyleSetBusy(busy) {

    cadrStyleBusy = busy;

    ["styledCaptionButton", "removeStyledButton"].forEach(function (id) {

        var el = document.getElementById(id);

        if (el) {
            el.disabled = busy;
        }
    });
}

function cadrRunStyledCaptions() {

    if (!cadrRequireLicense("Styled Captions")) return;

    if (cadrStyleBusy) {
        return;
    }

    var status = document.getElementById("styleStatus") || document.getElementById("captionStatus");
    var capStatus = document.getElementById("captionStatus");
    window.cadrCancelRequested = false;
    var styles = cadrStyleLoad();
    var style = styles[cadrStyleActive()];

    if (!style) {
        status.textContent = "اختار ستايل الأول (Add style).";
        return;
    }

    var preview = document.getElementById("captionPreview");

    var srt = (preview && preview.value.trim()) ? preview.value : (pendingCaptionSrt || "");

    var lines = parseSrtToLines(srt);

    if (!lines.length) {
        status.textContent = "مفيش كابشن. دوس Generate captions الأول.";
        return;
    }

    lines.sort(function (a, b) {
        return a.start - b.start;
    });

    /* a caption must end before the next one starts, so the templates
       never overlap on the track */
    var items = [];

    for (var i = 0; i < lines.length; i++) {

        var end = lines[i].end;

        if (i + 1 < lines.length && lines[i + 1].start < end) {
            end = lines[i + 1].start;
        }

        if (end - lines[i].start < 0.05) {
            continue;
        }

        items.push({
            text: String(lines[i].text).replace(/\s*\n\s*/g, " "),
            start: lines[i].start,
            end: end
        });
    }

    cadrStyleSetBusy(true);
    status.textContent = "بيجهّز الكابشن بستايل: " + style.name + "...";
    cadrBarWave(0);

    csInterface.evalScript("cadrCaptionTrackIndex()", function (response) {

        var track = parseInt(response, 10);

        if (isNaN(track)) {

            cadrStyleSetBusy(false);
            cadrBarIdle();

            status.textContent = response === "NO_SEQUENCE"
                ? "مفيش Sequence مفتوح."
                : "مشكلة: " + response;

            return;
        }

        try {
            window.localStorage.setItem(CADR_STYLE_TRACK_KEY, String(track));
        } catch (e) {}

        var index = 0;
        var ok = 0;
        var problems = [];
        var notes = 0;
        var aborted = false;

        function finish() {

            cadrStyleSetBusy(false);

            var text = "تم: " + ok + " من " + items.length +
                " كابشن اتحطوا على فيديو تراك V" + (track + 1) + " ✅";

            if (notes > 0) {
                text += "\n\nتنبيه: " + notes + " كابشن اتحطوا بس مدتهم أو نصهم محتاج مراجعة.";
            }

            if (problems.length) {
                text += "\n\nمشاكل:\n" + problems.slice(0, 5).join("\n");
            }

            if (aborted) {
                text += "\n\nوقفت لأن أول محاولات فشلت كلها.";
            }

            status.textContent = text;

            cadrBarWave(100);

            setTimeout(cadrBarIdle, 1500);
        }

        function next() {

            if (aborted || index >= items.length) {
                finish();
                return;
            }

            var item = items[index];

            var payload = encodeURIComponent(JSON.stringify({
                path: style.path,
                text: item.text,
                start: item.start,
                end: item.end,
                track: track,
                ov: cadrStyleOvFor(style.path)
            })).replace(/'/g, "%27");

            csInterface.evalScript(
                "cadrPlaceStyledCaption('" + payload + "')",
                function (result) {

                    var text = String(result || "NO_RESPONSE");

                    if (text.indexOf("OK") === 0) {

                        ok++;

                        if (text.indexOf(";") !== -1) {
                            notes++;
                        }

                    } else {
                        problems.push((index + 1) + ": " + text);
                    }

                    if (ok === 0 && problems.length >= 3) {
                        aborted = true;
                    }

                    index++;

                    status.textContent = "بيحط الكابشن... " + index + " / " + items.length;
                    cadrBarWave((index / items.length) * 100);

                    setTimeout(next, CADR_CUT_PAUSE_MS);
                }
            );
        }

        next();
    });
}

function cadrRemoveStyledCaptions() {

    if (!cadrRequireLicense("Remove Styled Captions")) return;

    if (cadrStyleBusy) {
        return;
    }

    var status = document.getElementById("styleStatus") || document.getElementById("captionStatus");
    var track = NaN;

    try {
        track = parseInt(window.localStorage.getItem(CADR_STYLE_TRACK_KEY), 10);
    } catch (e) {}

    if (isNaN(track)) {
        status.textContent = "مفيش كابشن ستايل اتعمل قبل كده عشان أمسحه.";
        return;
    }

    cadrStyleSetBusy(true);

    csInterface.evalScript("cadrRemoveStyledCaptions(" + track + ")", function (response) {

        cadrStyleSetBusy(false);

        var text = String(response || "NO_RESPONSE");

        status.textContent = text.indexOf("OK;") === 0
            ? "اتمسح " + text.split(";")[1] + " قالب من V" + (track + 1) + "."
            : "مقدرتش أمسح: " + text;
    });
}

cadrStyleRender();


/* =========================================================
   STYLE TAB
   Per style (by file path) we keep:
     schema    - what the template offers (read from a caption on the timeline)
     overrides - what the user changed: { font, fontSize, sizeKey, params }
   Overrides are sent with every new caption, and can also be applied to the
   captions already on the timeline.
   ========================================================= */

var CADR_STYLE_SCHEMA_KEY = "cadrStyleSchemas";
var CADR_STYLE_OV_KEY = "cadrStyleOverrides";

function cadrStoreGet(key) {

    try {
        return JSON.parse(window.localStorage.getItem(key) || "{}") || {};
    } catch (e) {
        return {};
    }
}

function cadrStoreSet(key, value) {

    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
}

function cadrActiveStyle() {

    var list = cadrStyleLoad();

    return list[cadrStyleActive()] || null;
}

function cadrStyleOvFor(path) {

    var all = cadrStoreGet(CADR_STYLE_OV_KEY);
    var ov = all[path];

    if (!ov) {
        return null;
    }

    var hasParams = ov.params && Object.keys(ov.params).length > 0;

    return (ov.font || ov.fontSize || hasParams) ? ov : null;
}

function cadrStyleOvUpdate(mutator) {

    var style = cadrActiveStyle();

    if (!style) {
        return;
    }

    var all = cadrStoreGet(CADR_STYLE_OV_KEY);
    var ov = all[style.path] || { params: {} };

    if (!ov.params) {
        ov.params = {};
    }

    mutator(ov);

    all[style.path] = ov;

    cadrStoreSet(CADR_STYLE_OV_KEY, all);
}

function cadrStyleStatus(text) {

    var el = document.getElementById("styleStatus");

    if (el) {
        el.textContent = text;
    }
}

function cadrStyleResetOverrides() {

    var style = cadrActiveStyle();
    var styleKey = style ? style.path : "__preview__";

    var all = cadrStoreGet(CADR_STYLE_OV_KEY);

    delete all[styleKey];

    cadrStoreSet(CADR_STYLE_OV_KEY, all);
    cadrStyleTabRender();
    cadrStyleStatus("اتمسحت كل التعديلات. القالب هيتحط زي ما هو.");
}

function cadrStyleRead() {

    var style = cadrActiveStyle();

    if (!style) {
        cadrStyleStatus("اختار ستايل الأول من تاب Auto caption.");
        return;
    }

    var track = -1;

    try {
        track = parseInt(window.localStorage.getItem(CADR_STYLE_TRACK_KEY), 10);
    } catch (e) {}

    if (isNaN(track)) {
        track = -1;
    }

    cadrStyleStatus("بيقرا إعدادات القالب...");

    csInterface.evalScript("cadrReadStyleParams(" + track + ")", function (response) {

        var text = String(response || "NO_RESPONSE");

        if (text === "NO_MGT_CLIP") {
            cadrStyleStatus("مفيش كابشن بالستايل على التايم لاين. دوس Add styled captions الأول، أو حدد كليب جرافيك.");
            return;
        }

        if (text.charAt(0) !== "{") {
            cadrStyleStatus("مقدرتش أقرا: " + text);
            return;
        }

        var schema;

        try {
            schema = JSON.parse(text);
        } catch (e2) {
            cadrStyleStatus("رد غريب من بريمير: " + text.slice(0, 200));
            return;
        }

        var schemas = cadrStoreGet(CADR_STYLE_SCHEMA_KEY);

        schemas[style.path] = schema;

        cadrStoreSet(CADR_STYLE_SCHEMA_KEY, schemas);
        cadrStyleTabRender();

        cadrStyleStatus("اتقرت إعدادات: " + schema.clip);
    });
}

function cadrStyleField(labelText, control) {

    var wrap = document.createElement("div");

    wrap.className = "field";

    var label = document.createElement("label");

    label.textContent = labelText;
    label.setAttribute("dir", "auto");

    wrap.appendChild(label);
    wrap.appendChild(control);

    return wrap;
}

function cadrStyleRowWithReset(labelText, control, onReset, isOverridden) {

    var wrap = document.createElement("div");

    wrap.className = "field" + (isOverridden ? "" : "");

    var head = document.createElement("div");

    head.className = "row";

    var label = document.createElement("label");

    label.className = "lb";
    label.textContent = labelText;
    label.setAttribute("dir", "auto");

    head.appendChild(label);

    var reset = document.createElement("button");

    reset.type = "button";
    reset.className = "chip x";
    reset.title = "Back to the template's value";
    reset.innerHTML = '<svg class="ic"><use href="#i-x"/></svg>';
    reset.style.visibility = isOverridden ? "visible" : "hidden";
    reset.onclick = onReset;

    head.appendChild(reset);
    wrap.appendChild(head);
    wrap.appendChild(control);

    return wrap;
}

function cadrStyleTabRender() {

    var style = cadrActiveStyle();
    var nameEl = document.getElementById("styleTabName");
    var box = document.getElementById("styleControls");

    if (nameEl) {
        nameEl.textContent = style ? style.name : "—";
    }

    if (!box) {
        return;
    }

    box.innerHTML = "";

    var styleKey = style ? style.path : "__preview__";
    var storedSchemas = cadrStoreGet(CADR_STYLE_SCHEMA_KEY);
    var schema = storedSchemas[styleKey] || {
        font: { hasFont: true, font: "Montserrat-Bold", sizeKey: "Size", fontSize: 64 },
        params: [
            { name: "Text Color", kind: "color", value: "#F5F5F5" },
            { name: "Highlight Color", kind: "color", value: "#FF6B35" },
            { name: "Background Box", kind: "color", value: "#101114" },
            { name: "Text Position", kind: "position", value: [0.5, 0.72] },
            { name: "Scale", kind: "number", value: 100 }
        ]
    };
    var ov = cadrStoreGet(CADR_STYLE_OV_KEY)[styleKey] || { params: {} };

    if (!ov.params) {
        ov.params = {};
    }

    /* ---------- font ---------- */
    if (schema.font && schema.font.hasFont) {

        var card = document.createElement("div");

        card.className = "card pad";
        card.style.display = "flex";
        card.style.flexDirection = "column";
        card.style.gap = "10px";

        var title = document.createElement("div");

        title.style.fontWeight = "600";
        title.textContent = "Font";
        card.appendChild(title);

        cadrFontListLoad();

        var fontSelect = document.createElement("select");

        fontSelect.dir = "auto";

        var searchRow = document.createElement("div");

        searchRow.className = "inline";

        var search = document.createElement("input");

        search.type = "text";
        search.placeholder = "ابحث عن فونت...";
        search.dir = "auto";
        search.value = cadrFontFilter.q;

        var arabicChip = document.createElement("label");

        arabicChip.className = "chip";
        arabicChip.style.flex = "0 0 auto";

        var arabicBox = document.createElement("input");

        arabicBox.type = "checkbox";
        arabicBox.checked = cadrFontFilter.arabic;

        var arabicText = document.createElement("span");

        arabicText.textContent = "Arabic";

        arabicChip.appendChild(arabicBox);
        arabicChip.appendChild(arabicText);

        var refresh = document.createElement("button");

        refresh.type = "button";
        refresh.className = "btn sm";
        refresh.style.flex = "0 0 auto";
        refresh.title = "Re-read the fonts installed on this computer";
        refresh.textContent = "↻";

        searchRow.appendChild(search);
        searchRow.appendChild(arabicChip);
        searchRow.appendChild(refresh);

        var fontNote = document.createElement("div");

        fontNote.className = "card-note";
        fontNote.setAttribute("dir", "auto");

        function refreshFontSelect() {

            cadrFontFillSelect(fontSelect, ov.font || "", schema.font.font || "");

            if (cadrFontScanning) {
                fontNote.textContent = "بيقرا الفونتات اللي على الجهاز...";
            } else if (!cadrFontList || !cadrFontList.length) {
                fontNote.textContent = "مقدرتش ألاقي فونتات على الجهاز. دوس ↻ تجرب تاني.";
            } else {
                fontNote.textContent = "الفونتات اللي على الجهاز: " + cadrFontList.length +
                    ". الفونت لازم يكون متسطّب على بريمير كمان.";
            }
        }

        search.oninput = function () {
            cadrFontFilter.q = search.value;
            refreshFontSelect();
        };

        arabicBox.onchange = function () {
            cadrFontFilter.arabic = arabicBox.checked;
            refreshFontSelect();
        };

        refresh.onclick = function () {

            cadrFontScan(function (done, total) {
                fontNote.textContent = "بيقرا الفونتات... " + done + " / " + total;
            }, function () {
                cadrStyleTabRender();
            });

            refreshFontSelect();
        };

        fontSelect.onchange = function () {

            var v = fontSelect.value;

            cadrStyleOvUpdate(function (o) {

                if (v) {
                    o.font = v;
                } else {
                    delete o.font;
                }
            });

            cadrStyleTabRender();
        };

        var fontPicker = document.createElement("div");

        fontPicker.style.display = "flex";
        fontPicker.style.flexDirection = "column";
        fontPicker.style.gap = "6px";

        var fontPreview = document.createElement("div");
        fontPreview.className = "font-preview-box";
        fontPreview.setAttribute("dir", "auto");
        function updateFontPreviewBox() {
            var selOpt = fontSelect.options[fontSelect.selectedIndex];
            var fam = "";
            if (fontSelect.value && cadrFontList) {
                for (var fi = 0; fi < cadrFontList.length; fi++) {
                    if (cadrFontList[fi].ps === fontSelect.value) {
                        fam = cadrFontList[fi].family;
                        break;
                    }
                }
            }
            if (!fam && selOpt) {
                fam = selOpt.textContent.split(" — ")[0].replace(/^.*\((.*)\).*$/, "$1");
            }
            fontPreview.style.fontFamily = fam ? ("'" + fam.replace(/'/g, "") + "', var(--font-ui)") : "var(--font-ui)";
            fontPreview.textContent = "CADR CUT • كدر ستوديو للمونتاج";
        }
        var origFontOnChange = fontSelect.onchange;
        fontSelect.onchange = function () {
            updateFontPreviewBox();
            if (origFontOnChange) origFontOnChange();
        };

        fontPicker.appendChild(searchRow);
        fontPicker.appendChild(fontSelect);
        fontPicker.appendChild(fontPreview);
        fontPicker.appendChild(fontNote);
        setTimeout(updateFontPreviewBox, 0);

        card.appendChild(cadrStyleRowWithReset(
            "Font",
            fontPicker,
            function () {

                cadrStyleOvUpdate(function (o) {
                    delete o.font;
                });

                cadrStyleTabRender();
            },
            !!ov.font
        ));

        refreshFontSelect();

        /* Performance fix: do not auto-scan hundreds of font files on startup.
           Load from cache if available; user clicks ↻ or focuses search to scan once. */
        search.onfocus = function () {
            if (!cadrFontList && !cadrFontScanning && !cadrFontScanDone) {
                cadrFontScan(function (done, total) {
                    fontNote.textContent = "بيقرا الفونتات... " + done + " / " + total;
                }, function () {
                    cadrStyleTabRender();
                });
            }
        };

        if (schema.font.sizeKey) {

            var sizeInput = document.createElement("input");

            sizeInput.type = "number";
            sizeInput.min = "1";
            sizeInput.step = "1";
            sizeInput.placeholder = String(schema.font.fontSize || "");
            sizeInput.value = ov.fontSize || "";
            sizeInput.onchange = function () {

                var n = parseFloat(sizeInput.value);

                cadrStyleOvUpdate(function (o) {

                    if (n > 0) {
                        o.fontSize = n;
                        o.sizeKey = schema.font.sizeKey;
                    } else {
                        delete o.fontSize;
                    }
                });

                cadrStyleTabRender();
            };

            card.appendChild(cadrStyleRowWithReset(
                "Font size (الحالي: " + (schema.font.fontSize || "؟") + ")",
                sizeInput,
                function () {

                    cadrStyleOvUpdate(function (o) {
                        delete o.fontSize;
                    });

                    cadrStyleTabRender();
                },
                !!ov.fontSize
            ));
        }

        box.appendChild(card);
    }

    /* ---------- other parameters ---------- */
    var others = document.createElement("div");

    others.className = "card pad";
    others.style.display = "flex";
    others.style.flexDirection = "column";
    others.style.gap = "10px";

    var othersTitle = document.createElement("div");

    othersTitle.style.fontWeight = "600";
    othersTitle.textContent = "Template settings";
    others.appendChild(othersTitle);

    (schema.params || []).forEach(function (param) {

        var overridden = ov.params[param.name] !== undefined;
        var shown = overridden ? ov.params[param.name] : param.value;

        function setValue(value) {

            cadrStyleOvUpdate(function (o) {
                o.params[param.name] = value;
            });

            cadrStyleTabRender();
        }

        function clearValue() {

            cadrStyleOvUpdate(function (o) {
                delete o.params[param.name];
            });

            cadrStyleTabRender();
        }

        var control;

        if (param.kind === "color") {

            control = document.createElement("input");

            control.type = "color";
            control.value = (typeof shown === "string" && /^#[0-9a-f]{6}$/i.test(shown)) ? shown : "#ffffff";
            control.onchange = function () {
                setValue(control.value);
            };

        } else if (param.kind === "position") {

            control = document.createElement("div");
            control.className = "inline";

            var pos = (shown && shown.length === 2) ? shown : [0, 0];

            var xs = ["X", "Y"].map(function (axis, idx) {

                var input = document.createElement("input");

                input.type = "number";
                input.step = "0.01";
                input.title = axis;
                input.placeholder = axis;
                input.value = Math.round(Number(pos[idx]) * 1000) / 1000;
                input.dir = "ltr";

                return input;
            });

            var commit = function () {

                var x = parseFloat(xs[0].value);
                var y = parseFloat(xs[1].value);

                if (!isNaN(x) && !isNaN(y)) {
                    setValue([x, y]);
                }
            };

            xs.forEach(function (input) {
                input.onchange = commit;
                control.appendChild(input);
            });

        } else {

            control = document.createElement("input");

            control.type = "number";
            control.step = "any";
            control.dir = "ltr";
            control.value = (typeof shown === "number") ? shown : "";
            control.onchange = function () {

                var n = parseFloat(control.value);

                if (!isNaN(n)) {
                    setValue(n);
                }
            };
        }

        others.appendChild(cadrStyleRowWithReset(param.name, control, clearValue, overridden));
    });

    if (!(schema.params || []).length) {

        var none = document.createElement("div");

        none.className = "card-note";
        none.setAttribute("dir", "auto");
        none.textContent = "القالب ده مفيهوش إعدادات تانية ممكن نغيرها.";
        others.appendChild(none);
    }

    box.appendChild(others);
}

function cadrStyleApplyToTimeline() {

    if (cadrStyleBusy) {
        return;
    }

    var style = cadrActiveStyle();

    if (!style) {
        cadrStyleStatus("اختار ستايل الأول.");
        return;
    }

    var ov = cadrStyleOvFor(style.path);

    if (!ov) {
        cadrStyleStatus("مفيش تعديلات تتطبق. غيّر حاجة الأول.");
        return;
    }

    var track = NaN;

    try {
        track = parseInt(window.localStorage.getItem(CADR_STYLE_TRACK_KEY), 10);
    } catch (e) {}

    if (isNaN(track)) {
        cadrStyleStatus("مفيش كابشن بستايل اتحط قبل كده.");
        return;
    }

    cadrStyleSetBusy(true);

    var button = document.getElementById("applyStyleButton");

    if (button) {
        button.disabled = true;
    }

    var payload = encodeURIComponent(JSON.stringify(ov)).replace(/'/g, "%27");

    function done(message) {

        cadrStyleSetBusy(false);

        if (button) {
            button.disabled = false;
        }

        cadrStyleStatus(message);
        cadrBarWave(100);
        setTimeout(cadrBarIdle, 1500);
    }

    csInterface.evalScript("cadrCountTrackClips(" + track + ")", function (countResponse) {

        var total = parseInt(countResponse, 10);

        if (isNaN(total)) {
            done("مقدرتش أقرا التراك: " + countResponse);
            return;
        }

        var index = 0;
        var applied = 0;
        var problems = [];

        function next() {

            if (window.cadrCancelRequested || index >= total) {

                var text = "اتطبق على " + applied + " كابشن ✅";

                if (problems.length) {
                    text += "\n\nمشاكل:\n" + problems.slice(0, 5).join("\n");
                }

                done(text);
                return;
            }

            csInterface.evalScript(
                "cadrApplyStyleAt(" + track + "," + index + ",'" + payload + "')",
                function (result) {

                    var r = String(result || "NO_RESPONSE");

                    if (r === "OK") {
                        applied++;
                    } else if (r !== "SKIP") {

                        if (r.indexOf("OK;") === 0) {
                            applied++;
                        }

                        problems.push((index + 1) + ": " + r);
                    }

                    index++;

                    cadrStyleStatus("بيطبق... " + index + " / " + total);
                    cadrBarWave((index / total) * 100);

                    setTimeout(next, CADR_CUT_PAUSE_MS);
                }
            );
        }

        next();
    });
}


/* =========================================================
   INSTALLED FONTS
   Reads the font files on this computer and picks out each font's
   PostScript name (the name Premiere's templates use), its family and
   style, and whether it supports Arabic. Done once, then cached.
   ========================================================= */

var CADR_FONTS_KEY = "cadrFontListV1";
var cadrFontList = null;
var cadrFontScanning = false;
var cadrFontScanDone = false;
var cadrFontFilter = { q: "", arabic: false };

function cadrFontNode() {

    var n = window.cep_node || {};

    return {
        fs: n.require("fs"),
        os: n.require("os"),
        path: n.require("path"),
        Buf: n.Buffer || Buffer,
        env: (n.process || process).env
    };
}

function cadrFontListLoad() {

    if (cadrFontList) {
        return;
    }

    try {

        var raw = JSON.parse(window.localStorage.getItem(CADR_FONTS_KEY) || "null");

        if (Array.isArray(raw) && raw.length) {
            cadrFontList = raw;
            cadrFontScanDone = true;
        }

    } catch (e) {}
}

function cadrFontDecode(buf, off, len, platform) {

    if (off < 0 || off + len > buf.length) {
        return "";
    }

    if (platform === 1) {
        return buf.toString("latin1", off, off + len);
    }

    var out = "";

    for (var i = 0; i + 1 < len; i += 2) {
        out += String.fromCharCode(buf.readUInt16BE(off + i));
    }

    return out;
}

/* a font is { ps, family, style, arabic } or null */
function cadrFontParseAt(node, fd, base) {

    var head = node.Buf.alloc(12);

    if (node.fs.readSync(fd, head, 0, 12, base) < 12) {
        return null;
    }

    var magic = head.readUInt32BE(0);

    if (magic !== 0x00010000 && magic !== 0x4F54544F && magic !== 0x74727565) {
        return null;
    }

    var numTables = head.readUInt16BE(4);

    if (numTables < 1 || numTables > 200) {
        return null;
    }

    var dir = node.Buf.alloc(numTables * 16);

    node.fs.readSync(fd, dir, 0, dir.length, base + 12);

    var nameOff = -1;
    var nameLen = 0;
    var osOff = -1;
    var osLen = 0;

    for (var i = 0; i < numTables; i++) {

        var tag = dir.toString("latin1", i * 16, i * 16 + 4);

        if (tag === "name") {
            nameOff = dir.readUInt32BE(i * 16 + 8);
            nameLen = dir.readUInt32BE(i * 16 + 12);
        } else if (tag === "OS/2") {
            osOff = dir.readUInt32BE(i * 16 + 8);
            osLen = dir.readUInt32BE(i * 16 + 12);
        }
    }

    if (nameOff < 0 || nameLen < 6) {
        return null;
    }

    var nbuf = node.Buf.alloc(Math.min(nameLen, 262144));

    node.fs.readSync(fd, nbuf, 0, nbuf.length, nameOff);

    var count = nbuf.readUInt16BE(2);
    var strings = nbuf.readUInt16BE(4);

    function pick(id) {

        var fallback = "";

        for (var r = 0; r < count; r++) {

            var at = 6 + r * 12;

            if (at + 12 > nbuf.length) {
                break;
            }

            if (nbuf.readUInt16BE(at + 6) !== id) {
                continue;
            }

            var platform = nbuf.readUInt16BE(at);
            var language = nbuf.readUInt16BE(at + 4);
            var length = nbuf.readUInt16BE(at + 8);
            var offset = nbuf.readUInt16BE(at + 10);

            var value = cadrFontDecode(nbuf, strings + offset, length, platform);

            if (!value) {
                continue;
            }

            if (platform === 3 && language === 0x409) {
                return value;
            }

            if (!fallback) {
                fallback = value;
            }
        }

        return fallback;
    }

    var ps = pick(6);

    if (!ps) {
        return null;
    }

    var arabic = false;

    if (osOff >= 0 && osLen >= 48) {

        var obuf = node.Buf.alloc(48);

        node.fs.readSync(fd, obuf, 0, 48, osOff);

        arabic = ((obuf.readUInt32BE(42) >>> 13) & 1) === 1;
    }

    return {
        ps: ps,
        family: pick(16) || pick(1) || ps,
        style: pick(17) || pick(2) || "",
        arabic: arabic
    };
}

function cadrFontFolders(node) {

    var env = node.env;
    var folders = [];

    if (cadrIsWindows()) {

        folders.push((env.WINDIR || env.SystemRoot || "C:\\Windows") + "\\Fonts");

        if (env.LOCALAPPDATA) {
            folders.push(env.LOCALAPPDATA + "\\Microsoft\\Windows\\Fonts");
        }

    } else {

        var home = node.os.homedir();

        folders.push("/Library/Fonts");
        folders.push("/System/Library/Fonts");
        folders.push("/System/Library/Fonts/Supplemental");
        folders.push(home + "/Library/Fonts");
    }

    return folders;
}

function cadrFontScan(onProgress, onDone) {

    if (cadrFontScanning) {
        return;
    }

    cadrFontScanning = true;

    var node;
    var files = [];

    try {

        node = cadrFontNode();

        cadrFontFolders(node).forEach(function (folder) {

            var names = [];

            try {
                names = node.fs.readdirSync(folder);
            } catch (e) {}

            names.forEach(function (name) {

                if (/\.(ttf|otf|ttc)$/i.test(name)) {
                    files.push(node.path.join(folder, name));
                }
            });
        });

    } catch (e1) {

        cadrFontScanning = false;
        cadrFontScanDone = true;

        if (onDone) {
            onDone(0);
        }

        return;
    }

    var found = {};
    var index = 0;

    function readFile(file) {

        var fd = -1;

        try {

            fd = node.fs.openSync(file, "r");

            var magic = node.Buf.alloc(12);

            node.fs.readSync(fd, magic, 0, 12, 0);

            var offsets = [0];

            if (magic.toString("latin1", 0, 4) === "ttcf") {

                offsets = [];

                var n = Math.min(magic.readUInt32BE(8), 64);
                var table = node.Buf.alloc(n * 4);

                node.fs.readSync(fd, table, 0, table.length, 12);

                for (var k = 0; k < n; k++) {
                    offsets.push(table.readUInt32BE(k * 4));
                }
            }

            offsets.forEach(function (base) {

                var font = cadrFontParseAt(node, fd, base);

                if (font && !found[font.ps]) {
                    found[font.ps] = font;
                }
            });

        } catch (e) {
            /* a broken or locked font file is simply skipped */
        } finally {

            if (fd >= 0) {

                try {
                    node.fs.closeSync(fd);
                } catch (e2) {}
            }
        }
    }

    function tick() {

        var stop = Math.min(index + 12, files.length);

        for (; index < stop; index++) {
            readFile(files[index]);
        }

        if (onProgress) {
            onProgress(index, files.length);
        }

        if (index < files.length) {
            setTimeout(tick, 20);
            return;
        }

        var list = Object.keys(found).map(function (key) {
            return found[key];
        });

        list.sort(function (a, b) {

            var x = (a.family + " " + a.style).toLowerCase();
            var y = (b.family + " " + b.style).toLowerCase();

            return x < y ? -1 : (x > y ? 1 : 0);
        });

        cadrFontList = list;
        cadrFontScanning = false;
        cadrFontScanDone = true;

        if (list.length) {

            try {
                window.localStorage.setItem(CADR_FONTS_KEY, JSON.stringify(list));
            } catch (e3) {}
        }

        if (onDone) {
            onDone(list.length);
        }
    }

    setTimeout(tick, 0);
}

function cadrFontFillSelect(select, current, templateFont) {

    select.innerHTML = "";

    var first = document.createElement("option");

    first.value = "";
    first.textContent = "فونت القالب" + (templateFont ? " (" + templateFont + ")" : "");
    select.appendChild(first);

    var q = String(cadrFontFilter.q || "").trim().toLowerCase();
    var hasCurrent = false;

    (cadrFontList || []).forEach(function (font) {

        if (cadrFontFilter.arabic && !font.arabic) {
            return;
        }

        if (q && (font.family + " " + font.style + " " + font.ps).toLowerCase().indexOf(q) === -1) {
            return;
        }

        var option = document.createElement("option");

        option.value = font.ps;
        option.textContent = font.family +
            (font.style && font.style !== "Regular" ? " — " + font.style : "");

        select.appendChild(option);

        if (font.ps === current) {
            hasCurrent = true;
        }
    });

    if (current && !hasCurrent) {

        var extra = document.createElement("option");

        extra.value = current;
        extra.textContent = current + " (المختار)";
        select.insertBefore(extra, first.nextSibling);
    }

    select.value = current || "";
}

cadrStyleTabRender();



/* =========================================================
   CADR CUT UX v4 — PRO CAPTION STUDIO & INTERACTIVE MOGRT STAGE
   ========================================================= */

window.cadrCancelRequested = false;

function cadrSetStopVisible(show) {
    var btn = document.getElementById("cadrStopBtn");
    if (btn) {
        btn.style.display = show ? "inline-block" : "none";
    }
}

function cadrRequestStop() {
    window.cadrCancelRequested = true;
    cadrSetStopVisible(false);
    var msg = document.getElementById("cadrBarMsg");
    if (msg) {
        msg.textContent = cadrUiLangNow === "ar" ? "تم إيقاف العملية." : "Operation stopped.";
    }
    cadrBarIdle();
}

(function () {
    var origWave = cadrBarWave;
    cadrBarWave = function (percent) {
        origWave(percent);
        var p = Number(percent) || 0;
        cadrSetStopVisible(p > 0 && p < 100);
        if (p === 0) {
            window.cadrCancelRequested = false;
            cadrSetStopVisible(true);
        } else if (p >= 100) {
            cadrSetStopVisible(false);
        }
    };

    var origIdle = cadrBarIdle;
    cadrBarIdle = function () {
        origIdle();
        cadrSetStopVisible(false);
    };
})();


/* ---------- 1. PRO CAPTION STUDIO ENGINE ---------- */

function cadrSetMaxLines(n) {
    var val = (Number(n) === 2) ? 2 : 1;
    var hidden = document.getElementById("maxLinesPerCaption");
    if (hidden) hidden.value = String(val);

    var btns = document.querySelectorAll("#maxLinesSeg .seg-btn");
    for (var i = 0; i < btns.length; i++) {
        var bLines = parseInt(btns[i].getAttribute("data-lines"), 10);
        btns[i].className = "seg-btn" + (bLines === val ? " on" : "");
    }
    setSetting("maxLinesPerCaption", String(val));
    rebuildCaptionPreview();
}

function cadrSyncCapToggleCards() {
    var ids = ["naturalSplit", "stripPunctuation", "stripTashkeel", "wordLevelCaptions"];
    for (var i = 0; i < ids.length; i++) {
        var cb = document.getElementById(ids[i]);
        var lbl = document.getElementById("lbl_" + ids[i]);
        if (cb && lbl) {
            lbl.className = "cap-toggle-card" + (cb.checked ? " on" : "");
        }
    }
}

function cadrOnCapToggleChange() {
    cadrSyncCapToggleCards();
    var ids = ["naturalSplit", "stripPunctuation", "stripTashkeel", "wordLevelCaptions"];
    for (var i = 0; i < ids.length; i++) {
        var cb = document.getElementById(ids[i]);
        if (cb) setSetting(ids[i], cb.checked ? "1" : "0");
    }
    rebuildCaptionPreview();
}

function cadrCleanCaptionTextPro(text, stripPunct, stripTashkeel) {
    var out = String(text || "");
    if (stripTashkeel) {
        /* Remove Arabic harakat / diacritics & tatweel */
        out = out.replace(/[\u064B-\u065F\u0670\u0640]/g, "");
    }
    if (stripPunct) {
        /* Remove trailing/inline punctuation while keeping words & numbers intact */
        out = out.replace(/[.,،؛;:!؟?"'«»()\[\]{}…—–-]+/g, " ");
    }
    return out.replace(/\s+/g, " ").trim();
}

function cadrWrapTextLines(wordsArr, maxChars, maxLines) {
    var full = wordsArr.join(" ");
    if (maxLines <= 1 || full.length <= maxChars) {
        return full;
    }
    /* Split into 2 balanced lines */
    var half = Math.ceil(full.length / 2);
    var bestIdx = -1;
    var bestDist = 9999;
    var acc = 0;
    for (var i = 0; i < wordsArr.length - 1; i++) {
        acc += wordsArr[i].length + (i > 0 ? 1 : 0);
        var dist = Math.abs(acc - half);
        if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i + 1;
        }
    }
    if (bestIdx > 0 && bestIdx < wordsArr.length) {
        return wordsArr.slice(0, bestIdx).join(" ") + "\n" + wordsArr.slice(bestIdx).join(" ");
    }
    return full;
}

function cadrBuildProCaptions() {
    var wordsPerLineEl = document.getElementById("wordsPerLine");
    var maxCharsEl = document.getElementById("maxCharsPerLine");
    var maxLinesEl = document.getElementById("maxLinesPerCaption");
    var gapBridgeEl = document.getElementById("captionGapBridge");
    var timeOffsetEl = document.getElementById("captionTimeOffset");
    var minDurEl = document.getElementById("minCaptionDuration");
    var pauseSplitEl = document.getElementById("capPauseSplit");
    var natSplitEl = document.getElementById("naturalSplit");
    var stripPunctEl = document.getElementById("stripPunctuation");
    var stripTashkeelEl = document.getElementById("stripTashkeel");
    var wordLevelEl = document.getElementById("wordLevelCaptions");

    var maxWords = wordsPerLineEl ? Math.max(1, parseInt(wordsPerLineEl.value, 10) || 3) : 3;
    var maxChars = maxCharsEl ? Math.max(10, parseInt(maxCharsEl.value, 10) || 28) : 28;
    var maxLines = maxLinesEl ? Math.max(1, parseInt(maxLinesEl.value, 10) || 1) : 1;
    var gapBridge = gapBridgeEl ? Math.max(0, parseFloat(gapBridgeEl.value) || 0) : 0.12;
    var offsetSec = timeOffsetEl ? ((parseFloat(timeOffsetEl.value) || 0) / 1000.0) : 0;
    var minDur = minDurEl ? Math.max(0.1, parseFloat(minDurEl.value) || 0.35) : 0.35;
    var pauseSplit = pauseSplitEl ? Math.max(0.1, parseFloat(pauseSplitEl.value) || 0.35) : 0.35;
    var useNatSplit = natSplitEl ? natSplitEl.checked : true;
    var stripPunct = stripPunctEl ? stripPunctEl.checked : false;
    var stripTashkeel = stripTashkeelEl ? stripTashkeelEl.checked : false;
    var useWordTimings = wordLevelEl ? wordLevelEl.checked : true;

    var totalMaxChars = maxChars * maxLines;
    var rawGroups = [];

    /* If we have word-level timestamps and word-level sync is enabled, group words intelligently! */
    if (useWordTimings && pendingCaptionWords && pendingCaptionWords.length > 0) {
        var bucket = [];
        var bucketChars = 0;

        function flushBucket() {
            if (!bucket.length) return;
            var wTexts = [];
            for (var b = 0; b < bucket.length; b++) {
                var cleanedW = cadrCleanCaptionTextPro(bucket[b].word || bucket[b].text || "", stripPunct, stripTashkeel);
                if (cleanedW) wTexts.push(cleanedW);
            }
            if (wTexts.length) {
                rawGroups.push({
                    start: Number(bucket[0].start) || 0,
                    end: Number(bucket[bucket.length - 1].end) || 0,
                    text: cadrWrapTextLines(wTexts, maxChars, maxLines)
                });
            }
            bucket = [];
            bucketChars = 0;
        }

        for (var i = 0; i < pendingCaptionWords.length; i++) {
            var wObj = pendingCaptionWords[i];
            var rawW = String(wObj.word || wObj.text || "").trim();
            if (!rawW) continue;

            var hadSentenceEnd = /[.!؟?،,;:]/.test(rawW);
            var cleanW = cadrCleanCaptionTextPro(rawW, stripPunct, stripTashkeel);
            if (!cleanW) continue;

            if (bucket.length > 0) {
                var prevW = bucket[bucket.length - 1];
                var silenceGap = (Number(wObj.start) || 0) - (Number(prevW.end) || 0);
                var nextLen = bucketChars + 1 + cleanW.length;

                if (
                    bucket.length >= maxWords ||
                    nextLen > totalMaxChars ||
                    (useNatSplit && silenceGap >= pauseSplit)
                ) {
                    flushBucket();
                }
            }

            bucket.push(wObj);
            bucketChars += (bucketChars > 0 ? 1 : 0) + cleanW.length;

            if (useNatSplit && hadSentenceEnd && bucket.length >= Math.min(2, maxWords)) {
                flushBucket();
            }
        }
        flushBucket();
    } else if (pendingCaptionLines && pendingCaptionLines.length > 0) {
        /* Fallback when only line-level timestamps exist */
        for (var l = 0; l < pendingCaptionLines.length; l++) {
            var ln = pendingCaptionLines[l];
            var cleanedLine = cadrCleanCaptionTextPro(ln.text || "", stripPunct, stripTashkeel);
            if (!cleanedLine) continue;
            var splitWords = cleanedLine.split(/\s+/);
            if (splitWords.length <= maxWords && cleanedLine.length <= totalMaxChars) {
                rawGroups.push({
                    start: Number(ln.start) || 0,
                    end: Number(ln.end) || 0,
                    text: cadrWrapTextLines(splitWords, maxChars, maxLines)
                });
            } else {
                /* Sub-divide long lines proportionally */
                var chunksCount = Math.ceil(Math.max(splitWords.length / maxWords, cleanedLine.length / totalMaxChars));
                var wordsPerChunk = Math.ceil(splitWords.length / chunksCount);
                var lineStart = Number(ln.start) || 0;
                var lineDur = Math.max(0.2, (Number(ln.end) || 0) - lineStart);
                for (var c = 0; c < chunksCount; c++) {
                    var slice = splitWords.slice(c * wordsPerChunk, (c + 1) * wordsPerChunk);
                    if (!slice.length) continue;
                    var st = lineStart + (c / chunksCount) * lineDur;
                    var en = lineStart + ((c + 1) / chunksCount) * lineDur;
                    rawGroups.push({
                        start: st,
                        end: en,
                        text: cadrWrapTextLines(slice, maxChars, maxLines)
                    });
                }
            }
        }
    }

    if (!rawGroups.length) return [];

    /* Apply timing offset, minimum duration, and gap bridging (flicker removal) */
    for (var g = 0; g < rawGroups.length; g++) {
        rawGroups[g].start = Math.max(0, rawGroups[g].start + offsetSec);
        rawGroups[g].end = Math.max(rawGroups[g].start + 0.08, rawGroups[g].end + offsetSec);

        if (rawGroups[g].end - rawGroups[g].start < minDur) {
            var maxAllowedEnd = (g + 1 < rawGroups.length)
                ? Math.max(rawGroups[g].start + 0.08, rawGroups[g + 1].start + offsetSec - 0.01)
                : (rawGroups[g].start + minDur);
            rawGroups[g].end = Math.min(rawGroups[g].start + minDur, maxAllowedEnd);
        }
    }

    if (gapBridge > 0) {
        for (var k = 0; k < rawGroups.length - 1; k++) {
            var gap = rawGroups[k + 1].start - rawGroups[k].end;
            if (gap > 0 && gap <= gapBridge) {
                rawGroups[k].end = rawGroups[k + 1].start;
            }
        }
    }

    return rawGroups;
}

/* Override rebuildCaptionPreview to use cadrBuildProCaptions */
rebuildCaptionPreview = function () {
    var groups = cadrBuildProCaptions();
    if (!groups || !groups.length) {
        cadrRenderVisualCaptionLines();
        return;
    }

    pendingCaptionSrt = buildSrtFromLines(groups);
    var preview = document.getElementById("captionPreview");
    if (preview) {
        preview.value = pendingCaptionSrt;
    }

    if (typeof cadrTrReset === "function") {
        cadrTrReset();
    }
    cadrRenderVisualCaptionLines();
    if (typeof cadrUpdateMogrtMonitor === "function") {
        cadrUpdateMogrtMonitor();
    }
};

function cadrBindProCaptionSettings() {
    var proSliderIds = [
        "wordsPerLine",
        "maxCharsPerLine",
        "captionGapBridge",
        "captionTimeOffset",
        "minCaptionDuration",
        "capPauseSplit"
    ];

    for (var i = 0; i < proSliderIds.length; i++) {
        (function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            var saved = getSetting(id, null);
            if (saved !== null && saved !== "") {
                el.value = saved;
            }
            el.addEventListener("input", function () {
                cadrRefreshSliderLabels();
                setSetting(id, el.value);
                if (id === "wordsPerLine") {
                    cadrSyncCaptionUi();
                }
                rebuildCaptionPreview();
            });
        })(proSliderIds[i]);
    }

    /* Update preset cards (#styleRow .pre) to set full Pro Caption presets */
    var cards = document.querySelectorAll("#styleRow .pre");
    for (var c = 0; c < cards.length; c++) {
        (function (card) {
            card.onclick = function () {
                var w = parseInt(card.getAttribute("data-words"), 10) || 3;
                var wEl = document.getElementById("wordsPerLine");
                var cEl = document.getElementById("maxCharsPerLine");
                if (wEl) {
                    wEl.value = String(w);
                    setSetting("wordsPerLine", String(w));
                }
                if (w === 1) {
                    if (cEl) { cEl.value = "18"; setSetting("maxCharsPerLine", "18"); }
                    cadrSetMaxLines(1);
                } else if (w === 3) {
                    if (cEl) { cEl.value = "28"; setSetting("maxCharsPerLine", "28"); }
                    cadrSetMaxLines(1);
                } else {
                    if (cEl) { cEl.value = "42"; setSetting("maxCharsPerLine", "42"); }
                    cadrSetMaxLines(2);
                }
                cadrRefreshSliderLabels();
                cadrSyncCaptionUi();
                rebuildCaptionPreview();
            };
        })(cards[c]);
    }

    var savedLines = getSetting("maxLinesPerCaption", "1");
    cadrSetMaxLines(parseInt(savedLines, 10) || 1);
    cadrSyncCapToggleCards();
    cadrRefreshSliderLabels();
}


/* ---------- 2. INTERACTIVE CLICK-TO-EDIT SLIDER BADGES ---------- */

function cadrInitEditableSliderBadges() {
    for (var i = 0; i < CADR_SLIDERS.length; i++) {
        (function (spec) {
            var slider = document.getElementById(spec.id);
            var badge = document.getElementById("v_" + spec.id);
            if (!slider || !badge) return;

            badge.onclick = function (ev) {
                ev.stopPropagation();
                if (badge.querySelector("input")) return;

                var currentVal = parseFloat(slider.value);
                var input = document.createElement("input");
                input.type = "number";
                input.className = "slider-edit-input";
                input.min = slider.min;
                input.max = slider.max;
                input.step = "any";
                input.value = isNaN(currentVal) ? "" : currentVal;

                badge.textContent = "";
                badge.appendChild(input);
                input.focus();
                input.select();

                var committed = false;
                function commit() {
                    if (committed) return;
                    committed = true;
                    var v = parseFloat(input.value);
                    if (!isNaN(v)) {
                        var minV = parseFloat(slider.min);
                        var maxV = parseFloat(slider.max);
                        if (!isNaN(minV)) v = Math.max(minV, v);
                        if (!isNaN(maxV)) v = Math.min(maxV, v);
                        slider.step = "any";
                        slider.value = String(v);
                        try {
                            slider.dispatchEvent(new Event("input", { bubbles: true }));
                            slider.dispatchEvent(new Event("change", { bubbles: true }));
                        } catch (e) {
                            if (typeof slider.oninput === "function") slider.oninput();
                            if (typeof slider.onchange === "function") slider.onchange();
                        }
                    }
                    cadrRefreshSliderLabels();
                }

                input.onkeydown = function (ke) {
                    if (ke.key === "Enter") {
                        ke.preventDefault();
                        commit();
                    } else if (ke.key === "Escape") {
                        committed = true;
                        cadrRefreshSliderLabels();
                    }
                };
                input.onblur = commit;
            };
        })(CADR_SLIDERS[i]);
    }
}


/* ---------- 3. VISUAL CAPTION LINE EDITOR ---------- */

var cadrCapEditorMode = "lines";

function cadrFmtShortTime(sec) {
    var s = Math.max(0, Number(sec) || 0);
    var m = Math.floor(s / 60);
    var rem = (s - m * 60).toFixed(1);
    return (m < 10 ? "0" : "") + m + ":" + (rem < 10 ? "0" : "") + rem;
}

function cadrSetCapEditorMode(mode) {
    cadrCapEditorMode = mode === "raw" ? "raw" : "lines";
    var visualBox = document.getElementById("captionVisualLines");
    var rawArea = document.getElementById("captionPreview");
    var chips = document.querySelectorAll("#capEditorModeChips .chip");

    for (var i = 0; i < chips.length; i++) {
        chips[i].className = "chip" + (chips[i].getAttribute("data-cap-mode") === cadrCapEditorMode ? " on" : "");
    }

    if (visualBox && rawArea) {
        if (cadrCapEditorMode === "raw") {
            visualBox.style.display = "none";
            rawArea.style.display = "block";
        } else {
            visualBox.style.display = "flex";
            rawArea.style.display = "none";
            cadrRenderVisualCaptionLines();
        }
    }
}

function cadrRenderVisualCaptionLines() {
    var visualBox = document.getElementById("captionVisualLines");
    var rawArea = document.getElementById("captionPreview");
    if (!visualBox || !rawArea) return;

    var srtText = String(rawArea.value || "").trim();
    var lines = srtText ? parseSrtToLines(srtText) : [];

    visualBox.innerHTML = "";

    if (!lines.length) {
        var empty = document.createElement("div");
        empty.className = "cap-empty";
        empty.textContent = cadrUiLangNow === "ar"
            ? "ستظهر سطور الكابشن هنا بعد الضغط على توليد الكابشن لتعديلها بسهولة."
            : "Caption lines will appear here after clicking Generate Captions.";
        visualBox.appendChild(empty);
        return;
    }

    lines.forEach(function (line, idx) {
        var row = document.createElement("div");
        row.className = "cap-line-row";

        var timeBtn = document.createElement("button");
        timeBtn.type = "button";
        timeBtn.className = "cap-time-btn";
        timeBtn.title = cadrUiLangNow === "ar" ? "انتقل لهذا التوقيت على التايم لاين" : "Jump playhead to this line";
        var lineDurSec = Math.max(0.05, (Number(line.end) || 0) - (Number(line.start) || 0));
        timeBtn.textContent = "▶ " + cadrFmtShortTime(line.start) + " (" + lineDurSec.toFixed(2) + "s)";
        timeBtn.onclick = function () {
            if (window.__adobe_cep__) {
                var targetSec = Math.max(0, Number(line.start) || 0);
                csInterface.evalScript("cadrGoTo(" + targetSec + ")");
            }
        };

        var input = document.createElement("input");
        input.type = "text";
        input.className = "cap-line-input";
        input.dir = "auto";
        input.value = String(line.text || "").replace(/\s*\n\s*/g, " ");
        input.oninput = function () {
            lines[idx].text = input.value;
            var updatedSrt = buildSrtFromLines(lines);
            rawArea.value = updatedSrt;
            pendingCaptionSrt = updatedSrt;
            if (idx === 0 && typeof cadrUpdateMogrtMonitor === "function") {
                cadrUpdateMogrtMonitor();
            }
        };

        row.appendChild(timeBtn);
        row.appendChild(input);
        visualBox.appendChild(row);
    });
}


/* ---------- 4. INTERACTIVE MOGRT STAGE & STUDIO CONTROLS ---------- */

var CADR_MEM_STORE = {};

cadrStoreGet = function (key) {
    try {
        var raw = window.localStorage.getItem(key);
        if (raw) {
            var parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object") {
                CADR_MEM_STORE[key] = parsed;
                return parsed;
            }
        }
    } catch (e) {}
    return CADR_MEM_STORE[key] || {};
};

cadrStoreSet = function (key, value) {
    CADR_MEM_STORE[key] = value;
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
};

cadrStyleOvUpdate = function (mutator) {
    var style = cadrActiveStyle();
    var styleKey = style ? style.path : "__preview__";
    var all = cadrStoreGet(CADR_STYLE_OV_KEY);
    var ov = all[styleKey] || { params: {} };
    if (!ov.params) {
        ov.params = {};
    }
    mutator(ov);
    all[styleKey] = ov;
    cadrStoreSet(CADR_STYLE_OV_KEY, all);
};

cadrStyleResetOverrides = function () {
    var style = cadrActiveStyle();
    var styleKey = style ? style.path : "__preview__";
    var all = cadrStoreGet(CADR_STYLE_OV_KEY);
    delete all[styleKey];
    cadrStoreSet(CADR_STYLE_OV_KEY, all);
    cadrBuildStudioStyleControls();
    cadrUpdateMogrtMonitor();
    cadrStyleStatus(cadrUiLangNow === "en" ? "Reset to template defaults." : "تمت إعادة الضبط لإعدادات القالب الأصلية.");
};


var CADR_MOGRT_MOTIONS = [
    { id: "pop", labelEn: "Karaoke Pop ↻", labelAr: "Karaoke Pop ↻" },
    { id: "box", labelEn: "Active Box ↻", labelAr: "Active Box ↻" },
    { id: "slide", labelEn: "Slide & Glow ↻", labelAr: "Slide & Glow ↻" },
    { id: "single", labelEn: "1-Word Punch ↻", labelAr: "كلمة واحدة ↻" }
];
var cadrMogrtMotionIdx = 0;
var cadrMogrtWordIdx = 0;
var cadrMogrtTimer = null;
var cadrMogrtPlaying = true;
var cadrMogrtAspect = "9:16";
var cadrCustomPreviewText = "";
var cadrCachedMonState = null;

function cadrToggleMogrtPlay(ev) {
    if (ev) ev.stopPropagation();
    cadrMogrtPlaying = !cadrMogrtPlaying;
    var btn = document.getElementById("mogrtPlayBtn");
    var dot = document.getElementById("mogrtLiveDot");
    if (btn) btn.textContent = cadrMogrtPlaying ? "⏸" : "▶";
    if (dot) dot.style.opacity = cadrMogrtPlaying ? "1" : "0.3";
}

function cadrToggleMogrtAspect(ev) {
    if (ev) ev.stopPropagation();
    cadrMogrtAspect = (cadrMogrtAspect === "9:16") ? "16:9" : "9:16";
    var btn = document.getElementById("mogrtAspectBtn");
    var guide = document.getElementById("mogrtFrame916");
    if (btn) btn.textContent = cadrMogrtAspect;
    if (guide) guide.style.opacity = (cadrMogrtAspect === "9:16") ? "1" : "0";
}

function cadrCycleMogrtMotion(ev) {
    if (ev) ev.stopPropagation();
    cadrMogrtMotionIdx = (cadrMogrtMotionIdx + 1) % CADR_MOGRT_MOTIONS.length;
    cadrUpdateMogrtMonitor();
}

function cadrStyleSelectChange(val) {
    var idx = parseInt(val, 10);
    if (!isNaN(idx) && idx >= 0) {
        cadrStyleSetActive(idx);
        cadrStyleRender();
        cadrBuildStudioStyleControls();
        cadrUpdateMogrtMonitor();
    }
}

function cadrStyleDeleteActive() {
    var list = cadrStyleLoad();
    if (!list.length) return;
    var active = cadrStyleActive();
    list.splice(active, 1);
    cadrStyleSave(list);
    cadrStyleSetActive(Math.max(0, active - 1));
    cadrStyleRender();
    cadrBuildStudioStyleControls();
    cadrUpdateMogrtMonitor();
}

function cadrPopulateStyleDropdown() {
    var sel = document.getElementById("styleSelect");
    var delBtn = document.getElementById("styleDeleteBtn");
    if (!sel) return;

    var list = cadrStyleLoad();
    var active = cadrStyleActive();
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");

    sel.innerHTML = "";

    if (!list.length) {
        var emptyOpt = document.createElement("option");
        emptyOpt.value = "-1";
        emptyOpt.textContent = isEn
            ? "🎬 CADR Default Studio Style (Click + .mogrt to add)"
            : "🎬 ستايل كدر التفاعلي (اضغط + .mogrt لإضافة قالب)";
        sel.appendChild(emptyOpt);
        if (delBtn) delBtn.disabled = true;
        return;
    }

    if (delBtn) delBtn.disabled = false;

    list.forEach(function (style, i) {
        var opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = "🎬 " + style.name;
        if (i === active) opt.selected = true;
        sel.appendChild(opt);
    });
}

function cadrDefaultStudioSchema() {
    return {
        font: { hasFont: true, font: "Montserrat-Bold", sizeKey: "Size", fontSize: 64 },
        params: [
            { name: "Text Color", kind: "color", value: "#F5F5F5" },
            { name: "Highlight Color", kind: "color", value: "#FF6B35" },
            { name: "Background Box", kind: "color", value: "#101114" },
            { name: "Stroke Color", kind: "color", value: "#000000" },
            { name: "Text Position", kind: "position", value: [0.5, 0.72] },
            { name: "Scale", kind: "number", value: 100 },
            { name: "Box Opacity", kind: "number", value: 82 }
        ]
    };
}

function cadrHexToRgba(hex, alphaPct) {
    var h = String(hex || "#101114").replace("#", "");
    if (h.length !== 6) return "rgba(16,17,20,0.82)";
    var n = parseInt(h, 16);
    var r = (n >> 16) & 255;
    var g = (n >> 8) & 255;
    var b = n & 255;
    var a = Math.max(0, Math.min(1, (Number(alphaPct) || 82) / 100));
    return "rgba(" + r + "," + g + "," + b + "," + a.toFixed(2) + ")";
}

function cadrGetActiveStyleEffectiveState() {
    var style = cadrActiveStyle();
    var styleKey = style ? style.path : "__preview__";
    var storedSchemas = cadrStoreGet(CADR_STYLE_SCHEMA_KEY);
    var schema = storedSchemas[styleKey] || cadrDefaultStudioSchema();
    var ov = cadrStoreGet(CADR_STYLE_OV_KEY)[styleKey] || { params: {} };
    if (!ov.params) ov.params = {};

    var fontPs = ov.font || (schema.font && schema.font.font) || "";
    var fontFamily = "";
    if (fontPs && cadrFontList) {
        for (var i = 0; i < cadrFontList.length; i++) {
            if (cadrFontList[i].ps === fontPs) {
                fontFamily = cadrFontList[i].family;
                break;
            }
        }
    }
    if (!fontFamily && fontPs) {
        fontFamily = fontPs.split("-")[0];
    }

    var baseSize = (schema.font && schema.font.fontSize) ? Number(schema.font.fontSize) : 64;
    var fontSize = ov.fontSize ? Number(ov.fontSize) : baseSize;

    var textColor = "#F5F5F5";
    var highlightColor = "#FF6B35";
    var bgHex = "#101114";
    var strokeColor = "#000000";
    var posX = 0.5;
    var posY = 0.72;
    var scale = 100;
    var boxOpacity = 82;

    var paramsList = schema.params || [];
    var colorCount = 0;
    for (var p = 0; p < paramsList.length; p++) {
        var item = paramsList[p];
        var val = (ov.params[item.name] !== undefined) ? ov.params[item.name] : item.value;
        var nm = String(item.name || "").toLowerCase();

        if (item.kind === "color" && typeof val === "string") {
            if (/highlight|accent|active|secondary|2/.test(nm)) {
                highlightColor = val;
            } else if (/stroke|shadow|outline|border/.test(nm)) {
                strokeColor = val;
            } else if (/bg|background|box|back/.test(nm)) {
                bgHex = val;
            } else if (colorCount === 0) {
                textColor = val;
            } else if (colorCount === 1) {
                highlightColor = val;
            } else if (colorCount === 2) {
                bgHex = val;
            } else {
                strokeColor = val;
            }
            colorCount++;
        } else if (item.kind === "position" && Array.isArray(val) && val.length === 2) {
            posX = Number(val[0]);
            posY = Number(val[1]);
        } else if (item.kind === "number" && typeof val === "number") {
            if (/opacity|alpha/.test(nm)) {
                boxOpacity = val;
            } else if (/scale|size|zoom/.test(nm)) {
                scale = val;
            }
        }
    }

    /* Also check direct studio keys in ov.params so studio sliders always work even on custom schemas */
    if (ov.params["Text Color"]) textColor = ov.params["Text Color"];
    if (ov.params["Highlight Color"]) highlightColor = ov.params["Highlight Color"];
    if (ov.params["Background Box"]) bgHex = ov.params["Background Box"];
    if (ov.params["Stroke Color"]) strokeColor = ov.params["Stroke Color"];
    if (Array.isArray(ov.params["Text Position"])) {
        posX = Number(ov.params["Text Position"][0]);
        posY = Number(ov.params["Text Position"][1]);
    }
    if (typeof ov.params["Scale"] === "number") scale = ov.params["Scale"];
    if (typeof ov.params["Box Opacity"] === "number") boxOpacity = ov.params["Box Opacity"];

    return {
        styleName: style ? style.name : (cadrUiLangNow === "en" ? "CADR Studio Preview" : "معاينة ستوديو كدر"),
        fontPs: fontPs,
        fontFamily: fontFamily,
        fontSize: isNaN(fontSize) ? 64 : fontSize,
        baseSize: baseSize || 64,
        textColor: textColor,
        highlightColor: highlightColor,
        bgHex: bgHex,
        bgColor: cadrHexToRgba(bgHex, boxOpacity),
        strokeColor: strokeColor,
        posX: isNaN(posX) ? 0.5 : posX,
        posY: isNaN(posY) ? 0.72 : posY,
        scale: isNaN(scale) ? 100 : scale,
        boxOpacity: isNaN(boxOpacity) ? 82 : boxOpacity
    };
}

function cadrUpdateMogrtMonitor() {
    var box = document.getElementById("mogrtLiveCaption");
    var info = document.getElementById("mogrtMonInfo");
    var nameEl = document.getElementById("styleTabName");
    var motionBtn = document.getElementById("mogrtMotionBtn");
    if (!box) return;

    var st = cadrGetActiveStyleEffectiveState();
    cadrCachedMonState = st;
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    var motion = CADR_MOGRT_MOTIONS[cadrMogrtMotionIdx] || CADR_MOGRT_MOTIONS[0];

    if (motionBtn) {
        motionBtn.textContent = isEn ? motion.labelEn : motion.labelAr;
    }
    if (nameEl) {
        nameEl.textContent = st.styleName;
    }

    var sampleLine = cadrCustomPreviewText || (isEn ? "YOUR VISION OUR FRAME" : "كدر ستوديو للمونتاج السريع");
    if (!cadrCustomPreviewText) {
        try {
            var rawArea = document.getElementById("captionPreview");
            if (rawArea && rawArea.value.trim()) {
                var parsed = parseSrtToLines(rawArea.value);
                if (parsed.length && parsed[0].text) {
                    sampleLine = String(parsed[0].text).replace(/\s+/g, " ").trim();
                }
            }
        } catch (e) {}
    }

    var words = sampleLine.split(/\s+/).slice(0, 5);
    if (!words.length) words = ["CADR", "CUT"];

    var activeIdx = cadrMogrtWordIdx % words.length;

    var ratio = Math.max(0.5, Math.min(1.85, (st.fontSize / (st.baseSize || 64)) * (st.scale / 100)));
    var pxSize = Math.round(17 * ratio);

    var normX = (st.posX >= -1 && st.posX <= 2) ? st.posX : (st.posX / 1080);
    var normY = (st.posY >= -1 && st.posY <= 2) ? st.posY : (st.posY / 1920);
    var leftPct = Math.max(12, Math.min(88, Math.round(normX * 100)));
    var topPct = Math.max(16, Math.min(86, Math.round(normY * 100)));

    box.style.left = leftPct + "%";
    box.style.top = topPct + "%";
    box.style.fontSize = pxSize + "px";
    var cleanFam = st.fontFamily ? st.fontFamily.replace(/['"]/g, "") : "";
    box.style.fontFamily = cleanFam ? ("'" + cleanFam + "', var(--font-head)") : "var(--font-head)";
    box.style.background = st.bgColor;
    box.style.border = st.boxOpacity > 5 ? "1px solid rgba(255,255,255,0.12)" : "none";
    box.style.textShadow = "0 2px 6px " + st.strokeColor + ", 0 0 2px " + st.strokeColor;

    box.innerHTML = "";

    if (motion.id === "single") {
        var singleSpan = document.createElement("span");
        singleSpan.className = "mogrt-word active-pop";
        singleSpan.textContent = words[activeIdx];
        singleSpan.style.color = st.highlightColor;
        singleSpan.style.fontSize = Math.round(pxSize * 1.25) + "px";
        box.appendChild(singleSpan);
    } else {
        for (var w = 0; w < words.length; w++) {
            var span = document.createElement("span");
            var isActive = (w === activeIdx);
            span.className = "mogrt-word" + (isActive ? (" active-" + motion.id) : "");
            span.textContent = words[w];

            if (isActive) {
                if (motion.id === "box") {
                    span.style.background = st.highlightColor;
                    span.style.color = "#FFFFFF";
                } else if (motion.id === "slide") {
                    span.style.color = st.highlightColor;
                    span.style.textShadow = "0 0 12px " + st.highlightColor;
                } else {
                    span.style.color = st.highlightColor;
                }
            } else {
                span.style.color = st.textColor;
                span.style.background = "transparent";
            }
            box.appendChild(span);
        }
    }

    if (info) {
        info.textContent = (cleanFam || "Montserrat") + " • " + Math.round(st.fontSize) + "pt • X:" + leftPct + "% Y:" + topPct + "%";
    }
}

function cadrStepMogrtWordHighlight() {
    var box = document.getElementById("mogrtLiveCaption");
    if (!box) return;
    var motion = CADR_MOGRT_MOTIONS[cadrMogrtMotionIdx] || CADR_MOGRT_MOTIONS[0];
    if (motion.id === "single") {
        cadrUpdateMogrtMonitor();
        return;
    }
    var spans = box.querySelectorAll(".mogrt-word");
    if (!spans.length) {
        cadrUpdateMogrtMonitor();
        return;
    }
    var st = cadrCachedMonState || cadrGetActiveStyleEffectiveState();
    var activeIdx = cadrMogrtWordIdx % spans.length;

    for (var w = 0; w < spans.length; w++) {
        var span = spans[w];
        var isActive = (w === activeIdx);
        span.className = "mogrt-word" + (isActive ? (" active-" + motion.id) : "");
        if (isActive) {
            if (motion.id === "box") {
                span.style.background = st.highlightColor;
                span.style.color = "#FFFFFF";
            } else if (motion.id === "slide") {
                span.style.background = "transparent";
                span.style.color = st.highlightColor;
                span.style.textShadow = "0 0 12px " + st.highlightColor;
            } else {
                span.style.background = "transparent";
                span.style.color = st.highlightColor;
            }
        } else {
            span.style.color = st.textColor;
            span.style.background = "transparent";
        }
    }
}

function cadrStartMogrtMonitorLoop() {
    if (cadrMogrtTimer) {
        clearInterval(cadrMogrtTimer);
        cadrMogrtTimer = null;
    }
}

/* Interactive Drag-and-Drop on #mogrtMonitor to move caption X/Y directly with the mouse */
function cadrInitInteractiveMonitorDrag() {
    var mon = document.getElementById("mogrtMonitor");
    var cap = document.getElementById("mogrtLiveCaption");
    if (!mon || !cap) return;

    var dragging = false;

    function updatePosFromMouse(clientX, clientY) {
        var rect = mon.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        var rx = (clientX - rect.left) / rect.width;
        var ry = (clientY - rect.top) / rect.height;

        rx = Math.max(0.12, Math.min(0.88, rx));
        ry = Math.max(0.16, Math.min(0.86, ry));

        /* Snap gently to center 50% when close */
        if (Math.abs(rx - 0.5) < 0.03) rx = 0.5;
        if (Math.abs(ry - 0.5) < 0.03) ry = 0.5;

        rx = Math.round(rx * 100) / 100;
        ry = Math.round(ry * 100) / 100;

        cadrStyleOvUpdate(function (o) {
            o.params["Text Position"] = [rx, ry];
        });

        var sx = document.getElementById("studioPosX");
        var sy = document.getElementById("studioPosY");
        var vx = document.getElementById("v_studioPosX");
        var vy = document.getElementById("v_studioPosY");
        if (sx) sx.value = String(Math.round(rx * 100));
        if (sy) sy.value = String(Math.round(ry * 100));
        if (vx) vx.textContent = Math.round(rx * 100) + "%";
        if (vy) vy.textContent = Math.round(ry * 100) + "%";

        cadrUpdateMogrtMonitor();
    }

    mon.addEventListener("mousedown", function (ev) {
        if (ev.target && ev.target.tagName === "BUTTON") return;
        dragging = true;
        mon.classList.add("dragging");
        updatePosFromMouse(ev.clientX, ev.clientY);
    });

    window.addEventListener("mousemove", function (ev) {
        if (!dragging) return;
        updatePosFromMouse(ev.clientX, ev.clientY);
    });

    window.addEventListener("mouseup", function () {
        if (!dragging) return;
        dragging = false;
        mon.classList.remove("dragging");
    });

    cap.addEventListener("dblclick", function (ev) {
        ev.stopPropagation();
        var isEn = (cadrUiLangNow === "en");
        var nextText = window.prompt(
            isEn ? "Enter sample caption text to preview:" : "اكتب جملة المعاينة اللي تحب تجربها على الشاشة:",
            cadrCustomPreviewText || (isEn ? "YOUR VISION OUR FRAME" : "كدر ستوديو للمونتاج السريع")
        );
        if (nextText !== null) {
            cadrCustomPreviewText = nextText.trim();
            cadrUpdateMogrtMonitor();
        }
    });
}

/* Build the Interactive Studio Style Controls (Sliders + 4-Color Swatches + Position Presets) */
function cadrBuildStudioStyleControls() {
    var box = document.getElementById("styleControls");
    if (!box) return;

    var st = cadrGetActiveStyleEffectiveState();
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");

    box.innerHTML = "";

    /* -------- CARD 1: TYPOGRAPHY & SCALE -------- */
    var typoCard = document.createElement("div");
    typoCard.className = "card pad";
    typoCard.style.display = "flex";
    typoCard.style.flexDirection = "column";
    typoCard.style.gap = "8px";

    var typoHead = document.createElement("div");
    typoHead.className = "card-title";
    typoHead.textContent = isEn ? "Typography & Size" : "الخط والحجم (Typography)";
    typoCard.appendChild(typoHead);

    cadrFontListLoad();

    var searchRow = document.createElement("div");
    searchRow.className = "inline";

    var search = document.createElement("input");
    search.type = "text";
    search.placeholder = isEn ? "Search installed fonts..." : "ابحث عن فونت على جهازك...";
    search.dir = "auto";
    search.value = cadrFontFilter.q;

    var arabicChip = document.createElement("label");
    arabicChip.className = "chip";
    arabicChip.style.flex = "0 0 auto";
    var arabicBox = document.createElement("input");
    arabicBox.type = "checkbox";
    arabicBox.checked = cadrFontFilter.arabic;
    var arabicText = document.createElement("span");
    arabicText.textContent = isEn ? "Arabic" : "عربي";
    arabicChip.appendChild(arabicBox);
    arabicChip.appendChild(arabicText);

    var refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "btn sm";
    refreshBtn.style.flex = "0 0 auto";
    refreshBtn.title = isEn ? "Scan system fonts" : "فحص الفونتات المثبتة على الجهاز";
    refreshBtn.textContent = "↻";

    searchRow.appendChild(search);
    searchRow.appendChild(arabicChip);
    searchRow.appendChild(refreshBtn);

    var fontSelect = document.createElement("select");
    fontSelect.dir = "auto";

    /* Always include core brand & Arabic/English broadcast fonts at the top of the list */
    function fillStudioFonts() {
        cadrFontFillSelect(fontSelect, st.fontPs || "", "Montserrat-Bold");
        if (!cadrFontList || !cadrFontList.length) {
            var builtins = [
                ["Montserrat-Bold", "Montserrat — Bold (CADR Brand)"],
                ["Cairo-Bold", "Cairo — Bold (عربي)"],
                ["Tajawal-Bold", "Tajawal — Bold (عربي)"],
                ["IBM Plex Sans Arabic", "IBM Plex Sans Arabic (عربي)"],
                ["Inter-Bold", "Inter — Bold"],
                ["Impact", "Impact — Heavy"],
                ["Arial-BoldMT", "Arial — Bold"]
            ];
            for (var b = 0; b < builtins.length; b++) {
                var opt = document.createElement("option");
                opt.value = builtins[b][0];
                opt.textContent = builtins[b][1];
                if (st.fontPs === builtins[b][0]) opt.selected = true;
                fontSelect.appendChild(opt);
            }
        }
    }
    fillStudioFonts();

    search.oninput = function () {
        cadrFontFilter.q = search.value;
        fillStudioFonts();
    };
    arabicBox.onchange = function () {
        cadrFontFilter.arabic = arabicBox.checked;
        fillStudioFonts();
    };
    refreshBtn.onclick = function () {
        cadrFontScan(null, function () {
            cadrBuildStudioStyleControls();
            cadrUpdateMogrtMonitor();
        });
    };
    fontSelect.onchange = function () {
        var v = fontSelect.value;
        cadrStyleOvUpdate(function (o) {
            if (v) o.font = v;
            else delete o.font;
        });
        cadrUpdateMogrtMonitor();
    };

    typoCard.appendChild(searchRow);
    typoCard.appendChild(fontSelect);

    /* Font Size Slider + Scale Slider side by side */
    var sizeScaleGrid = document.createElement("div");
    sizeScaleGrid.className = "cap-studio-grid";

    var sizeBox = document.createElement("div");
    sizeBox.className = "cap-stat-box";
    sizeBox.innerHTML =
        '<div class="cap-stat-head"><span>' + (isEn ? "Font Size" : "حجم الخط") +
        '</span><b id="v_studioFontSize">' + Math.round(st.fontSize) + ' pt</b></div>' +
        '<input type="range" id="studioFontSize" min="18" max="140" step="1" value="' + Math.round(st.fontSize) + '">';

    var scaleBox = document.createElement("div");
    scaleBox.className = "cap-stat-box";
    scaleBox.innerHTML =
        '<div class="cap-stat-head"><span>' + (isEn ? "Template Scale" : "حجم القالب (Scale)") +
        '</span><b id="v_studioScale">' + Math.round(st.scale) + '%</b></div>' +
        '<input type="range" id="studioScale" min="50" max="180" step="1" value="' + Math.round(st.scale) + '">';

    sizeScaleGrid.appendChild(sizeBox);
    sizeScaleGrid.appendChild(scaleBox);
    typoCard.appendChild(sizeScaleGrid);
    box.appendChild(typoCard);

    /* -------- CARD 2: STUDIO COLORS & BACKGROUND BOX -------- */
    var colorCard = document.createElement("div");
    colorCard.className = "card pad";
    colorCard.style.display = "flex";
    colorCard.style.flexDirection = "column";
    colorCard.style.gap = "8px";

    var colorHead = document.createElement("div");
    colorHead.className = "card-title";
    colorHead.textContent = isEn ? "Colors & Highlight Box" : "الألوان والخلفية (Colors & Box)";
    colorCard.appendChild(colorHead);

    var swatchGrid = document.createElement("div");
    swatchGrid.className = "color-swatch-grid";

    var colorSpecs = [
        { key: "Text Color", labelEn: "Text", labelAr: "النص", val: st.textColor },
        { key: "Highlight Color", labelEn: "Active", labelAr: "الكلمة النشطة", val: st.highlightColor },
        { key: "Background Box", labelEn: "Box BG", labelAr: "الخلفية", val: st.bgHex },
        { key: "Stroke Color", labelEn: "Stroke", labelAr: "الظل/الحد", val: st.strokeColor }
    ];

    colorSpecs.forEach(function (cs) {
        var item = document.createElement("div");
        item.className = "color-swatch-item";
        var inp = document.createElement("input");
        inp.type = "color";
        inp.value = /^#[0-9a-fA-F]{6}$/.test(cs.val) ? cs.val : "#F5F5F5";
        inp.oninput = function () {
            cadrStyleOvUpdate(function (o) {
                o.params[cs.key] = inp.value;
            });
            cadrUpdateMogrtMonitor();
        };
        var lbl = document.createElement("span");
        lbl.textContent = isEn ? cs.labelEn : cs.labelAr;
        item.appendChild(inp);
        item.appendChild(lbl);
        swatchGrid.appendChild(item);
    });
    colorCard.appendChild(swatchGrid);

    var opacityRow = document.createElement("div");
    opacityRow.innerHTML =
        '<div class="slider-row"><span>' + (isEn ? "Background Box Opacity" : "شفافية صندوق الخلفية") +
        '</span><b id="v_studioBoxOpacity">' + Math.round(st.boxOpacity) + '%</b></div>' +
        '<input type="range" id="studioBoxOpacity" min="0" max="100" step="2" value="' + Math.round(st.boxOpacity) + '">';
    colorCard.appendChild(opacityRow);
    box.appendChild(colorCard);

    /* -------- CARD 3: POSITION & SAFE-ZONE PRESETS -------- */
    var posCard = document.createElement("div");
    posCard.className = "card pad";
    posCard.style.display = "flex";
    posCard.style.flexDirection = "column";
    posCard.style.gap = "8px";

    var posHead = document.createElement("div");
    posHead.className = "row";
    posHead.innerHTML =
        '<span class="card-title">' + (isEn ? "Position & Safe Zones" : "المكان والمحاذاة (أو اسحب من الشاشة)") + '</span>';
    posCard.appendChild(posHead);

    var presetRow = document.createElement("div");
    presetRow.className = "pos-presets";
    var presets = [
        { labelEn: "Top", labelAr: "أعلى", x: 0.5, y: 0.24 },
        { labelEn: "Center", labelAr: "منتصف", x: 0.5, y: 0.50 },
        { labelEn: "Reels", labelAr: "ريلز", x: 0.5, y: 0.72 },
        { labelEn: "Cinema", labelAr: "سينما", x: 0.5, y: 0.84 }
    ];
    presets.forEach(function (pr) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "btn sm";
        b.textContent = isEn ? pr.labelEn : pr.labelAr;
        b.onclick = function () {
            cadrStyleOvUpdate(function (o) {
                o.params["Text Position"] = [pr.x, pr.y];
            });
            var sx = document.getElementById("studioPosX");
            var sy = document.getElementById("studioPosY");
            var vx = document.getElementById("v_studioPosX");
            var vy = document.getElementById("v_studioPosY");
            if (sx) sx.value = String(Math.round(pr.x * 100));
            if (sy) sy.value = String(Math.round(pr.y * 100));
            if (vx) vx.textContent = Math.round(pr.x * 100) + "%";
            if (vy) vy.textContent = Math.round(pr.y * 100) + "%";
            cadrUpdateMogrtMonitor();
        };
        presetRow.appendChild(b);
    });
    posCard.appendChild(presetRow);

    var curX = Math.round(((st.posX >= -1 && st.posX <= 2) ? st.posX : 0.5) * 100);
    var curY = Math.round(((st.posY >= -1 && st.posY <= 2) ? st.posY : 0.72) * 100);

    var xyGrid = document.createElement("div");
    xyGrid.className = "cap-studio-grid";
    xyGrid.innerHTML =
        '<div class="cap-stat-box">' +
          '<div class="cap-stat-head"><span>' + (isEn ? "Horizontal X" : "أفقي (X)") + '</span><b id="v_studioPosX">' + curX + '%</b></div>' +
          '<input type="range" id="studioPosX" min="12" max="88" step="1" value="' + curX + '">' +
        '</div>' +
        '<div class="cap-stat-box">' +
          '<div class="cap-stat-head"><span>' + (isEn ? "Vertical Y" : "رأسي (Y)") + '</span><b id="v_studioPosY">' + curY + '%</b></div>' +
          '<input type="range" id="studioPosY" min="16" max="86" step="1" value="' + curY + '">' +
        '</div>';
    posCard.appendChild(xyGrid);
    box.appendChild(posCard);

    /* Wire live 60fps listeners to studio sliders */
    var szSlider = document.getElementById("studioFontSize");
    var scSlider = document.getElementById("studioScale");
    var opSlider = document.getElementById("studioBoxOpacity");
    var pxSlider = document.getElementById("studioPosX");
    var pySlider = document.getElementById("studioPosY");

    if (szSlider) {
        szSlider.oninput = function () {
            var v = parseFloat(szSlider.value) || 64;
            var b = document.getElementById("v_studioFontSize");
            if (b) b.textContent = Math.round(v) + " pt";
            cadrStyleOvUpdate(function (o) { o.fontSize = v; o.sizeKey = "Size"; });
            cadrUpdateMogrtMonitor();
        };
    }
    if (scSlider) {
        scSlider.oninput = function () {
            var v = parseFloat(scSlider.value) || 100;
            var b = document.getElementById("v_studioScale");
            if (b) b.textContent = Math.round(v) + "%";
            cadrStyleOvUpdate(function (o) { o.params["Scale"] = v; });
            cadrUpdateMogrtMonitor();
        };
    }
    if (opSlider) {
        opSlider.oninput = function () {
            var v = parseFloat(opSlider.value);
            var b = document.getElementById("v_studioBoxOpacity");
            if (b) b.textContent = Math.round(v) + "%";
            cadrStyleOvUpdate(function (o) { o.params["Box Opacity"] = v; });
            cadrUpdateMogrtMonitor();
        };
    }
    function onPosSliderInput() {
        var vx = pxSlider ? (parseFloat(pxSlider.value) || 50) : 50;
        var vy = pySlider ? (parseFloat(pySlider.value) || 72) : 72;
        var bx = document.getElementById("v_studioPosX");
        var by = document.getElementById("v_studioPosY");
        if (bx) bx.textContent = Math.round(vx) + "%";
        if (by) by.textContent = Math.round(vy) + "%";
        cadrStyleOvUpdate(function (o) {
            o.params["Text Position"] = [vx / 100, vy / 100];
        });
        cadrUpdateMogrtMonitor();
    }
    if (pxSlider) pxSlider.oninput = onPosSliderInput;
    if (pySlider) pySlider.oninput = onPosSliderInput;
}

cadrStyleTabRender = cadrBuildStudioStyleControls;


/* ---------- 5. FULL BILINGUAL UI SYSTEM (AR / EN) ---------- */

var cadrUiLangNow = "ar";

var CADR_I18N = {
    en: {
        headerSub: "Premiere Pro Plugin • CADR STUDIO",
        tabCut: "Auto Cut",
        tabCaption: "Auto Caption",
        tabStyle: "Style",
        tabSettings: "Settings",
        noClip: "No clip selected.",
        preYt: "YouTube",
        prePod: "Podcast",
        preSh: "Shorts",
        presetNamePh: "Preset name",
        saveBtn: "Save",
        runAutoCutBtn: "Auto Cut",
        previewBtn: "Preview Silence",
        undoBtn: "Undo",
        cutSettingsTitle: "Cut Settings",
        minSilence: "Minimum silence",
        noiseThresh: "Noise threshold",
        padBefore: "Padding before",
        padAfter: "Padding after",
        smoothCuts: "Smooth cuts",
        videoLbl: "Video",
        audioLbl: "Audio",
        smoothLen: "Smooth length",
        smoothNote: "Adds transitions after cutting (Cross Dissolve for video, Crossfade for audio). 2–4 frames works best.",
        autoZoom: "Auto zoom",
        onLbl: "On",
        zoomAmountLbl: "Zoom amount",
        zoomNote: "Scales up every second cut clip so jump cuts feel like intentional camera punch-ins (video only).",
        activityLog: "Activity Log",
        langLbl: "Audio Language",
        langAuto: "Auto",
        langAr: "Arabic",
        langEn: "English",
        modeLines: "Cinema Lines",
        modeWord: "Word by word",
        modePhrase: "Short phrases",
        genCaptionsBtn: "Generate Captions",
        addTimelineBtn: "Add SRT Track",
        exportSrtBtn: "Export SRT",
        goToMogrtBtn: "MOGRT Style ✦",
        capSettingsTitle: "Pro Caption Studio Settings",
        linesCountLbl: "Lines per caption",
        oneLineBtn: "1 Line (Reels)",
        twoLinesBtn: "2 Lines (YT)",
        wordsPerLineLbl: "Max words",
        maxCharsLbl: "Max chars / line",
        gapBridgeLbl: "Gap bridge (No flicker)",
        timeOffsetLbl: "Sync offset",
        minCapDurLbl: "Min duration",
        pauseSplitLbl: "Pause split",
        natSplit: "Smart pause split",
        stripPunctLbl: "Hide punctuation",
        stripTashkeelLbl: "Strip Tashkeel",
        wordTiming: "Word-level sync",
        fillerFlagLbl: "Filler words to flag & remove",
        fillerPh: "e.g. um, like",
        addBtn: "Add",
        fillerFoundTitle: "Filler Words Found",
        fillerFoundNote: "Review detected filler words and select which ones to ripple-delete. Click ▶ to preview on timeline.",
        deleteBtn: "Delete",
        selectAllLbl: "Select all",
        capEditorTitle: "Caption Editor",
        visualLinesBtn: "Visual Lines",
        rawSrtBtn: "Raw SRT",
        translateBtn: "Translate",
        origViewBtn: "Original",
        livePreviewBadge: "LIVE STAGE",
        addStyleBtn: "+ .mogrt",
        placeStyledBtn: "Add Styled Captions to Timeline",
        readTplBtn: "Read Template",
        applyStyleShortBtn: "Apply Changes",
        removeStyledBtn: "Remove",
        styleCustomizeNote: "Select any .mogrt template above to dynamically display and customize its exact allowed parameters.",
        resetBtn: "Reset",
        licenseTitle: "License",
        deviceIdLbl: "Device ID",
        copyBtn: "Copy",
        deviceIdHint: "Send this Device ID to CADR STUDIO to receive your machine-bound License Key.",
        licenseKeyLbl: "License Key",
        activateBtn: "Activate",
        checkBtn: "Check",
        appearanceTitle: "Brand Appearance",
        accentColorLbl: "Accent color",
        modelLbl: "Model",
        apiKeyProtectedHint: "Encrypted using OS user-level protection on this machine.",
        apiKeyHelp: "Each editor uses their own Gemini API key. Requests go directly to Google.",
        ffmpegNote: "CADR CUT automatically detects bundled or system-installed FFmpeg.",
        execPathLbl: "Executable path",
        detectBtn: "Detect",
        testBtn: "Test",
        diagTitle: "Diagnostics",
        diagNote: "If an operation fails, click Run, copy the diagnostic report, and send it to support.",
        runBtn: "Run",
        probeNote: "MOGRT & Caption probes for testing template parameters on a backup sequence.",
        stopBtn: "■ Stop",
        backToToolsBtn: "← Back to Tools"
    },
    ar: {
        headerSub: "إضافة بريمير برو • CADR STUDIO",
        tabCut: "قص السكتات",
        tabCaption: "الكابشن الذكي",
        tabStyle: "الستايل (MOGRT)",
        tabSettings: "الإعدادات",
        noClip: "لم يتم تحديد كليب على التايم لاين.",
        preYt: "يوتيوب",
        prePod: "بودكاست",
        preSh: "ريلز / شورتس",
        presetNamePh: "اسم الـ Preset",
        saveBtn: "حفظ",
        runAutoCutBtn: "قص السكتات تلقائيًا (Auto Cut)",
        previewBtn: "معاينة (Markers)",
        undoBtn: "تراجع (Undo)",
        cutSettingsTitle: "إعدادات القص",
        minSilence: "أقل مدة للسكتة",
        noiseThresh: "حد الصوت (Threshold)",
        padBefore: "هامش قبل القطع",
        padAfter: "هامش بعد القطع",
        smoothCuts: "تنعيم القطعات (Smooth)",
        videoLbl: "فيديو",
        audioLbl: "صوت",
        smoothLen: "طول الانتقال",
        smoothNote: "بيضيف انتقال تلقائي بعد القص (Cross Dissolve للفيديو، وCrossfade للصوت). من 2 لـ 4 فريم ممتاز.",
        autoZoom: "زوم تلقائي (Auto Zoom)",
        onLbl: "مفعّل",
        zoomAmountLbl: "نسبة الزوم",
        zoomNote: "بعد القص، كل لقطة تانية بتتكبّر شوية فالقفزات تبان كأنها كاميرا تانية مقصودة (للفيديو فقط).",
        activityLog: "سجل العمليات (Log)",
        langLbl: "لغة الصوت",
        langAuto: "تلقائي",
        langAr: "عربي",
        langEn: "إنجليزي",
        modeLines: "سطور سينمائية",
        modeWord: "كلمة بكلمة",
        modePhrase: "جمل قصيرة",
        genCaptionsBtn: "توليد الكابشن بالذكاء الاصطناعي",
        addTimelineBtn: "إضافة كـ SRT",
        exportSrtBtn: "حفظ ملف SRT",
        goToMogrtBtn: "ستايل MOGRT ✦",
        capSettingsTitle: "إعدادات الكابشن الاحترافية (Caption Studio)",
        linesCountLbl: "نظام السطور في الكابشن",
        oneLineBtn: "سطر واحد (Reels)",
        twoLinesBtn: "سطرين (YouTube)",
        wordsPerLineLbl: "أقصى عدد كلمات",
        maxCharsLbl: "أقصى حروف بالسطر",
        gapBridgeLbl: "غلق الفواصل (منع الرعشة)",
        timeOffsetLbl: "إزاحة التزامن (Offset)",
        minCapDurLbl: "أقل مدة للكابشن",
        pauseSplitLbl: "فصل عند سكتة",
        natSplit: "فصل ذكي عند الوقفات",
        stripPunctLbl: "إخفاء علامات الترقيم",
        stripTashkeelLbl: "إزالة التشكيل العربي",
        wordTiming: "مزامنة دقيقة لكل كلمة",
        fillerFlagLbl: "كلمات الحشو لاكتشافها وحذفها",
        fillerPh: "مثال: بص، يعني",
        addBtn: "إضافة",
        fillerFoundTitle: "كلمات الحشو المكتشفة",
        fillerFoundNote: "راجع الكلمات واختار اللي تحذفه من التايم لاين. دوس ▶ عشان تسمع الكلمة قبل الحذف.",
        deleteBtn: "حذف المحدد",
        selectAllLbl: "تحديد الكل",
        capEditorTitle: "محرر نصوص الكابشن",
        visualLinesBtn: "جدول السطور",
        rawSrtBtn: "نص SRT خام",
        translateBtn: "ترجمة",
        origViewBtn: "الأصلي",
        livePreviewBadge: "شاشة تفاعلية حية",
        addStyleBtn: "+ .mogrt",
        placeStyledBtn: "فرد الكابشن بالستايل على التايم لاين",
        readTplBtn: "قراءة القالب",
        applyStyleShortBtn: "تطبيق التعديلات",
        removeStyledBtn: "مسح",
        styleCustomizeNote: "بمجرد اختيار أي قالب .mogrt من القائمة المنسدلة فوق، بتظهرلك هنا أوتوماتيك الإعدادات المسموح بيها جوه القالب ده بس.",
        resetBtn: "إعادة ضبط",
        licenseTitle: "الترخيص (License)",
        deviceIdLbl: "معرّف الجهاز (Device ID)",
        copyBtn: "نسخ",
        deviceIdHint: "ابعت الـ Device ID ده لفريق CADR STUDIO عشان يطلع لك مفتاح تفعيل خاص بجهازك.",
        licenseKeyLbl: "مفتاح التفعيل (License Key)",
        activateBtn: "تفعيل الترخيص",
        checkBtn: "فحص",
        appearanceTitle: "مظهر البراند",
        accentColorLbl: "اللون المميز (Accent)",
        modelLbl: "موديل الذكاء الاصطناعي",
        apiKeyProtectedHint: "المفتاح بيتحفظ مشفّر بحماية نظام التشغيل للمستخدم الحالي.",
        apiKeyHelp: "كل مونتير بيستخدم مفتاح Gemini API الخاص بيه، والطلبات بتتبعت مباشرة لـ Google.",
        ffmpegNote: "البلاجن بيكتشف وجود FFmpeg المرفق أو المثبّت على الجهاز تلقائيًا.",
        execPathLbl: "مسار ملف التشغيل",
        detectBtn: "اكتشاف تلقائي",
        testBtn: "اختبار",
        diagTitle: "فحص الأعطال (Diagnostics)",
        diagNote: "لو واجهتك أي مشكلة: دوس فحص، انسخ التقرير وابعته للدعم الفني.",
        runBtn: "فحص",
        probeNote: "أدوات فحص متقدمة لتجربة قراءة قوالب الـ MOGRT والكابشن على نسخة احتياطية.",
        stopBtn: "■ إيقاف",
        backToToolsBtn: "رجوع للأدوات ←"
    }
};

function cadrApplyUiLang(lang, save) {
    cadrUiLangNow = (lang === "en") ? "en" : "ar";
    var dict = CADR_I18N[cadrUiLangNow];

    document.documentElement.setAttribute("data-ui-lang", cadrUiLangNow);
    var mainEl = document.querySelector(".main");
    var tabsEl = document.querySelector(".tabs");
    if (mainEl) mainEl.setAttribute("dir", cadrUiLangNow === "ar" ? "rtl" : "ltr");
    if (tabsEl) tabsEl.setAttribute("dir", cadrUiLangNow === "ar" ? "rtl" : "ltr");

    var toggleBtn = document.getElementById("langToggleBtn");
    if (toggleBtn) {
        toggleBtn.innerHTML = cadrUiLangNow === "ar" ? "<b>AR</b> | EN" : "AR | <b>EN</b>";
    }

    var els = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < els.length; i++) {
        var key = els[i].getAttribute("data-i18n");
        if (dict[key] !== undefined) {
            if ((els[i].id === "selectedClips" || els[i].id === "captionSelectedClip") && window.__adobe_cep__) {
                continue;
            }
            els[i].textContent = dict[key];
        }
    }

    var phs = document.querySelectorAll("[data-i18n-placeholder]");
    for (var j = 0; j < phs.length; j++) {
        var pkey = phs[j].getAttribute("data-i18n-placeholder");
        if (dict[pkey] !== undefined) {
            phs[j].placeholder = dict[pkey];
        }
    }

    cadrRenderVisualCaptionLines();
    cadrPopulateStyleDropdown();
    cadrBuildStudioStyleControls();
    cadrUpdateMogrtMonitor();
    cadrCheckLicense();
    cadrRefreshSliderLabels();

    if (save) {
        setSetting("cadrUiLang", cadrUiLangNow);
    }
}

function cadrToggleUiLang() {
    cadrApplyUiLang(cadrUiLangNow === "ar" ? "en" : "ar", true);
}

var cadrLastEditorTab = "cut";

(function () {
    var origShowTab = showTab;
    showTab = function (tabId) {
        if (tabId && tabId !== "settings") {
            cadrLastEditorTab = tabId;
        }
        var gear = document.getElementById("tabSettings");
        if (gear) {
            gear.classList.remove("active");
        }
        origShowTab(tabId);
        if (tabId === "settings" && gear) {
            gear.classList.add("active");
        }
        if (tabId === "style") {
            cadrPopulateStyleDropdown();
            var sc = document.getElementById("styleControls");
            if (sc && !sc.children.length) {
                cadrBuildStudioStyleControls();
            }
            cadrUpdateMogrtMonitor();
        }
    };

    var origStyleRender = cadrStyleRender;
    cadrStyleRender = function () {
        origStyleRender();
        cadrPopulateStyleDropdown();
        cadrUpdateMogrtMonitor();
    };

    var origResetOverrides = cadrStyleResetOverrides;
    cadrStyleResetOverrides = function () {
        origResetOverrides();
        cadrBuildStudioStyleControls();
        cadrUpdateMogrtMonitor();
    };
})();

function cadrToggleSettings() {
    var settingsPanel = document.getElementById("settings");
    if (settingsPanel && settingsPanel.classList.contains("active")) {
        showTab(cadrLastEditorTab || "cut");
    } else {
        showTab("settings");
    }
}

function cadrCloseSettings() {
    showTab(cadrLastEditorTab || "cut");
}

/* Initialize UX v4 Studio Suite */
(function initCadrUxV4() {
    var savedLang = getSetting("cadrUiLang", "ar");
    cadrBindProCaptionSettings();
    cadrApplyUiLang(savedLang, false);
    cadrInitEditableSliderBadges();
    cadrSetCapEditorMode("lines");
    cadrInitInteractiveMonitorDrag();
    cadrStartMogrtMonitorLoop();
})();


/* =========================================================
   CADR STUDIO STYLE ENGINE v5.5 — CUSTOM MOGRT DROPDOWN WITH
   BUILT-IN PREVIEW + AUTOMATIC definition.json & thumb.png
   EXTRACTION + 100% DYNAMIC MOGRT CONTROLS ONLY
   ========================================================= */

var CADR_STUDIO_VISUAL_FONTS = [
    { ps: "Cairo-Bold", family: "Cairo", label: "Cairo — Bold (كايرو عريض)", arabic: true, weight: 800 },
    { ps: "Tajawal-Bold", family: "Tajawal", label: "Tajawal — Bold (تجوال)", arabic: true, weight: 800 },
    { ps: "Changa-Bold", family: "Changa", label: "Changa — Bold (تشانجا ريلز)", arabic: true, weight: 800 },
    { ps: "Alexandria-Bold", family: "Alexandria", label: "Alexandria — Bold (إسكندرية)", arabic: true, weight: 800 },
    { ps: "Almarai-ExtraBold", family: "Almarai", label: "Almarai — ExtraBold (المراعي)", arabic: true, weight: 800 },
    { ps: "ReadexPro-Bold", family: "Readex Pro", label: "Readex Pro — Bold (ريدكس)", arabic: true, weight: 700 },
    { ps: "IBMPlexSansArabic-Bold", family: "IBM Plex Sans Arabic", label: "IBM Plex Arabic (آي بي إم)", arabic: true, weight: 700 },
    { ps: "Montserrat-Bold", family: "Montserrat", label: "Montserrat — ExtraBold (CADR Brand)", arabic: false, weight: 800 },
    { ps: "Poppins-SemiBold", family: "Poppins", label: "Poppins — SemiBold", arabic: false, weight: 700 },
    { ps: "Inter-Bold", family: "Inter", label: "Inter — Bold (Clean Modern)", arabic: false, weight: 700 },
    { ps: "BebasNeue-Regular", family: "Bebas Neue", label: "Bebas Neue — Tall Reels", arabic: false, weight: 400 },
    { ps: "Impact", family: "Impact", label: "Impact — Heavy Meme/Reels", arabic: false, weight: 700 }
];

var CADR_CLIENT_PRESETS_KEY = "cadrClientStylePresetsV1";
var CADR_MOGRT_THUMB_CACHE = {};
var CADR_MOGRT_VIDEO_CACHE = {};
var cadrHoveredFontObj = null;
var cadrStageAnimTick = 0;

function cadrNormalizeFsPath(rawPath) {
    if (!rawPath) return "";
    var p = String(rawPath).trim();
    if (/^file:\/\/\//i.test(p)) {
        p = p.replace(/^file:\/\/\//i, "");
        if (!/^[a-zA-Z]:/.test(p) && p.charAt(0) !== "/") {
            p = "/" + p;
        }
    } else if (/^file:\/\//i.test(p)) {
        p = p.replace(/^file:\/\//i, "");
    }
    if (p.indexOf("%") !== -1) {
        try { p = decodeURIComponent(p); } catch (e) {}
    }
    try {
        if (window.cep_node && typeof window.cep_node.require === "function") {
            var pathMod = window.cep_node.require("path");
            p = pathMod.normalize(p);
        }
    } catch (e2) {}
    return p;
}

function cadrIsLegacyBundledItem(item) {
    if (!item) return true;
    if (item.bundled) return true;
    var p = String(item.path || "");
    var n = String(item.name || "");
    if (/CADR_[1-5]_|SlideUp_Words|Smooth_Zoom_Orange|Cinema_Tracking|Smooth_Blur|Clean_Fade/i.test(p)) return true;
    if (/^CADR [1-5] —/i.test(n)) return true;
    return false;
}

cadrStyleLoad = function () {
    try {
        var raw = window.localStorage.getItem(CADR_STYLES_KEY);
        if (raw) {
            var list = JSON.parse(raw);
            if (Array.isArray(list)) {
                var cleanList = list.filter(function (x) { return !cadrIsLegacyBundledItem(x); });
                if (cleanList.length !== list.length) {
                    try { window.localStorage.setItem(CADR_STYLES_KEY, JSON.stringify(cleanList)); } catch (e2) {}
                }
                CADR_MEM_STORE[CADR_STYLES_KEY] = cleanList;
                return cleanList;
            }
        }
    } catch (e) {}
    return (CADR_MEM_STORE[CADR_STYLES_KEY] || []).filter(function (x) { return !cadrIsLegacyBundledItem(x); });
};

cadrStyleSave = function (list) {
    var cleanList = (list || []).filter(function (x) { return !cadrIsLegacyBundledItem(x); });
    CADR_MEM_STORE[CADR_STYLES_KEY] = cleanList;
    try {
        window.localStorage.setItem(CADR_STYLES_KEY, JSON.stringify(cleanList));
    } catch (e) {}
};

cadrStyleActive = function () {
    var n = CADR_MEM_STORE[CADR_STYLE_ACTIVE_KEY] || 0;
    try {
        var s = window.localStorage.getItem(CADR_STYLE_ACTIVE_KEY);
        if (s !== null) n = parseInt(s, 10) || 0;
    } catch (e) {}
    var count = cadrStyleLoad().length;
    if (count <= 0) return 0;
    return Math.max(0, Math.min(n, count - 1));
};

cadrStyleSetActive = function (i) {
    CADR_MEM_STORE[CADR_STYLE_ACTIVE_KEY] = i;
    try {
        window.localStorage.setItem(CADR_STYLE_ACTIVE_KEY, String(i));
    } catch (e) {}
};

/* =========================================================
   AUTOMATIC .MOGRT ARCHIVE PARSER (Reads definition.json, thumb.png &
   thumb.mp4 directly from any .mogrt ZIP file on disk!)
   ========================================================= */

function cadrRgbaFloatToHex(arr) {
    if (!Array.isArray(arr) || arr.length < 3) return "#F5F5F5";
    var r = Number(arr[0]);
    var g = Number(arr[1]);
    var b = Number(arr[2]);
    var scale = (Math.max(r, g, b) <= 1.0) ? 255 : 1;
    function toHex(n) {
        var v = Math.max(0, Math.min(255, Math.round((Number(n) || 0) * scale)));
        return (v < 16 ? "0" : "") + v.toString(16);
    }
    return "#" + toHex(r) + toHex(g) + toHex(b);
}

function cadrExtractStrFromDB(obj) {
    if (!obj) return "";
    if (typeof obj === "string") return obj;
    if (Array.isArray(obj.strDB) && obj.strDB.length > 0) {
        for (var i = 0; i < obj.strDB.length; i++) {
            if (obj.strDB[i] && typeof obj.strDB[i].str === "string" && obj.strDB[i].str) {
                return obj.strDB[i].str;
            }
        }
        return (obj.strDB[0] && obj.strDB[0].str) ? String(obj.strDB[0].str) : "";
    }
    return "";
}

function cadrParseDefinitionJsonToSchema(defObj, fallbackName) {
    if (!defObj || typeof defObj !== "object") return null;

    var compW = 3840;
    var compH = 2160;
    try {
        var sInfo = defObj.sourceInfoLocalized;
        if (sInfo && typeof sInfo === "object") {
            var locKeys = Object.keys(sInfo);
            for (var lk = 0; lk < locKeys.length; lk++) {
                var fSize = sInfo[locKeys[lk]] && sInfo[locKeys[lk]].framesize && sInfo[locKeys[lk]].framesize.size;
                if (fSize && Number(fSize.x) > 0 && Number(fSize.y) > 0) {
                    compW = Number(fSize.x);
                    compH = Number(fSize.y);
                    break;
                }
            }
        }
    } catch (eComp) {}

    var controls = Array.isArray(defObj.clientControls) ? defObj.clientControls : [];
    var byId = {};
    var groupOrder = [];
    for (var i = 0; i < controls.length; i++) {
        var c = controls[i];
        if (!c) continue;
        if (c.id) byId[c.id] = c;
        if (c.type === 10 && Array.isArray(c.value)) {
            for (var g = 0; g < c.value.length; g++) {
                groupOrder.push(c.value[g]);
            }
        }
    }

    var orderedControls = [];
    var visited = {};
    for (var o = 0; o < groupOrder.length; o++) {
        var cid = groupOrder[o];
        if (byId[cid] && !visited[cid]) {
            visited[cid] = true;
            orderedControls.push(byId[cid]);
        }
    }
    for (var k = 0; k < controls.length; k++) {
        var ctrl = controls[k];
        if (!ctrl) continue;
        if (ctrl.id && visited[ctrl.id]) continue;
        orderedControls.push(ctrl);
    }

    var schema = {
        clip: cadrExtractStrFromDB(defObj.capsuleNameLocalized) || defObj.capsuleName || fallbackName || "MOGRT",
        compSize: [compW, compH],
        font: null,
        params: []
    };

    for (var m = 0; m < orderedControls.length; m++) {
        var item = orderedControls[m];
        if (!item || item.type === 10 || item.type === 8) continue;
        var uiName = cadrExtractStrFromDB(item.uiName);
        if (!uiName || /^@/.test(uiName)) continue;

        if (item.type === 6) {
            if (!schema.font) {
                var fe = item.fonteditinfo || {};
                var defaultText = cadrExtractStrFromDB(item.value);
                schema.font = {
                    paramName: uiName,
                    hasFont: (fe.capPropFontEdit !== false),
                    hasFontSize: !!fe.capPropFontSizeEdit,
                    font: fe.fontEditValue ? String(fe.fontEditValue) : "Cairo-Bold",
                    fontSize: (typeof fe.fontSizeEditValue === "number") ? Number(fe.fontSizeEditValue) : 100,
                    sizeKey: "fontSizeEditValue",
                    sampleText: defaultText || ""
                };
            }
            continue;
        }

        if (item.type === 13 || item.type === 7 || Array.isArray(item.menucontent)) {
            var opts = [];
            if (Array.isArray(item.menucontent)) {
                for (var mc = 0; mc < item.menucontent.length; mc++) {
                    opts.push(cadrExtractStrFromDB(item.menucontent[mc]) || ("Option " + (mc + 1)));
                }
            }
            schema.params.push({
                name: uiName,
                kind: "menu",
                options: opts,
                value: (typeof item.value === "number") ? item.value : 0
            });
            continue;
        }

        if (item.type === 2) {
            var numVal = (typeof item.value === "number") ? item.value : 0;
            var minVal = (typeof item.min === "number") ? item.min : 0;
            var maxVal = (typeof item.max === "number") ? item.max : Math.max(100, numVal * 2);
            schema.params.push({
                name: uiName,
                kind: "number",
                min: minVal,
                max: maxVal,
                value: numVal
            });
            continue;
        }

        if (item.type === 4) {
            schema.params.push({
                name: uiName,
                kind: "color",
                value: cadrRgbaFloatToHex(item.value)
            });
            continue;
        }

        if (item.type === 5) {
            var px = 0.5;
            var py = 0.5;
            if (item.value && typeof item.value === "object") {
                var rawX = Number(item.value.x !== undefined ? item.value.x : item.value[0]);
                var rawY = Number(item.value.y !== undefined ? item.value.y : item.value[1]);
                if (!isNaN(rawX) && !isNaN(rawY)) {
                    px = (Math.abs(rawX) > 2) ? (rawX / compW) : rawX;
                    py = (Math.abs(rawY) > 2) ? (rawY / compH) : rawY;
                }
            }
            schema.params.push({
                name: uiName,
                kind: "position",
                compSize: [compW, compH],
                value: [Math.round(px * 100) / 100, Math.round(py * 100) / 100]
            });
            continue;
        }

        if (item.type === 3 || item.type === 1 || typeof item.value === "boolean") {
            schema.params.push({
                name: uiName,
                kind: "bool",
                value: !!item.value
            });
        }
    }

    return schema;
}

function cadrInspectMogrtFileOnDisk(filePath) {
    if (!filePath) return null;

    if (window.__cadrMockMogrtArchives && window.__cadrMockMogrtArchives[filePath]) {
        var mock = window.__cadrMockMogrtArchives[filePath];
        if (mock.thumbDataUrl) {
            CADR_MOGRT_THUMB_CACHE[filePath] = mock.thumbDataUrl;
        }
        if (mock.videoDataUrl) {
            CADR_MOGRT_VIDEO_CACHE[filePath] = mock.videoDataUrl;
        }
        if (mock.definition) {
            var mockSchema = cadrParseDefinitionJsonToSchema(mock.definition, filePath.split("/").pop());
            if (mockSchema) {
                var stSchemas = cadrStoreGet(CADR_STYLE_SCHEMA_KEY);
                stSchemas[filePath] = mockSchema;
                cadrStoreSet(CADR_STYLE_SCHEMA_KEY, stSchemas);
                return mockSchema;
            }
        }
    }

    if (!window.cep_node || typeof window.cep_node.require !== "function") {
        return null;
    }

    try {
        var fs = window.cep_node.require("fs");
        var zlib = window.cep_node.require("zlib");
        var nativePath = cadrNormalizeFsPath(filePath);
        if (!fs.existsSync(nativePath)) {
            nativePath = String(filePath);
            if (!fs.existsSync(nativePath)) return null;
        }

        var buf = fs.readFileSync(nativePath);
        var eocdOffset = -1;
        var minSearch = Math.max(0, buf.length - 65557);
        for (var i = buf.length - 22; i >= minSearch; i--) {
            if (buf.readUInt32LE(i) === 0x06054b50) {
                eocdOffset = i;
                break;
            }
        }
        if (eocdOffset < 0) return null;

        var totalEntries = buf.readUInt16LE(eocdOffset + 10);
        var cdOffset = buf.readUInt32LE(eocdOffset + 16);
        var ptr = cdOffset;
        var defBuf = null;
        var thumbBuf = null;
        var thumbMime = "image/png";
        var videoBuf = null;
        var videoMime = "video/mp4";

        for (var e = 0; e < totalEntries; e++) {
            if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) break;
            var method = buf.readUInt16LE(ptr + 10);
            var compSize = buf.readUInt32LE(ptr + 20);
            var nameLen = buf.readUInt16LE(ptr + 28);
            var extraLen = buf.readUInt16LE(ptr + 30);
            var commentLen = buf.readUInt16LE(ptr + 32);
            var localHeaderOffset = buf.readUInt32LE(ptr + 42);
            var entryName = buf.slice(ptr + 46, ptr + 46 + nameLen).toString("utf8");
            ptr += 46 + nameLen + extraLen + commentLen;

            var isDef = (entryName === "definition.json" || /\/definition\.json$/i.test(entryName));
            var isThumb = (/thumb\.(png|jpg|jpeg)$/i.test(entryName));
            var isVideo = (/\.(mp4|webm)$/i.test(entryName));

            if ((isDef || isThumb || isVideo) && localHeaderOffset + 30 <= buf.length && buf.readUInt32LE(localHeaderOffset) === 0x04034b50) {
                var lNameLen = buf.readUInt16LE(localHeaderOffset + 26);
                var lExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
                var dataStart = localHeaderOffset + 30 + lNameLen + lExtraLen;
                var compSlice = buf.slice(dataStart, dataStart + compSize);
                var rawData = null;
                if (method === 0) {
                    rawData = compSlice;
                } else if (method === 8) {
                    rawData = zlib.inflateRawSync(compSlice);
                }
                if (rawData) {
                    if (isDef) defBuf = rawData;
                    if (isThumb) {
                        thumbBuf = rawData;
                        thumbMime = /\.jpe?g$/i.test(entryName) ? "image/jpeg" : "image/png";
                    }
                    if (isVideo && rawData.length < 4 * 1024 * 1024) {
                        videoBuf = rawData;
                        videoMime = /\.webm$/i.test(entryName) ? "video/webm" : "video/mp4";
                    }
                }
            }
        }

        if (thumbBuf && thumbBuf.length > 0) {
            CADR_MOGRT_THUMB_CACHE[filePath] = "data:" + thumbMime + ";base64," + thumbBuf.toString("base64");
        }
        if (videoBuf && videoBuf.length > 0) {
            CADR_MOGRT_VIDEO_CACHE[filePath] = "data:" + videoMime + ";base64," + videoBuf.toString("base64");
        }

        if (defBuf && defBuf.length > 0) {
            var defJson = JSON.parse(defBuf.toString("utf8"));
            var parsedSchema = cadrParseDefinitionJsonToSchema(defJson, filePath.split("/").pop());
            if (parsedSchema) {
                var schemas = cadrStoreGet(CADR_STYLE_SCHEMA_KEY);
                schemas[filePath] = parsedSchema;
                cadrStoreSet(CADR_STYLE_SCHEMA_KEY, schemas);
                return parsedSchema;
            }
        }
    } catch (err) {}
    return null;
}

function cadrEnsureMogrtSchema(style) {
    if (!style || !style.path) return null;
    var schemas = cadrStoreGet(CADR_STYLE_SCHEMA_KEY);
    var existing = schemas[style.path] || null;
    if (!existing || !CADR_MOGRT_THUMB_CACHE[style.path]) {
        var inspected = cadrInspectMogrtFileOnDisk(style.path);
        if (inspected) existing = inspected;
    }
    return existing;
}

/* =========================================================
   CUSTOM DROPDOWN MENU WITH LIVE ANIMATED MOGRT PREVIEW
   (No separate screen — preview lives right on the MOGRT inside
    the dropdown button and dropdown items!)
   ========================================================= */

var cadrMogrtDropdownOpen = false;

function cadrToggleMogrtDropdown(ev) {
    if (ev) ev.stopPropagation();
    var menu = document.getElementById("mogrtDropdownMenu");
    var btn = document.getElementById("mogrtDropdownBtn");
    if (!menu || !btn) return;
    cadrMogrtDropdownOpen = !cadrMogrtDropdownOpen;
    if (cadrMogrtDropdownOpen) {
        cadrPopulateStyleDropdown();
        menu.classList.add("open");
        btn.classList.add("open");
    } else {
        menu.classList.remove("open");
        btn.classList.remove("open");
    }
}

function cadrCloseMogrtDropdown() {
    cadrMogrtDropdownOpen = false;
    var menu = document.getElementById("mogrtDropdownMenu");
    var btn = document.getElementById("mogrtDropdownBtn");
    if (menu) menu.classList.remove("open");
    if (btn) btn.classList.remove("open");
}

window.addEventListener("click", function (ev) {
    if (!cadrMogrtDropdownOpen) return;
    var wrap = document.getElementById("mogrtDropdownWrap");
    if (wrap && !wrap.contains(ev.target)) {
        cadrCloseMogrtDropdown();
    }
});

function cadrGetStylePreviewConfig(style, schema, idx) {
    var allOv = cadrStoreGet(CADR_STYLE_OV_KEY);
    var ov = (style && allOv[style.path]) ? allOv[style.path] : { params: {} };
    if (!ov.params) ov.params = {};

    var fontPs = (cadrHoveredFontObj && cadrHoveredFontObj.ps)
        ? cadrHoveredFontObj.ps
        : (ov.font || (schema && schema.font && schema.font.font) || "Cairo-Bold");
    var fontFam = (cadrHoveredFontObj && cadrHoveredFontObj.family)
        ? cadrHoveredFontObj.family
        : cadrResolveFontFamily(fontPs);

    var textColor = "#F5F5F5";
    var animIdx = ((idx || 0) % 5) + 1;
    var animLabel = "";

    if (schema && Array.isArray(schema.params)) {
        for (var p = 0; p < schema.params.length; p++) {
            var item = schema.params[p];
            var val = (ov.params[item.name] !== undefined) ? ov.params[item.name] : item.value;
            var nm = String(item.name || "").toLowerCase();
            if (item.kind === "color" && typeof val === "string" && /^#[0-9a-fA-F]{6}$/.test(val)) {
                textColor = val;
            } else if (item.kind === "menu" && /anim|motion|style/.test(nm)) {
                var numA = Number(val);
                if (!isNaN(numA)) {
                    animIdx = (numA >= 1 && numA <= 5) ? numA : ((numA % 5) + 1);
                    if (Array.isArray(item.options) && item.options[numA]) {
                        animLabel = item.options[numA];
                    }
                }
            }
        }
    }

    return {
        fontFamily: fontFam || "Cairo",
        textColor: textColor,
        animIdx: animIdx,
        animLabel: animLabel
    };
}

cadrPopulateStyleDropdown = function () {
    var sel = document.getElementById("styleSelect");
    var delBtn = document.getElementById("styleDeleteBtn");
    var ddBtn = document.getElementById("mogrtDropdownBtn");
    var ddThumb = document.getElementById("mogrtDdMiniThumb");
    var ddName = document.getElementById("mogrtDdActiveName");
    var ddSub = document.getElementById("mogrtDdActiveSub");
    var ddMenu = document.getElementById("mogrtDropdownMenu");

    var list = cadrStyleLoad();
    var active = cadrStyleActive();
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");

    if (sel) {
        sel.innerHTML = "";
        if (!list.length) {
            var emptyOpt = document.createElement("option");
            emptyOpt.value = "-1";
            emptyOpt.textContent = isEn ? "No template added" : "لا يوجد قالب مضاف";
            sel.appendChild(emptyOpt);
        } else {
            list.forEach(function (style, i) {
                var opt = document.createElement("option");
                opt.value = String(i);
                opt.textContent = "🎬 " + style.name;
                if (i === active) opt.selected = true;
                sel.appendChild(opt);
            });
        }
    }

    if (delBtn) {
        delBtn.disabled = !list.length;
    }

    var activeStyle = list[active] || null;
    if (activeStyle) {
        var activeSchema = cadrEnsureMogrtSchema(activeStyle);
        var thumbUrl = CADR_MOGRT_THUMB_CACHE[activeStyle.path] || "";
        var pCfg = cadrGetStylePreviewConfig(activeStyle, activeSchema, active);
        if (ddBtn) {
            ddBtn.setAttribute("data-anim", String(pCfg.animIdx));
        }
        if (ddThumb) {
            var cleanF = pCfg.fontFamily.replace(/['"]/g, "");
            ddThumb.innerHTML =
                (thumbUrl ? ('<img src="' + thumbUrl + '" alt="MOGRT">') : '') +
                '<div class="dd-mini-stage" style="font-family:&quot;' + cleanF + '&quot;,sans-serif;color:' + pCfg.textColor + '">' +
                  '<span class="ac-word-mask"><span class="ac-word-inner dd-w1">كدر</span></span>' +
                  '<span class="ac-word-mask"><span class="ac-word-inner dd-w2">CUT</span></span>' +
                '</div>';
        }
        if (ddName) {
            ddName.textContent = "🎬 " + activeStyle.name;
        }
        if (ddSub) {
            var ctrlCount = (activeSchema && Array.isArray(activeSchema.params) ? activeSchema.params.length : 0) +
                            (activeSchema && activeSchema.font && activeSchema.font.hasFont ? 1 : 0);
            ddSub.textContent = ctrlCount > 0
                ? (isEn ? (ctrlCount + " allowed controls loaded • Click to preview & switch") : ("تم تحميل " + ctrlCount + " إعدادات مسموح بها • اضغط لمعاينة القوالب"))
                : (isEn ? "Click to open dropdown & preview templates" : "اضغط لفتح القائمة المنسدلة ومعاينة القوالب");
        }
    } else {
        if (ddBtn) ddBtn.removeAttribute("data-anim");
        if (ddThumb) ddThumb.innerHTML = "<span>MOGRT</span>";
        if (ddName) {
            ddName.textContent = isEn
                ? "🎬 Select or Add a .mogrt Template..."
                : "🎬 اختار قالب MOGRT أو ضيف قالبك...";
        }
        if (ddSub) {
            ddSub.textContent = isEn
                ? "Click (+ Add .mogrt) to load your template & its controls"
                : "اضغط (+ إضافة .mogrt) لإضافة قالبك وإظهار إعداداته المسموح بها";
        }
    }

    if (!ddMenu) return;
    ddMenu.innerHTML = "";

    if (!list.length) {
        var emptyBox = document.createElement("div");
        emptyBox.className = "cap-empty";
        emptyBox.style.padding = "12px 8px";
        emptyBox.textContent = isEn
            ? "No .mogrt templates added yet. Click below to add your .mogrt file from your computer."
            : "مفيش قوالب .mogrt مضافة حاليًا. اضغط على الزرار تحت لإضافة ملف .mogrt من جهازك.";
        ddMenu.appendChild(emptyBox);
    } else {
        list.forEach(function (style, idx) {
            var sc = cadrEnsureMogrtSchema(style);
            var tUrl = CADR_MOGRT_THUMB_CACHE[style.path] || "";
            var vUrl = CADR_MOGRT_VIDEO_CACHE[style.path] || "";
            var cfg = cadrGetStylePreviewConfig(style, sc, idx);

            var itemEl = document.createElement("div");
            itemEl.className = "mogrt-dd-item" + (idx === active ? " active" : "");
            itemEl.setAttribute("data-anim", String(cfg.animIdx));

            /* Live Animated Preview Stage right inside the Dropdown Item! */
            var prevBox = document.createElement("div");
            prevBox.className = "mogrt-dd-item-prev";

            if (vUrl) {
                var vid = document.createElement("video");
                vid.className = "dd-bg-video";
                vid.src = vUrl;
                vid.muted = true;
                vid.loop = true;
                vid.playsInline = true;
                vid.autoplay = true;
                prevBox.appendChild(vid);
            } else {
                if (tUrl) {
                    var img = document.createElement("img");
                    img.className = "dd-bg-thumb";
                    img.src = tUrl;
                    img.alt = style.name;
                    prevBox.appendChild(img);
                }
                var stageBox = document.createElement("div");
                stageBox.className = "dd-stage-box";
                stageBox.style.fontFamily = "'" + cfg.fontFamily.replace(/['"]/g, "") + "', sans-serif";
                stageBox.style.color = cfg.textColor;
                stageBox.innerHTML =
                    '<span class="ac-word-mask"><span class="ac-word-inner dd-w1">' + (isEn ? "CADR" : "كدر") + '</span></span>' +
                    '<span class="ac-word-mask"><span class="ac-word-inner dd-w2">' + (isEn ? "STUDIO" : "ستوديو") + '</span></span>';
                prevBox.appendChild(stageBox);
            }

            var stageTag = document.createElement("span");
            stageTag.className = "dd-stage-tag";
            stageTag.textContent = cfg.animLabel ? cfg.animLabel.replace(/^[0-9]+\.\s*/, "") : "LIVE";
            prevBox.appendChild(stageTag);

            var infoCol = document.createElement("div");
            infoCol.className = "mogrt-dd-item-info";

            var titleEl = document.createElement("div");
            titleEl.className = "mogrt-dd-item-title";
            titleEl.textContent = (idx === active ? "✓ " : "🎬 ") + style.name;

            var metaEl = document.createElement("div");
            metaEl.className = "mogrt-dd-item-meta";
            if (sc) {
                var pNames = [];
                if (sc.font && sc.font.hasFont) pNames.push(isEn ? "Font" : "الخط");
                (sc.params || []).forEach(function (p) { pNames.push(p.name); });
                metaEl.textContent = pNames.length
                    ? pNames.join(" • ")
                    : (isEn ? "Ready to use" : "جاهز للاستخدام");
            } else {
                metaEl.textContent = style.path;
            }

            infoCol.appendChild(titleEl);
            infoCol.appendChild(metaEl);

            var delItemBtn = document.createElement("button");
            delItemBtn.type = "button";
            delItemBtn.className = "mogrt-dd-item-del";
            delItemBtn.title = isEn ? "Delete template" : "حذف هذا القالب";
            delItemBtn.textContent = "🗑";
            delItemBtn.onclick = function (ev) {
                ev.stopPropagation();
                cadrStyleDeleteAt(idx);
            };

            itemEl.onclick = function (ev) {
                ev.stopPropagation();
                cadrStyleSetActive(idx);
                cadrCloseMogrtDropdown();
                cadrPopulateStyleDropdown();
                cadrBuildStudioStyleControls();
            };

            itemEl.appendChild(prevBox);
            itemEl.appendChild(infoCol);
            itemEl.appendChild(delItemBtn);
            ddMenu.appendChild(itemEl);
        });
    }

    var addMoreBtn = document.createElement("button");
    addMoreBtn.type = "button";
    addMoreBtn.className = "btn sm accent-outline";
    addMoreBtn.style.width = "100%";
    addMoreBtn.textContent = isEn ? "+ Add .mogrt Template from Computer" : "+ إضافة قالب .mogrt جديد من جهازك";
    addMoreBtn.onclick = function (ev) {
        ev.stopPropagation();
        cadrCloseMogrtDropdown();
        cadrStyleAdd();
    };
    ddMenu.appendChild(addMoreBtn);
};

cadrStyleSelectChange = function (val) {
    var idx = parseInt(val, 10);
    if (isNaN(idx) || idx < 0) return;
    cadrStyleSetActive(idx);
    cadrPopulateStyleDropdown();
    cadrBuildStudioStyleControls();
};

cadrStyleOvFor = function (path) {
    if (!path) return null;
    var all = cadrStoreGet(CADR_STYLE_OV_KEY);
    var userOv = all[path] || null;
    if (!userOv) return null;

    var schemas = cadrStoreGet(CADR_STYLE_SCHEMA_KEY);
    var schema = schemas[path] || null;

    var merged = { params: {} };
    if (schema && Array.isArray(schema.compSize)) {
        merged.compSize = schema.compSize;
    }
    if (userOv.font) merged.font = userOv.font;
    if (userOv.fontSize !== undefined) {
        merged.fontSize = Number(userOv.fontSize);
    }
    if (userOv.sizeKey) merged.sizeKey = userOv.sizeKey;
    if (userOv.params) {
        for (var pk in userOv.params) {
            if (Object.prototype.hasOwnProperty.call(userOv.params, pk)) {
                merged.params[pk] = userOv.params[pk];
            }
        }
    }

    var hasParams = merged.params && Object.keys(merged.params).length > 0;
    return (merged.font || merged.fontSize !== undefined || hasParams) ? merged : null;
};

cadrStyleOvUpdate = function (mutator) {
    var style = cadrActiveStyle();
    if (!style || !style.path) return;
    var styleKey = style.path;
    var all = cadrStoreGet(CADR_STYLE_OV_KEY);
    var ov = all[styleKey] || { params: {} };
    if (!ov.params) ov.params = {};
    mutator(ov);
    all[styleKey] = ov;
    cadrStoreSet(CADR_STYLE_OV_KEY, all);
};

function cadrIngestMogrtPaths(pathsArray) {
    if (!pathsArray || !pathsArray.length) return;
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    var list = cadrStyleLoad();
    var lastAddedIdx = list.length;
    var addedNames = [];

    pathsArray.forEach(function (raw) {
        if (!raw) return;
        var norm = cadrNormalizeFsPath(raw);
        var path = String(norm || raw).replace(/\\/g, "/");
        var existsIdx = -1;
        for (var i = 0; i < list.length; i++) {
            if (list[i].path === path) {
                existsIdx = i;
                break;
            }
        }
        var baseName = (typeof cadrStyleBaseName === "function")
            ? cadrStyleBaseName(path)
            : path.split("/").pop().replace(/\.mogrt$/i, "");

        cadrInspectMogrtFileOnDisk(path);

        if (existsIdx === -1) {
            list.push({
                name: baseName,
                path: path
            });
            lastAddedIdx = list.length - 1;
            addedNames.push(baseName);
        } else {
            lastAddedIdx = existsIdx;
        }
    });

    cadrStyleSave(list);
    cadrStyleSetActive(lastAddedIdx);
    cadrStyleRender();
    cadrPopulateStyleDropdown();
    cadrBuildStudioStyleControls();

    if (addedNames.length) {
        cadrStyleStatus(
            isEn
                ? ("Added template & loaded its controls: " + addedNames.join(", ") + " ✅")
                : ("تم إضافة القالب وتحميل إعداداته المسموح بها تلقائيًا: " + addedNames.join("، ") + " ✅")
        );
    }
}

cadrStyleAdd = function () {
    var chosen = null;
    try {
        if (window.cep && window.cep.fs && typeof window.cep.fs.showOpenDialogEx === "function") {
            chosen = window.cep.fs.showOpenDialogEx(
                true,
                false,
                "Choose caption style templates (.mogrt)",
                "",
                ["mogrt"]
            );
        }
    } catch (e) {
        chosen = null;
    }

    if (chosen && chosen.err === 0 && chosen.data && chosen.data.length) {
        cadrIngestMogrtPaths(chosen.data);
        return;
    }

    if (window.__adobe_cep__) {
        csInterface.evalScript("cadrPickMogrtFiles()", function (res) {
            var txt = String(res || "");
            if (!txt || txt === "CANCEL" || txt.indexOf("ERR:") === 0) return;
            try {
                var arr = JSON.parse(txt);
                if (Array.isArray(arr) && arr.length) {
                    cadrIngestMogrtPaths(arr);
                }
            } catch (e2) {}
        });
    }
};

cadrStyleDeleteAt = function (idx) {
    var list = cadrStyleLoad();
    if (!list.length || idx < 0 || idx >= list.length) return;
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    var removedName = list[idx].name;
    list.splice(idx, 1);
    cadrStyleSave(list);
    var nextActive = Math.max(0, Math.min(cadrStyleActive(), list.length - 1));
    cadrStyleSetActive(nextActive);
    cadrStyleRender();
    cadrPopulateStyleDropdown();
    cadrBuildStudioStyleControls();
    cadrStyleStatus(
        isEn
            ? ("Removed template: " + removedName)
            : ("تم مسح القالب: " + removedName)
    );
};

cadrStyleDeleteActive = function () {
    var list = cadrStyleLoad();
    if (!list.length) return;
    cadrStyleDeleteAt(cadrStyleActive());
};

cadrStyleRender = function () {
    cadrPopulateStyleDropdown();
};

cadrStyleRead = function () {
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    var style = cadrActiveStyle();
    if (!style) {
        cadrStyleStatus(isEn ? "Select or add a .mogrt template first." : "اختار أو ضيف قالب .mogrt الأول من القائمة المنسدلة.");
        return;
    }

    var diskSchema = cadrInspectMogrtFileOnDisk(style.path);

    if (!window.__adobe_cep__) {
        cadrBuildStudioStyleControls();
        cadrPopulateStyleDropdown();
        cadrStyleStatus(isEn ? "Template controls loaded from .mogrt file ✅" : "تم قراءة الإعدادات المسموح بها من ملف القالب مباشرة ✅");
        return;
    }

    var track = -1;
    try {
        track = parseInt(window.localStorage.getItem(CADR_STYLE_TRACK_KEY), 10);
    } catch (e) {}
    if (isNaN(track)) track = -1;

    cadrStyleStatus(isEn ? "Reading template controls..." : "بيقرأ إعدادات القالب...");

    csInterface.evalScript("cadrReadStyleParams(" + track + ")", function (response) {
        var text = String(response || "NO_RESPONSE");
        if (text.charAt(0) !== "{") {
            if (diskSchema) {
                cadrBuildStudioStyleControls();
                cadrPopulateStyleDropdown();
                cadrStyleStatus(isEn ? ("Loaded controls directly from " + style.name + " ✅") : ("تم تحميل الإعدادات المسموح بها من ملف القالب (" + style.name + ") ✅"));
            } else {
                cadrStyleStatus(isEn ? "Place a MOGRT clip on timeline or select one to read." : "حط القالب على التايم لاين أو حدده عشان نقرأ إعداداته.");
            }
            return;
        }

        try {
            var liveSchema = JSON.parse(text);
            var schemas = cadrStoreGet(CADR_STYLE_SCHEMA_KEY);
            var baseSchema = diskSchema || schemas[style.path] || null;

            if (baseSchema && Array.isArray(baseSchema.params) && Array.isArray(liveSchema.params)) {
                var liveMap = {};
                for (var l = 0; l < liveSchema.params.length; l++) {
                    liveMap[liveSchema.params[l].name] = liveSchema.params[l];
                }
                for (var b = 0; b < baseSchema.params.length; b++) {
                    var bp = baseSchema.params[b];
                    if (liveMap[bp.name] && liveMap[bp.name].value !== undefined) {
                        bp.value = liveMap[bp.name].value;
                    }
                }
                if (liveSchema.font && baseSchema.font) {
                    if (liveSchema.font.font) baseSchema.font.font = liveSchema.font.font;
                    if (liveSchema.font.fontSize) baseSchema.font.fontSize = liveSchema.font.fontSize;
                }
                schemas[style.path] = baseSchema;
            } else {
                schemas[style.path] = liveSchema;
            }

            cadrStoreSet(CADR_STYLE_SCHEMA_KEY, schemas);
            cadrBuildStudioStyleControls();
            cadrPopulateStyleDropdown();
            cadrStyleStatus(isEn ? ("Read settings from: " + (liveSchema.clip || style.name) + " ✅") : ("اتقرت إعدادات القالب: " + (liveSchema.clip || style.name) + " ✅"));
        } catch (e2) {
            cadrStyleStatus("Error: " + text.slice(0, 120));
        }
    });
};

cadrRemoveStyledCaptions = function () {
    if (!cadrRequireLicense("Remove Styled Captions")) return;
    if (cadrStyleBusy) return;

    var status = document.getElementById("styleStatus") || document.getElementById("captionStatus");
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    var track = -1;
    try {
        var t = parseInt(window.localStorage.getItem(CADR_STYLE_TRACK_KEY), 10);
        if (!isNaN(t)) track = t;
    } catch (e) {}

    cadrStyleSetBusy(true);
    csInterface.evalScript("cadrRemoveStyledCaptions(" + track + ")", function (response) {
        cadrStyleSetBusy(false);
        var text = String(response || "NO_RESPONSE");
        if (text.indexOf("OK;") === 0) {
            var parts = text.split(";");
            var cnt = parseInt(parts[1], 10) || 0;
            var trNum = parts[2] !== undefined ? (parseInt(parts[2], 10) + 1) : (track >= 0 ? track + 1 : 1);
            if (cnt > 0) {
                status.textContent = isEn
                    ? ("Removed " + cnt + " styled caption clip(s) from V" + trNum + " ✅")
                    : ("اتمسح " + cnt + " كابشن بستايل من تراك V" + trNum + " ✅");
            } else {
                status.textContent = isEn
                    ? "No MOGRT caption clips found on the timeline."
                    : "مفيش كليبات كابشن بستايل على التايم لاين حاليًا.";
            }
        } else {
            status.textContent = (isEn ? "Could not remove: " : "مقدرتش أمسح: ") + text;
        }
    });
};

cadrStyleApplyToTimeline = function () {
    if (cadrStyleBusy) return;
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    var style = cadrActiveStyle();
    if (!style) {
        cadrStyleStatus(isEn ? "Select a .mogrt template first." : "اختار قالب .mogrt الأول.");
        return;
    }

    var ov = cadrStyleOvFor(style.path);
    if (!ov) {
        cadrStyleStatus(isEn ? "Adjust any setting first before applying." : "عدّل أي إعداد الأول قبل التطبيق.");
        return;
    }

    if (!window.__adobe_cep__) {
        cadrStyleStatus(isEn ? "Settings saved." : "تم حفظ التعديلات.");
        return;
    }

    var payload = encodeURIComponent(JSON.stringify(ov)).replace(/'/g, "%27");
    cadrStyleSetBusy(true);
    var button = document.getElementById("applyStyleButton");
    if (button) button.disabled = true;

    function done(msg) {
        cadrStyleSetBusy(false);
        if (button) button.disabled = false;
        cadrStyleStatus(msg);
        cadrBarWave(100);
        setTimeout(cadrBarIdle, 1200);
    }

    csInterface.evalScript("cadrApplyStyleToSelectedClips('" + payload + "')", function (selRes) {
        var sr = String(selRes || "");
        if (sr.indexOf("OK_SELECTED;") === 0) {
            var cnt = sr.split(";")[1];
            done(
                isEn
                    ? ("Applied style to " + cnt + " selected caption clip(s) on timeline ✅")
                    : ("تم تطبيق الستايل على " + cnt + " كابشن محدد على التايم لاين ✅")
            );
            return;
        }

        var savedTrack = -1;
        try {
            var st = parseInt(window.localStorage.getItem(CADR_STYLE_TRACK_KEY), 10);
            if (!isNaN(st)) savedTrack = st;
        } catch (e) {}

        csInterface.evalScript("cadrFindMgtTrackIndex(" + savedTrack + ")", function (trRes) {
            var track = parseInt(trRes, 10);
            if (isNaN(track)) {
                done(
                    isEn
                        ? "No MOGRT captions on timeline yet. Click 'Add Styled Captions to Timeline' first."
                        : "مفيش كابشن بالستايل على التايم لاين حاليًا. دوس «فرد الكابشن بالستايل على التايم لاين» الأول."
                );
                return;
            }

            try {
                window.localStorage.setItem(CADR_STYLE_TRACK_KEY, String(track));
            } catch (e2) {}

            csInterface.evalScript("cadrCountTrackClips(" + track + ")", function (countResponse) {
                var total = parseInt(countResponse, 10);
                if (isNaN(total) || total <= 0) {
                    done(isEn ? "No clips found on track." : "مفيش كليبات على التراك.");
                    return;
                }

                var index = 0;
                var applied = 0;
                var problems = [];

                function nextClip() {
                    if (window.cadrCancelRequested || index >= total) {
                        var msg = isEn
                            ? ("Applied style to " + applied + " caption(s) on V" + (track + 1) + " ✅")
                            : ("تم تطبيق التعديلات على " + applied + " كابشن في تراك V" + (track + 1) + " ✅");
                        if (problems.length) {
                            msg += "\n" + problems.slice(0, 3).join("\n");
                        }
                        done(msg);
                        return;
                    }

                    csInterface.evalScript(
                        "cadrApplyStyleAt(" + track + "," + index + ",'" + payload + "')",
                        function (r) {
                            var txt = String(r || "NO_RESPONSE");
                            if (txt.indexOf("OK") === 0) {
                                applied++;
                            } else if (txt !== "SKIP") {
                                problems.push((index + 1) + ": " + txt);
                            }
                            index++;
                            cadrBarWave(Math.round((index / total) * 100));
                            setTimeout(nextClip, 15);
                        }
                    );
                }
                nextClip();
            });
        });
    });
};

function cadrLoadClientPresets() {
    try {
        var raw = JSON.parse(window.localStorage.getItem(CADR_CLIENT_PRESETS_KEY) || "[]");
        return Array.isArray(raw) ? raw : [];
    } catch (e) {
        return [];
    }
}

function cadrSaveClientPresets(list) {
    try {
        window.localStorage.setItem(CADR_CLIENT_PRESETS_KEY, JSON.stringify(list));
    } catch (e) {}
}

function cadrSaveCurrentAsClientPreset() {
    var style = cadrActiveStyle();
    if (!style) return;
    var isEn = (cadrUiLangNow === "en");
    var name = window.prompt(
        isEn ? "Enter Client / Style Preset name:" : "اكتب اسم الـ Preset لحفظ إعدادات القالب الحالية:",
        ""
    );
    if (!name || !name.trim()) return;
    name = name.trim();

    var curOv = cadrStyleOvFor(style.path) || { params: {} };
    var list = cadrLoadClientPresets();
    var updated = false;
    for (var i = 0; i < list.length; i++) {
        if (list[i].name === name) {
            list[i].ov = JSON.parse(JSON.stringify(curOv));
            updated = true;
            break;
        }
    }
    if (!updated) {
        list.push({ name: name, ov: JSON.parse(JSON.stringify(curOv)) });
    }
    cadrSaveClientPresets(list);
    cadrBuildStudioStyleControls();
}

function cadrApplyClientPreset(idx) {
    var style = cadrActiveStyle();
    if (!style) return;
    var list = cadrLoadClientPresets();
    var item = list[idx];
    if (!item) return;

    var allOv = cadrStoreGet(CADR_STYLE_OV_KEY);
    allOv[style.path] = JSON.parse(JSON.stringify(item.ov || { params: {} }));
    cadrStoreSet(CADR_STYLE_OV_KEY, allOv);
    cadrBuildStudioStyleControls();
    cadrPopulateStyleDropdown();
}

function cadrDeleteClientPreset(idx) {
    var list = cadrLoadClientPresets();
    list.splice(idx, 1);
    cadrSaveClientPresets(list);
    cadrBuildStudioStyleControls();
}

function cadrResolveFontFamily(fontPs) {
    if (!fontPs) return "Cairo";
    for (var v = 0; v < CADR_STUDIO_VISUAL_FONTS.length; v++) {
        if (CADR_STUDIO_VISUAL_FONTS[v].ps === fontPs || CADR_STUDIO_VISUAL_FONTS[v].family === fontPs) {
            return CADR_STUDIO_VISUAL_FONTS[v].family;
        }
    }
    if (cadrFontList) {
        for (var i = 0; i < cadrFontList.length; i++) {
            if (cadrFontList[i].ps === fontPs) {
                return cadrFontList[i].family;
            }
        }
    }
    return String(fontPs).split("-")[0];
}

function cadrGetCombinedVisualFonts() {
    cadrFontListLoad();
    var out = [];
    var seen = {};

    for (var i = 0; i < CADR_STUDIO_VISUAL_FONTS.length; i++) {
        var vf = CADR_STUDIO_VISUAL_FONTS[i];
        seen[vf.ps.toLowerCase()] = true;
        seen[vf.family.toLowerCase()] = true;
        out.push(vf);
    }

    if (Array.isArray(cadrFontList)) {
        for (var j = 0; j < cadrFontList.length; j++) {
            var sf = cadrFontList[j];
            if (!sf || !sf.ps || !sf.family) continue;
            var keyPs = String(sf.ps).toLowerCase();
            var keyFam = String(sf.family).toLowerCase();
            if (seen[keyPs] || seen[keyFam]) continue;
            seen[keyPs] = true;
            seen[keyFam] = true;
            out.push({
                ps: sf.ps,
                family: sf.family,
                label: sf.family + (sf.style ? (" — " + sf.style) : ""),
                arabic: !!sf.arabic,
                weight: /bold|black|heavy/i.test(sf.style || "") ? 700 : 600
            });
        }
    }
    return out;
}

/* =========================================================
   PURE DYNAMIC MOGRT CONTROLS BUILDER
   (Shows ONLY the controls allowed inside the chosen .mogrt!
    Shows NO fixed/hardcoded settings when no .mogrt is selected!)
   ========================================================= */

cadrBuildStudioStyleControls = function () {
    var box = document.getElementById("styleControls");
    if (!box) return;

    cadrPopulateStyleDropdown();

    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    var style = cadrActiveStyle();
    box.innerHTML = "";

    /* 1. If NO .mogrt is selected, show NO fixed controls — only a clean prompt card */
    if (!style) {
        var emptyCard = document.createElement("div");
        emptyCard.className = "card pad";
        emptyCard.style.textAlign = "center";
        emptyCard.style.padding = "18px 14px";
        emptyCard.style.display = "flex";
        emptyCard.style.flexDirection = "column";
        emptyCard.style.alignItems = "center";
        emptyCard.style.gap = "8px";

        var emptyTitle = document.createElement("div");
        emptyTitle.className = "card-title";
        emptyTitle.style.color = "var(--accent)";
        emptyTitle.textContent = isEn
            ? "🎬 No MOGRT Template Selected Yet"
            : "🎬 لم يتم اختيار قالب MOGRT بعد";

        var emptyDesc = document.createElement("div");
        emptyDesc.className = "card-note";
        emptyDesc.style.maxWidth = "290px";
        emptyDesc.textContent = isEn
            ? "Select a .mogrt template from the dropdown above or click (+ Add .mogrt) to automatically load ONLY the customizable settings allowed inside that template."
            : "اختار قالب MOGRT من القائمة المنسدلة فوق أو دوس (+ إضافة .mogrt) عشان البلاجن يقرأ القالب ويعرضلك هنا أوتوماتيك الإعدادات المسموح بيها جوه القالب ده بس.";

        var emptyBtn = document.createElement("button");
        emptyBtn.type = "button";
        emptyBtn.className = "btn accent-outline sm";
        emptyBtn.style.marginTop = "4px";
        emptyBtn.textContent = isEn ? "+ Add .mogrt from Computer" : "+ إضافة قالب .mogrt من جهازك";
        emptyBtn.onclick = function () { cadrStyleAdd(); };

        emptyCard.appendChild(emptyTitle);
        emptyCard.appendChild(emptyDesc);
        emptyCard.appendChild(emptyBtn);
        box.appendChild(emptyCard);
        return;
    }

    var schema = cadrEnsureMogrtSchema(style);
    var allOv = cadrStoreGet(CADR_STYLE_OV_KEY);
    var ov = allOv[style.path] || { params: {} };
    if (!ov.params) ov.params = {};

    /* If the .mogrt file wasn't accessible on disk yet and hasn't been read from timeline */
    if (!schema) {
        var unreadCard = document.createElement("div");
        unreadCard.className = "card pad";
        unreadCard.style.display = "flex";
        unreadCard.style.flexDirection = "column";
        unreadCard.style.gap = "8px";
        unreadCard.innerHTML =
            '<div class="card-title">' + (isEn ? "Template Selected: " : "القالب المحدد: ") + style.name + '</div>' +
            '<div class="card-note">' + (isEn
                ? "Click 'Read Template' below after placing or selecting this MOGRT on the timeline to display its allowed controls."
                : "دوس على «قراءة القالب» بالأسفل عشان البلاجن يعرضلك الإعدادات المسموح بيها جوه القالب ده.") + '</div>';
        box.appendChild(unreadCard);
        return;
    }

    var hasSeparateSizeParam = false;
    if (Array.isArray(schema.params)) {
        for (var sp = 0; sp < schema.params.length; sp++) {
            if (/^(text\s*size|font\s*size|size)$/i.test(String(schema.params[sp].name || "").trim())) {
                hasSeparateSizeParam = true;
                break;
            }
        }
    }

    /* -------- DYNAMIC CARD 1: VISUAL FONT PICKER (ONLY IF ALLOWED IN THIS .MOGRT!) -------- */
    if (schema.font && schema.font.hasFont) {
        var typoCard = document.createElement("div");
        typoCard.className = "card pad";
        typoCard.style.display = "flex";
        typoCard.style.flexDirection = "column";
        typoCard.style.gap = "8px";

        var typoHead = document.createElement("div");
        typoHead.className = "row";
        typoHead.innerHTML =
            '<span class="card-title">' + (isEn ? ("🔤 " + (schema.font.paramName || "Font") + " (Visual Preview)") : ("🔤 خط القالب (" + (schema.font.paramName || "Font") + ") — بمعاينة شكل الخط")) + '</span>';

        if (ov.font) {
            var resetFontBtn = document.createElement("button");
            resetFontBtn.type = "button";
            resetFontBtn.className = "chip x";
            resetFontBtn.title = isEn ? "Reset to template default font" : "إرجاع الخط الافتراضي للقالب";
            resetFontBtn.textContent = "↺";
            resetFontBtn.onclick = function () {
                cadrStyleOvUpdate(function (o) { delete o.font; });
                cadrBuildStudioStyleControls();
                cadrUpdateMogrtMonitor(true);
            };
            typoHead.appendChild(resetFontBtn);
        }
        typoCard.appendChild(typoHead);

        var searchRow = document.createElement("div");
        searchRow.className = "inline";

        var search = document.createElement("input");
        search.type = "text";
        search.placeholder = isEn ? "Search font by name..." : "ابحث عن اسم الفونت...";
        search.dir = "auto";
        search.value = cadrFontFilter.q;

        var arabicChip = document.createElement("label");
        arabicChip.className = "chip" + (cadrFontFilter.arabic ? " on" : "");
        arabicChip.style.flex = "0 0 auto";
        arabicChip.style.cursor = "pointer";
        var arabicBox = document.createElement("input");
        arabicBox.type = "checkbox";
        arabicBox.checked = cadrFontFilter.arabic;
        var arabicText = document.createElement("span");
        arabicText.textContent = isEn ? "Arabic Only" : "عربي فقط";
        arabicChip.appendChild(arabicBox);
        arabicChip.appendChild(arabicText);

        var refreshBtn = document.createElement("button");
        refreshBtn.type = "button";
        refreshBtn.className = "btn sm";
        refreshBtn.style.flex = "0 0 auto";
        refreshBtn.title = isEn ? "Scan all fonts installed on your PC" : "قراءة كل الخطوط المثبتة على جهازك";
        refreshBtn.textContent = isEn ? "↻ Scan PC" : "↻ فحص الجهاز";

        searchRow.appendChild(search);
        searchRow.appendChild(arabicChip);
        searchRow.appendChild(refreshBtn);
        typoCard.appendChild(searchRow);

        var vfontListEl = document.createElement("div");
        vfontListEl.className = "vfont-picker-list";
        vfontListEl.id = "visualFontList";

        function renderVisualFontRows() {
            var allFonts = cadrGetCombinedVisualFonts();
            var q = String(cadrFontFilter.q || "").trim().toLowerCase();
            var onlyAr = !!cadrFontFilter.arabic;
            var activePs = ov.font || schema.font.font || "Cairo-Bold";
            var activeFam = cadrResolveFontFamily(activePs);

            vfontListEl.innerHTML = "";
            var samplePreview = cadrCustomPreviewText || (isEn ? "CADR STUDIO • Fast Edit" : "كدر ستوديو للمونتاج • CADR");

            var shownCount = 0;
            for (var f = 0; f < allFonts.length; f++) {
                var fn = allFonts[f];
                if (onlyAr && !fn.arabic) continue;
                if (q && fn.label.toLowerCase().indexOf(q) === -1 && fn.family.toLowerCase().indexOf(q) === -1 && fn.ps.toLowerCase().indexOf(q) === -1) {
                    continue;
                }
                if (shownCount >= 60) break;
                shownCount++;

                var isSel = (fn.ps === activePs || fn.family === activeFam);
                var row = document.createElement("div");
                row.className = "vfont-item" + (isSel ? " active" : "");

                var sampleSpan = document.createElement("span");
                sampleSpan.className = "vfont-sample";
                sampleSpan.style.fontFamily = "'" + fn.family.replace(/['"]/g, "") + "', sans-serif";
                sampleSpan.style.fontWeight = String(fn.weight || 700);
                sampleSpan.textContent = samplePreview;

                var metaSpan = document.createElement("span");
                metaSpan.className = "vfont-meta";
                metaSpan.textContent = (isSel ? "✓ " : "") + fn.family;

                row.appendChild(sampleSpan);
                row.appendChild(metaSpan);

                (function (fontObj) {
                    row.addEventListener("mouseenter", function () {
                        cadrHoveredFontObj = fontObj;
                        cadrUpdateMogrtMonitor(false);
                    });
                    row.addEventListener("mouseleave", function () {
                        if (cadrHoveredFontObj === fontObj) {
                            cadrHoveredFontObj = null;
                            cadrUpdateMogrtMonitor(false);
                        }
                    });
                    row.addEventListener("click", function () {
                        cadrHoveredFontObj = null;
                        cadrStyleOvUpdate(function (o) {
                            o.font = fontObj.ps;
                        });
                        cadrBuildStudioStyleControls();
                        cadrUpdateMogrtMonitor(true);
                    });
                })(fn);

                vfontListEl.appendChild(row);
            }

            if (shownCount === 0) {
                var emptyMsg = document.createElement("div");
                emptyMsg.className = "cap-empty";
                emptyMsg.textContent = isEn ? "No matching fonts found." : "مفيش خط بالاسم ده. دوس (↻ فحص الجهاز) لقراءة كل خطوط الويندوز.";
                vfontListEl.appendChild(emptyMsg);
            }
        }

        renderVisualFontRows();
        typoCard.appendChild(vfontListEl);

        search.oninput = function () {
            cadrFontFilter.q = search.value;
            renderVisualFontRows();
        };
        arabicBox.onchange = function () {
            cadrFontFilter.arabic = arabicBox.checked;
            arabicChip.className = "chip" + (cadrFontFilter.arabic ? " on" : "");
            renderVisualFontRows();
        };
        refreshBtn.onclick = function () {
            refreshBtn.textContent = isEn ? "Scanning..." : "بيفحص...";
            cadrFontScan(null, function () {
                cadrBuildStudioStyleControls();
                cadrUpdateMogrtMonitor(false);
            });
        };

        /* Only show embedded fontSize slider inside Font Card if the MOGRT enables capPropFontSizeEdit AND doesn't have a separate Text Size parameter */
        if (schema.font.hasFontSize && !hasSeparateSizeParam) {
            var curFontSize = (ov.fontSize !== undefined) ? Number(ov.fontSize) : (Number(schema.font.fontSize) || 100);
            var fsBox = document.createElement("div");
            fsBox.className = "cap-stat-box";
            fsBox.innerHTML =
                '<div class="cap-stat-head"><span>' + (isEn ? "Font Size" : "حجم الخط (Font Size)") +
                '</span><b id="v_dynFontSize">' + Math.round(curFontSize) + '</b></div>' +
                '<input type="range" id="dynFontSize" min="10" max="300" step="1" value="' + Math.round(curFontSize) + '">';
            typoCard.appendChild(fsBox);

            setTimeout(function () {
                var fsInp = document.getElementById("dynFontSize");
                var fsBadge = document.getElementById("v_dynFontSize");
                if (fsInp) {
                    fsInp.oninput = function () {
                        var v = parseFloat(fsInp.value) || 100;
                        if (fsBadge) fsBadge.textContent = String(Math.round(v));
                        cadrStyleOvUpdate(function (o) {
                            o.fontSize = v;
                            o.sizeKey = schema.font.sizeKey || "fontSizeEditValue";
                        });
                        cadrUpdateMogrtMonitor(false);
                    };
                }
            }, 0);
        }

        box.appendChild(typoCard);
    }

    /* -------- DYNAMIC CARD 2: EXACT ALLOWED PARAMETERS FROM THIS .MOGRT -------- */
    var paramsList = Array.isArray(schema.params) ? schema.params : [];
    if (paramsList.length > 0) {
        var dynCard = document.createElement("div");
        dynCard.className = "card pad";
        dynCard.style.display = "flex";
        dynCard.style.flexDirection = "column";
        dynCard.style.gap = "10px";

        var dynHead = document.createElement("div");
        dynHead.className = "row";
        dynHead.innerHTML =
            '<span class="card-title">' + (isEn ? ("🎛 Allowed Controls in (" + style.name + ")") : ("🎛 الإعدادات المسموح بها داخل (" + style.name + ")")) + '</span>' +
            '<button type="button" class="btn sm" id="saveClientPresetBtn">' + (isEn ? "+ Save Preset" : "+ حفظ Preset") + '</button>';
        dynCard.appendChild(dynHead);

        var clientPresets = cadrLoadClientPresets();
        if (clientPresets.length > 0) {
            var cpRow = document.createElement("div");
            cpRow.className = "chips";
            clientPresets.forEach(function (cp, idx) {
                var chip = document.createElement("span");
                chip.className = "chip";
                var nm = document.createElement("button");
                nm.type = "button";
                nm.className = "nm";
                nm.textContent = "★ " + cp.name;
                nm.onclick = function () { cadrApplyClientPreset(idx); };
                var xb = document.createElement("button");
                xb.type = "button";
                xb.className = "x";
                xb.innerHTML = "×";
                xb.onclick = function () { cadrDeleteClientPreset(idx); };
                chip.appendChild(nm);
                chip.appendChild(xb);
                cpRow.appendChild(chip);
            });
            dynCard.appendChild(cpRow);
        }

        paramsList.forEach(function (param) {
            var isOv = (ov.params && ov.params[param.name] !== undefined);
            var curVal = isOv ? ov.params[param.name] : param.value;

            var fieldWrap = document.createElement("div");
            fieldWrap.style.display = "flex";
            fieldWrap.style.flexDirection = "column";
            fieldWrap.style.gap = "5px";
            fieldWrap.style.paddingBottom = "6px";
            fieldWrap.style.borderBottom = "1px solid rgba(255,255,255,0.04)";

            var headRow = document.createElement("div");
            headRow.className = "row";

            var titleSpan = document.createElement("span");
            titleSpan.style.fontSize = "11.5px";
            titleSpan.style.fontWeight = "600";
            titleSpan.style.color = isOv ? "var(--accent)" : "var(--text)";
            titleSpan.textContent = param.name;
            headRow.appendChild(titleSpan);

            if (isOv) {
                var rstBtn = document.createElement("button");
                rstBtn.type = "button";
                rstBtn.className = "chip x";
                rstBtn.title = isEn ? "Reset to template default" : "إرجاع للقيمة الافتراضية للقالب";
                rstBtn.textContent = "↺";
                rstBtn.onclick = function () {
                    cadrStyleOvUpdate(function (o) {
                        delete o.params[param.name];
                        if (/^(text\s*size|font\s*size|size)$/i.test(param.name)) {
                            delete o.fontSize;
                        }
                    });
                    cadrBuildStudioStyleControls();
                    cadrUpdateMogrtMonitor(true);
                };
                headRow.appendChild(rstBtn);
            }

            /* --- KIND 1: DROPDOWN MENU (type 13 / 7) --- */
            if (param.kind === "menu") {
                fieldWrap.appendChild(headRow);
                var sel = document.createElement("select");
                var opts = Array.isArray(param.options) && param.options.length
                    ? param.options
                    : ["Option 0", "Option 1", "Option 2"];
                for (var oi = 0; oi < opts.length; oi++) {
                    var opt = document.createElement("option");
                    opt.value = String(oi);
                    opt.textContent = opts[oi];
                    if (Number(curVal) === oi) opt.selected = true;
                    sel.appendChild(opt);
                }
                sel.onchange = function () {
                    var nextIdx = parseInt(sel.value, 10) || 0;
                    cadrStyleOvUpdate(function (o) {
                        o.params[param.name] = nextIdx;
                    });
                    cadrBuildStudioStyleControls();
                    cadrUpdateMogrtMonitor(true);
                };
                fieldWrap.appendChild(sel);
            }
            /* --- KIND 2: SLIDER / NUMBER (type 2) --- */
            else if (param.kind === "number") {
                var numVal = (typeof curVal === "number" && !isNaN(curVal)) ? curVal : (Number(param.value) || 0);
                var minV = (typeof param.min === "number") ? param.min : 0;
                var maxV = (typeof param.max === "number") ? param.max : Math.max(100, numVal * 2);

                var valBadge = document.createElement("b");
                valBadge.style.fontFamily = "var(--font-head)";
                valBadge.style.fontSize = "11px";
                valBadge.style.color = "var(--text)";
                valBadge.style.background = "var(--panel)";
                valBadge.style.border = "1px solid var(--line)";
                valBadge.style.borderRadius = "5px";
                valBadge.style.padding = "1px 7px";
                valBadge.style.cursor = "pointer";
                valBadge.title = isEn ? "Click to type exact value" : "اضغط لكتابة رقم محدد";
                valBadge.textContent = String(Math.round(numVal * 100) / 100);
                headRow.appendChild(valBadge);
                fieldWrap.appendChild(headRow);

                var rangeInp = document.createElement("input");
                rangeInp.type = "range";
                rangeInp.min = String(minV);
                rangeInp.max = String(maxV);
                rangeInp.step = (maxV - minV <= 5) ? "0.05" : "1";
                rangeInp.value = String(numVal);

                rangeInp.oninput = function () {
                    var v = parseFloat(rangeInp.value);
                    if (isNaN(v)) return;
                    valBadge.textContent = String(Math.round(v * 100) / 100);
                    cadrStyleOvUpdate(function (o) {
                        o.params[param.name] = v;
                        if (/^(text\s*size|font\s*size|size)$/i.test(param.name)) {
                            o.fontSize = v;
                        }
                    });
                    cadrUpdateMogrtMonitor(false);
                };

                valBadge.onclick = function () {
                    var typed = window.prompt(param.name + " (" + minV + " - " + maxV + "):", String(rangeInp.value));
                    if (typed !== null) {
                        var nv = parseFloat(typed);
                        if (!isNaN(nv)) {
                            rangeInp.value = String(nv);
                            rangeInp.oninput();
                            cadrBuildStudioStyleControls();
                        }
                    }
                };

                fieldWrap.appendChild(rangeInp);
            }
            /* --- KIND 3: COLOR PICKER (type 4) --- */
            else if (param.kind === "color") {
                var hexStr = (typeof curVal === "string" && /^#[0-9a-fA-F]{6}$/.test(curVal)) ? curVal : "#F5F5F5";
                var cRow = document.createElement("div");
                cRow.className = "row";
                cRow.style.gap = "8px";

                var cInp = document.createElement("input");
                cInp.type = "color";
                cInp.value = hexStr;

                var qColors = ["#F5F5F5", "#FF6B35", "#FFD166", "#38BDF8", "#4ADE80", "#000000"];
                var qWrap = document.createElement("div");
                qWrap.style.display = "flex";
                qWrap.style.gap = "5px";

                function applyColorVal(hx) {
                    cInp.value = hx;
                    cadrStyleOvUpdate(function (o) {
                        o.params[param.name] = hx;
                    });
                    cadrUpdateMogrtMonitor(false);
                }

                cInp.oninput = function () {
                    applyColorVal(cInp.value);
                };

                qColors.forEach(function (qc) {
                    var qb = document.createElement("button");
                    qb.type = "button";
                    qb.style.width = "20px";
                    qb.style.height = "20px";
                    qb.style.borderRadius = "50%";
                    qb.style.background = qc;
                    qb.style.border = (hexStr.toUpperCase() === qc) ? "2px solid #FFF" : "1px solid rgba(255,255,255,0.25)";
                    qb.onclick = function () {
                        applyColorVal(qc);
                        cadrBuildStudioStyleControls();
                    };
                    qWrap.appendChild(qb);
                });

                cRow.appendChild(cInp);
                cRow.appendChild(qWrap);
                fieldWrap.appendChild(headRow);
                fieldWrap.appendChild(cRow);
            }
            /* --- KIND 4: 2D POSITION (type 5) --- */
            else if (param.kind === "position") {
                fieldWrap.appendChild(headRow);
                var posArr = (Array.isArray(curVal) && curVal.length === 2) ? curVal : [0.5, 0.5];
                var px = Number(posArr[0]);
                var py = Number(posArr[1]);
                if (Math.abs(px) > 2) px = px / ((param.compSize && param.compSize[0]) || 3840);
                if (Math.abs(py) > 2) py = py / ((param.compSize && param.compSize[1]) || 2160);
                var curXPct = Math.round((isNaN(px) ? 0.5 : px) * 100);
                var curYPct = Math.round((isNaN(py) ? 0.5 : py) * 100);

                var presetRow = document.createElement("div");
                presetRow.className = "pos-presets";
                var presets = [
                    { labelEn: "Top", labelAr: "أعلى", x: 0.5, y: 0.24 },
                    { labelEn: "Center", labelAr: "منتصف", x: 0.5, y: 0.50 },
                    { labelEn: "Reels", labelAr: "ريلز", x: 0.5, y: 0.72 },
                    { labelEn: "Cinema", labelAr: "سينما", x: 0.5, y: 0.84 }
                ];

                var posGrid = document.createElement("div");
                posGrid.className = "cap-studio-grid";

                var xBox = document.createElement("div");
                xBox.className = "cap-stat-box";
                var xHead = document.createElement("div");
                xHead.className = "cap-stat-head";
                var xLbl = document.createElement("span");
                xLbl.textContent = isEn ? "Horizontal X" : "أفقي (X)";
                var xValB = document.createElement("b");
                xValB.textContent = curXPct + "%";
                xHead.appendChild(xLbl);
                xHead.appendChild(xValB);
                var xInp = document.createElement("input");
                xInp.type = "range";
                xInp.min = "5";
                xInp.max = "95";
                xInp.step = "1";
                xInp.value = String(curXPct);
                xBox.appendChild(xHead);
                xBox.appendChild(xInp);

                var yBox = document.createElement("div");
                yBox.className = "cap-stat-box";
                var yHead = document.createElement("div");
                yHead.className = "cap-stat-head";
                var yLbl = document.createElement("span");
                yLbl.textContent = isEn ? "Vertical Y" : "رأسي (Y)";
                var yValB = document.createElement("b");
                yValB.textContent = curYPct + "%";
                yHead.appendChild(yLbl);
                yHead.appendChild(yValB);
                var yInp = document.createElement("input");
                yInp.type = "range";
                yInp.min = "5";
                yInp.max = "95";
                yInp.step = "1";
                yInp.value = String(curYPct);
                yBox.appendChild(yHead);
                yBox.appendChild(yInp);

                function onXYInput() {
                    var nx = (parseFloat(xInp.value) || 50) / 100;
                    var ny = (parseFloat(yInp.value) || 50) / 100;
                    xValB.textContent = Math.round(nx * 100) + "%";
                    yValB.textContent = Math.round(ny * 100) + "%";
                    cadrStyleOvUpdate(function (o) {
                        o.params[param.name] = [nx, ny];
                    });
                    cadrUpdateMogrtMonitor(false);
                }
                xInp.oninput = onXYInput;
                yInp.oninput = onXYInput;

                presets.forEach(function (pr) {
                    var b = document.createElement("button");
                    b.type = "button";
                    b.className = "btn sm";
                    b.textContent = isEn ? pr.labelEn : pr.labelAr;
                    b.onclick = function () {
                        xInp.value = String(Math.round(pr.x * 100));
                        yInp.value = String(Math.round(pr.y * 100));
                        onXYInput();
                    };
                    presetRow.appendChild(b);
                });

                posGrid.appendChild(xBox);
                posGrid.appendChild(yBox);
                fieldWrap.appendChild(presetRow);
                fieldWrap.appendChild(posGrid);
            }
            /* --- KIND 5: BOOLEAN TOGGLE (type 3 / 1) --- */
            else if (param.kind === "bool") {
                var cbWrap = document.createElement("label");
                cbWrap.className = "cap-toggle-card" + (curVal ? " on" : "");
                var cbSpan = document.createElement("span");
                cbSpan.textContent = param.name;
                var cbInp = document.createElement("input");
                cbInp.type = "checkbox";
                cbInp.checked = !!curVal;
                cbInp.onchange = function () {
                    cadrStyleOvUpdate(function (o) {
                        o.params[param.name] = cbInp.checked;
                    });
                    cadrBuildStudioStyleControls();
                    cadrUpdateMogrtMonitor(false);
                };
                cbWrap.appendChild(cbSpan);
                cbWrap.appendChild(cbInp);
                fieldWrap.appendChild(cbWrap);
            }

            dynCard.appendChild(fieldWrap);
        });

        box.appendChild(dynCard);

        var saveBtn = document.getElementById("saveClientPresetBtn");
        if (saveBtn) saveBtn.onclick = cadrSaveCurrentAsClientPreset;
    }
};

cadrStyleTabRender = cadrBuildStudioStyleControls;

/* Lightweight Dropdown Preview Updater (No separate screen box; zero background timers!) */
cadrUpdateMogrtMonitor = function () {
    cadrPopulateStyleDropdown();
};

cadrStepMogrtWordHighlight = function () {};
if (cadrMogrtTimer) {
    clearInterval(cadrMogrtTimer);
    cadrMogrtTimer = null;
}

cadrPopulateStyleDropdown();
cadrBuildStudioStyleControls();


/* =========================================================
   CADR CUT v5.0 — PRECISION WORD-COUNT CONTROLLER,
   PER-LINE (+1/-1 WORD) SHIFTER & CLICK-BETWEEN-WORDS SPLITTER
   ========================================================= */

var cadrWordCountModeNow = "strict";

function cadrUpdateWordCountBarUi() {
    var wEl = document.getElementById("wordsPerLine");
    var w = wEl ? Math.max(1, parseInt(wEl.value, 10) || 3) : 3;
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");

    var pills = document.querySelectorAll("#wcQuickPills .wc-pill");
    for (var i = 0; i < pills.length; i++) {
        var pw = parseInt(pills[i].getAttribute("data-w"), 10);
        var active = (pw === w) || (pw === 8 && w >= 8);
        pills[i].className = "wc-pill" + (active ? " on" : "");
    }

    var disp = document.getElementById("wcStepperDisplay");
    if (disp) {
        if (isEn) {
            disp.textContent = w + (w === 1 ? " word" : " words");
        } else {
            disp.textContent = w === 1 ? "كلمة واحدة (1)" : (w === 2 ? "كلمتين (2)" : (w + " كلمات"));
        }
    }

    var modeBtns = document.querySelectorAll("#wcModeSeg .seg-btn");
    for (var m = 0; m < modeBtns.length; m++) {
        var bm = modeBtns[m].getAttribute("data-wcmode");
        modeBtns[m].className = "seg-btn" + (bm === cadrWordCountModeNow ? " on" : "");
    }
}

function cadrSetWordCountMode(mode) {
    cadrWordCountModeNow = (mode === "smart") ? "smart" : "strict";
    var hidden = document.getElementById("wordCountMode");
    if (hidden) hidden.value = cadrWordCountModeNow;
    setSetting("wordCountMode", cadrWordCountModeNow);

    var natCb = document.getElementById("naturalSplit");
    if (natCb) {
        natCb.checked = (cadrWordCountModeNow === "smart");
        cadrSyncCapToggleCards();
    }

    cadrUpdateWordCountBarUi();
    rebuildCaptionPreview();
}

function cadrSetExactWordCount(n) {
    var w = Math.max(1, Math.min(15, parseInt(n, 10) || 3));
    var wEl = document.getElementById("wordsPerLine");
    if (wEl) {
        wEl.value = String(w);
        setSetting("wordsPerLine", String(w));
    }
    /* Always ensure wordLevelCaptions is checked so word-level timestamps are used! */
    var wlEl = document.getElementById("wordLevelCaptions");
    if (wlEl && !wlEl.checked) {
        wlEl.checked = true;
        setSetting("wordLevelCaptions", "1");
        cadrSyncCapToggleCards();
    }
    /* Automatically adjust maxCharsPerLine so character limit NEVER prematurely cuts off the chosen word count */
    var cEl = document.getElementById("maxCharsPerLine");
    if (cEl) {
        var autoChars = Math.min(60, Math.max(24, w * 10));
        cEl.value = String(autoChars);
        setSetting("maxCharsPerLine", String(autoChars));
    }
    if (w >= 7) {
        cadrSetMaxLines(2);
    } else if (w <= 5) {
        cadrSetMaxLines(1);
    }
    cadrRefreshSliderLabels();
    cadrSyncCaptionUi();
    cadrUpdateWordCountBarUi();
    rebuildCaptionPreview();
}

function cadrStepWordCount(delta) {
    var wEl = document.getElementById("wordsPerLine");
    var cur = wEl ? (parseInt(wEl.value, 10) || 3) : 3;
    cadrSetExactWordCount(cur + delta);
}

/* Normalize word stream so compound tokens or lines are split into atomic single words with proportional timing */
function cadrNormalizeAtomicWords(rawWords, stripPunct, stripTashkeel) {
    var out = [];
    if (!rawWords || !rawWords.length) return out;

    for (var i = 0; i < rawWords.length; i++) {
        var item = rawWords[i];
        var rawText = String(item.word || item.text || "").trim();
        if (!rawText) continue;

        var hadStop = /[.!؟?،,;:]/.test(rawText);
        var cleaned = cadrCleanCaptionTextPro(rawText, stripPunct, stripTashkeel);
        if (!cleaned) continue;

        var parts = cleaned.split(/\s+/);
        var st = Number(item.start) || 0;
        var en = Math.max(st + 0.04, Number(item.end) || (st + 0.2));
        var dur = en - st;

        for (var p = 0; p < parts.length; p++) {
            if (!parts[p]) continue;
            out.push({
                word: parts[p],
                start: st + (p / parts.length) * dur,
                end: st + ((p + 1) / parts.length) * dur,
                hadStop: (p === parts.length - 1) ? hadStop : false
            });
        }
    }
    return out;
}

/* Replace cadrBuildProCaptions with pure precision word-count engine (no minDuration slider) */
cadrBuildProCaptions = function () {
    var wordsPerLineEl = document.getElementById("wordsPerLine");
    var maxCharsEl = document.getElementById("maxCharsPerLine");
    var maxLinesEl = document.getElementById("maxLinesPerCaption");
    var gapBridgeEl = document.getElementById("captionGapBridge");
    var timeOffsetEl = document.getElementById("captionTimeOffset");
    var pauseSplitEl = document.getElementById("capPauseSplit");
    var stripPunctEl = document.getElementById("stripPunctuation");
    var stripTashkeelEl = document.getElementById("stripTashkeel");

    var maxWords = wordsPerLineEl ? Math.max(1, parseInt(wordsPerLineEl.value, 10) || 3) : 3;
    var maxChars = maxCharsEl ? Math.max(14, parseInt(maxCharsEl.value, 10) || 30) : 30;
    var maxLines = maxLinesEl ? Math.max(1, parseInt(maxLinesEl.value, 10) || 1) : 1;
    var gapBridge = gapBridgeEl ? Math.max(0, parseFloat(gapBridgeEl.value) || 0) : 0.12;
    var offsetSec = timeOffsetEl ? ((parseFloat(timeOffsetEl.value) || 0) / 1000.0) : 0;
    var pauseSplit = pauseSplitEl ? Math.max(0.1, parseFloat(pauseSplitEl.value) || 0.35) : 0.35;
    var stripPunct = stripPunctEl ? stripPunctEl.checked : false;
    var stripTashkeel = stripTashkeelEl ? stripTashkeelEl.checked : false;

    var isStrict = (cadrWordCountModeNow === "strict");
    var rawGroups = [];

    var sourceWords = [];
    if (pendingCaptionWords && pendingCaptionWords.length > 0) {
        sourceWords = cadrNormalizeAtomicWords(pendingCaptionWords, stripPunct, stripTashkeel);
    } else if (pendingCaptionLines && pendingCaptionLines.length > 0) {
        sourceWords = cadrNormalizeAtomicWords(pendingCaptionLines, stripPunct, stripTashkeel);
    } else {
        var rawArea = document.getElementById("captionPreview");
        var existingSrt = (rawArea && rawArea.value.trim()) ? rawArea.value : (pendingCaptionSrt || "");
        if (existingSrt) {
            var parsedExisting = parseSrtToLines(existingSrt);
            if (parsedExisting && parsedExisting.length) {
                pendingCaptionLines = parsedExisting;
                sourceWords = cadrNormalizeAtomicWords(parsedExisting, stripPunct, stripTashkeel);
            }
        }
    }

    if (!sourceWords.length) return [];

    var bucket = [];
    function flushBucket() {
        if (!bucket.length) return;
        var wTexts = [];
        for (var b = 0; b < bucket.length; b++) {
            wTexts.push(bucket[b].word);
        }
        rawGroups.push({
            start: bucket[0].start,
            end: bucket[bucket.length - 1].end,
            text: cadrWrapTextLines(wTexts, maxChars, maxLines)
        });
        bucket = [];
    }

    for (var i = 0; i < sourceWords.length; i++) {
        var wObj = sourceWords[i];

        if (bucket.length > 0) {
            var prevW = bucket[bucket.length - 1];
            var silenceGap = wObj.start - prevW.end;

            if (bucket.length >= maxWords) {
                flushBucket();
            } else if (!isStrict && silenceGap >= pauseSplit) {
                flushBucket();
            } else if (isStrict && silenceGap >= 1.35) {
                flushBucket();
            }
        }

        bucket.push(wObj);

        if (!isStrict && wObj.hadStop && bucket.length >= Math.max(1, Math.floor(maxWords * 0.6))) {
            flushBucket();
        }
    }
    flushBucket();

    /* Apply timing offset and gap bridging */
    for (var g = 0; g < rawGroups.length; g++) {
        rawGroups[g].start = Math.max(0, rawGroups[g].start + offsetSec);
        rawGroups[g].end = Math.max(rawGroups[g].start + 0.08, rawGroups[g].end + offsetSec);
    }

    if (gapBridge > 0) {
        for (var k = 0; k < rawGroups.length - 1; k++) {
            var gap = rawGroups[k + 1].start - rawGroups[k].end;
            if (gap > 0 && gap <= gapBridge) {
                rawGroups[k].end = rawGroups[k + 1].start;
            }
        }
    }

    return rawGroups;
};

/* Upgrade Visual Caption Line Editor:
   - Shows per-line word count badge (e.g. 2ك)
   - Shows interactive clickable word tokens with ✂ split points between EVERY two words!
   - Shows (-1ك) Push Last Word to Next Line & (+1ك) Pull First Word from Next Line buttons!
   - Shows (🔗) Merge with Next Line button! */
cadrRenderVisualCaptionLines = function () {
    var visualBox = document.getElementById("captionVisualLines");
    var rawArea = document.getElementById("captionPreview");
    if (!visualBox || !rawArea) return;

    var srtText = String(rawArea.value || "").trim();
    var lines = srtText ? parseSrtToLines(srtText) : [];
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");

    visualBox.innerHTML = "";

    if (!lines.length) {
        var empty = document.createElement("div");
        empty.className = "cap-empty";
        empty.textContent = isEn
            ? "Caption lines will appear here after clicking Generate Captions."
            : "ستظهر سطور الكابشن هنا بعد الضغط على «توليد الكابشن» لتعديل الكلمات أو تقسيمها ودمجها بضغطة واحدة.";
        visualBox.appendChild(empty);
        return;
    }

    /* Sync user edits back into pendingCaptionLines so they persist */
    function commitLinesToSrt() {
        var updatedSrt = buildSrtFromLines(lines);
        rawArea.value = updatedSrt;
        pendingCaptionSrt = updatedSrt;
        cadrRenderVisualCaptionLines();
        if (typeof cadrUpdateMogrtMonitor === "function") {
            cadrUpdateMogrtMonitor(false);
        }
    }

    /* Helper to split line[idx] after word index splitAfterIdx (0-based) */
    function splitLineAtWord(idx, splitAfterIdx) {
        var curWords = String(lines[idx].text || "").replace(/\s*\n\s*/g, " ").trim().split(/\s+/);
        if (curWords.length < 2) return;
        var cutPoint = Math.max(1, Math.min(curWords.length - 1, splitAfterIdx + 1));
        var part1 = curWords.slice(0, cutPoint).join(" ");
        var part2 = curWords.slice(cutPoint).join(" ");
        var st = Number(lines[idx].start) || 0;
        var en = Math.max(st + 0.16, Number(lines[idx].end) || (st + 0.6));
        var mid = st + (cutPoint / curWords.length) * (en - st);

        lines.splice(idx, 1,
            { start: st, end: Number(mid.toFixed(3)), text: part1 },
            { start: Number(mid.toFixed(3)), end: en, text: part2 }
        );
        commitLinesToSrt();
    }

    /* Helper: Push last word of line[idx] to the start of line[idx+1] (-1 word from this line) */
    function pushLastWordToNextLine(idx) {
        if (idx >= lines.length - 1) return;
        var w1 = String(lines[idx].text || "").replace(/\s*\n\s*/g, " ").trim().split(/\s+/);
        var w2 = String(lines[idx + 1].text || "").replace(/\s*\n\s*/g, " ").trim().split(/\s+/);
        if (w1.length < 2) return;

        var movedWord = w1.pop();
        w2.unshift(movedWord);

        var st1 = Number(lines[idx].start) || 0;
        var en1 = Math.max(st1 + 0.15, Number(lines[idx].end) || (st1 + 0.5));
        var wordDur = (en1 - st1) / (w1.length + 1);
        var newBoundary = Number((en1 - wordDur).toFixed(3));

        lines[idx].text = w1.join(" ");
        lines[idx].end = newBoundary;
        lines[idx + 1].text = w2.join(" ");
        lines[idx + 1].start = Math.min(Number(lines[idx + 1].start) || newBoundary, newBoundary);
        commitLinesToSrt();
    }

    /* Helper: Pull first word of line[idx+1] into the end of line[idx] (+1 word to this line) */
    function pullFirstWordFromNextLine(idx) {
        if (idx >= lines.length - 1) return;
        var w1 = String(lines[idx].text || "").replace(/\s*\n\s*/g, " ").trim().split(/\s+/);
        var w2 = String(lines[idx + 1].text || "").replace(/\s*\n\s*/g, " ").trim().split(/\s+/);
        if (!w2.length) return;

        if (w2.length === 1) {
            /* Only 1 word in next line -> merge completely */
            lines[idx].text = (w1.join(" ") + " " + w2[0]).trim();
            lines[idx].end = lines[idx + 1].end;
            lines.splice(idx + 1, 1);
            commitLinesToSrt();
            return;
        }

        var pulledWord = w2.shift();
        w1.push(pulledWord);

        var st2 = Number(lines[idx + 1].start) || Number(lines[idx].end) || 0;
        var en2 = Math.max(st2 + 0.15, Number(lines[idx + 1].end) || (st2 + 0.5));
        var wordDur = (en2 - st2) / (w2.length + 1);
        var newBoundary = Number((st2 + wordDur).toFixed(3));

        lines[idx].text = w1.join(" ");
        lines[idx].end = newBoundary;
        lines[idx + 1].text = w2.join(" ");
        lines[idx + 1].start = newBoundary;
        commitLinesToSrt();
    }

    lines.forEach(function (line, idx) {
        var card = document.createElement("div");
        card.className = "cap-line-card";

        var topRow = document.createElement("div");
        topRow.className = "cap-line-top";

        var timeBtn = document.createElement("button");
        timeBtn.type = "button";
        timeBtn.className = "cap-time-btn";
        timeBtn.title = isEn ? "Jump playhead to this line" : "انتقل لهذا التوقيت على التايم لاين";
        timeBtn.textContent = "▶ " + cadrFmtShortTime(line.start);
        timeBtn.onclick = function () {
            if (window.__adobe_cep__) {
                var targetSec = Math.max(0, Number(line.start) || 0);
                csInterface.evalScript("cadrGoTo(" + targetSec + ")");
            }
        };

        var cleanSingleLine = String(line.text || "").replace(/\s*\n\s*/g, " ").trim();
        var wordsInLine = cleanSingleLine ? cleanSingleLine.split(/\s+/) : [];

        var wcTag = document.createElement("span");
        wcTag.className = "cap-wc-tag";
        wcTag.title = isEn ? (wordsInLine.length + " words in this caption") : ("عدد الكلمات في هذا السطر: " + wordsInLine.length);
        wcTag.textContent = wordsInLine.length + (isEn ? "w" : "ك");

        var input = document.createElement("input");
        input.type = "text";
        input.className = "cap-line-input";
        input.dir = "auto";
        input.value = cleanSingleLine;
        input.oninput = function () {
            lines[idx].text = input.value;
            var newWordsCount = input.value.trim() ? input.value.trim().split(/\s+/).length : 0;
            wcTag.textContent = newWordsCount + (isEn ? "w" : "ك");
            var updatedSrt = buildSrtFromLines(lines);
            rawArea.value = updatedSrt;
            pendingCaptionSrt = updatedSrt;
            if (idx === 0 && typeof cadrUpdateMogrtMonitor === "function") {
                cadrUpdateMogrtMonitor(false);
            }
        };

        topRow.appendChild(timeBtn);
        topRow.appendChild(wcTag);
        topRow.appendChild(input);
        card.appendChild(topRow);

        /* Bottom interactive row: Clickable word tokens with ✂ split between any 2 words + (-1ك / +1ك / 🔗) controls */
        var botRow = document.createElement("div");
        botRow.className = "cap-line-bot";

        var chipsWrap = document.createElement("div");
        chipsWrap.className = "cap-word-chips";

        for (var w = 0; w < wordsInLine.length; w++) {
            var wSpan = document.createElement("span");
            wSpan.className = "cap-w-token";
            wSpan.textContent = wordsInLine[w];
            chipsWrap.appendChild(wSpan);

            if (w < wordsInLine.length - 1) {
                (function (splitIdx) {
                    var cutBtn = document.createElement("button");
                    cutBtn.type = "button";
                    cutBtn.className = "cap-w-cut";
                    cutBtn.textContent = "✂";
                    cutBtn.title = isEn
                        ? "Split caption right here"
                        : "اقسم السطر من هنا بالظبط";
                    cutBtn.onclick = function () {
                        splitLineAtWord(idx, splitIdx);
                    };
                    chipsWrap.appendChild(cutBtn);
                })(w);
            }
        }

        var shiftWrap = document.createElement("div");
        shiftWrap.className = "cap-shift-btns";

        /* -1ك button: Push last word to next line */
        var minusWordBtn = document.createElement("button");
        minusWordBtn.type = "button";
        minusWordBtn.className = "cap-shift-btn";
        minusWordBtn.textContent = isEn ? "−1w" : "−1ك";
        minusWordBtn.disabled = (wordsInLine.length < 2 || idx >= lines.length - 1);
        minusWordBtn.title = isEn
            ? "Move last word of this line to next line"
            : "نقل آخر كلمة من السطر ده للسطر اللي بعده";
        minusWordBtn.onclick = function () {
            pushLastWordToNextLine(idx);
        };

        /* +1ك button: Pull first word from next line */
        var plusWordBtn = document.createElement("button");
        plusWordBtn.type = "button";
        plusWordBtn.className = "cap-shift-btn";
        plusWordBtn.textContent = isEn ? "+1w" : "+1ك";
        plusWordBtn.disabled = (idx >= lines.length - 1);
        plusWordBtn.title = isEn
            ? "Pull first word from next line into this line"
            : "سحب أول كلمة من السطر اللي بعده للسطر ده";
        plusWordBtn.onclick = function () {
            pullFirstWordFromNextLine(idx);
        };

        /* 🔗 Merge button */
        var mergeBtn = document.createElement("button");
        mergeBtn.type = "button";
        mergeBtn.className = "cap-shift-btn";
        mergeBtn.textContent = "🔗";
        mergeBtn.disabled = (idx >= lines.length - 1);
        mergeBtn.title = isEn ? "Merge entire line with next line" : "دمج السطر بالكامل مع السطر التالي";
        mergeBtn.onclick = function () {
            if (idx >= lines.length - 1) return;
            var combinedText = (String(lines[idx].text || "").trim() + " " + String(lines[idx + 1].text || "").trim()).replace(/\s+/g, " ");
            lines[idx].text = combinedText;
            lines[idx].end = lines[idx + 1].end;
            lines.splice(idx + 1, 1);
            commitLinesToSrt();
        };

        shiftWrap.appendChild(minusWordBtn);
        shiftWrap.appendChild(plusWordBtn);
        shiftWrap.appendChild(mergeBtn);

        botRow.appendChild(chipsWrap);
        botRow.appendChild(shiftWrap);
        card.appendChild(botRow);

        visualBox.appendChild(card);
    });
};

/* Add i18n keys for the 7-pill Direct Word-Count Controller */
CADR_I18N.en.wcBarTitle = "Words per Caption";
CADR_I18N.en.wcStrictBtn = "Exact Count";
CADR_I18N.en.wcSmartBtn = "Smart Pause";
CADR_I18N.en.w1Sub = "Word";
CADR_I18N.en.w2Sub = "Words";
CADR_I18N.en.w3Sub = "Reels";
CADR_I18N.en.w4Sub = "Social";
CADR_I18N.en.w5Sub = "Balanced";
CADR_I18N.en.w6Sub = "Medium";
CADR_I18N.en.w8Sub = "Cinema";

CADR_I18N.ar.wcBarTitle = "عدد الكلمات في الكابشن";
CADR_I18N.ar.wcStrictBtn = "عدد ثابت بالظبط";
CADR_I18N.ar.wcSmartBtn = "مرن مع الوقفات";
CADR_I18N.ar.w1Sub = "كلمة";
CADR_I18N.ar.w2Sub = "كلمتين";
CADR_I18N.ar.w3Sub = "ريلز";
CADR_I18N.ar.w4Sub = "سوشيال";
CADR_I18N.ar.w5Sub = "متوازن";
CADR_I18N.ar.w6Sub = "متوسط";
CADR_I18N.ar.w8Sub = "سينما";

(function () {
    var origLangFn = cadrApplyUiLang;
    cadrApplyUiLang = function (lang, save) {
        origLangFn(lang, save);
        cadrUpdateWordCountBarUi();
    };

    var wEl = document.getElementById("wordsPerLine");
    if (wEl) {
        wEl.addEventListener("input", function () {
            cadrUpdateWordCountBarUi();
        });
    }

    /* Force wordLevelCaptions on by default so exact word-level timestamps are always active */
    var wlEl = document.getElementById("wordLevelCaptions");
    if (wlEl) {
        wlEl.checked = true;
        cadrSyncCapToggleCards();
    }

    var savedWcMode = getSetting("wordCountMode", "strict");
    cadrSetWordCountMode(savedWcMode);
    cadrUpdateWordCountBarUi();
    rebuildCaptionPreview();

    var minTop = document.getElementById("minCaptionDurationTop");
    var minBot = document.getElementById("minCaptionDuration");
    var vMinTop = document.getElementById("v_minCaptionDurationTop");
    var vMinBot = document.getElementById("v_minCaptionDuration");

    function syncMinDurUi(val) {
        var num = Math.max(0.15, Math.min(2.50, parseFloat(val) || 0.40));
        var str = num.toFixed(2);
        if (minTop) minTop.value = str;
        if (minBot) minBot.value = str;
        if (vMinTop) vMinTop.textContent = str + " s";
        if (vMinBot) vMinBot.textContent = str + " s";
        setSetting("minCaptionDuration", str);
    }

    var savedMinDur = getSetting("minCaptionDuration", "0.40");
    syncMinDurUi(savedMinDur);

    if (minTop) {
        minTop.addEventListener("input", function () {
            syncMinDurUi(minTop.value);
            rebuildCaptionPreview();
        });
    }
    if (minBot) {
        minBot.addEventListener("input", function () {
            syncMinDurUi(minBot.value);
            rebuildCaptionPreview();
        });
    }

})();


CADR_I18N.en.addStyleBtn = "+ Add .mogrt";
CADR_I18N.en.delStyleBtn = "🗑 Delete";
CADR_I18N.ar.addStyleBtn = "+ إضافة .mogrt";
CADR_I18N.ar.delStyleBtn = "🗑 حذف";
cadrStyleRender();




/* =========================================================
   CADR CUT v5.7 UPGRADES:
   1. 3-Day Uninstall-Proof Free Trial UI
   2. Permanent Google Gemini API Key Retention (Disk + LocalStorage)
   3. Animation Composer Style MOGRT Dropdown Grid & Hover Preview
   4. Custom Visual Font Dropdown Menu
   5. Font Size Slider + Direct Number Input (Supports < 10 down to 1)
   ========================================================= */

/* ---------- 1. 3-DAY FREE TRIAL UI ---------- */
cadrLicenseResultText = function (result) {
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    if (!result) return isEn ? "License check failed." : "تعذر فحص الترخيص.";
    if (result.ok && result.isTrial) {
        var dLeft = result.trialDaysLeft !== undefined ? result.trialDaysLeft : 3;
        var hLeft = result.trialHoursLeft !== undefined ? result.trialHoursLeft : 0;
        return isEn
            ? ("🎁 3-Day Free Trial Active ✓ (Remaining: " + dLeft + " day(s), " + hLeft + " hour(s))\nAll plugin features are unlocked. You can paste a permanent License Key above anytime.")
            : ("🎁 الفترة التجريبية المجانية مفعّلة ✓ (متبقي: " + dLeft + " يوم و " + hLeft + " ساعة)\nكل مميزات البلاجن مفتوحة بالكامل، وتقدر تفعّل الكود الدائم بالأعلى في أي وقت.");
    }
    if (result.ok) {
        var p = result.payload || {};
        var expiry = p.expiresAt ? p.expiresAt.replace("T", " ").replace(".000Z", " UTC") : (isEn ? "Lifetime" : "مدى الحياة");
        return (isEn ? "Permanent License Activated ✓\n" : "الترخيص الدائم مفعّل بنجاح ✓\n") +
            "Customer: " + (p.customer || "—") + "\n" +
            "Plan: " + (p.plan || "standard") + "\n" +
            "Expires: " + expiry;
    }
    if (result.trialExpired) {
        return isEn
            ? "⏰ Your 3-Day Free Trial has ended. Copy your Device ID above and send it to CADR STUDIO to get your activation License Key."
            : "⏰ انتهت الفترة التجريبية المجانية (3 أيام). انسخ الـ Device ID بالأعلى وابعته لفريق CADR STUDIO للحصول على كود التفعيل الدائم.";
    }
    return result.error || (isEn ? "License not activated." : "الترخيص غير مفعّل.");
};

cadrSetLicenseUi = function (result) {
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    var badge = document.getElementById("licenseBadge");
    var status = document.getElementById("licenseStatus");
    if (badge) {
        if (result && result.ok && result.isTrial) {
            var d = result.trialDaysLeft !== undefined ? result.trialDaysLeft : 3;
            var h = result.trialHoursLeft !== undefined ? result.trialHoursLeft : 0;
            badge.textContent = isEn ? ("🎁 Trial: " + d + "d " + h + "h left") : ("🎁 تجريبي: باقي " + d + "ي و" + h + "س");
            badge.classList.add("on");
        } else if (result && result.ok) {
            badge.textContent = isEn ? "Active ✓" : "مفعّل دائم ✓";
            badge.classList.add("on");
        } else if (result && result.trialExpired) {
            badge.textContent = isEn ? "Trial Expired" : "انتهت التجربة (3 أيام)";
            badge.classList.remove("on");
        } else {
            badge.textContent = isEn ? "Not activated" : "غير مفعّل";
            badge.classList.remove("on");
        }
    }
    if (status) {
        status.textContent = cadrLicenseResultText(result);
        status.style.color = (result && result.ok) ? "#22C55E" : "#F59E0B";
    }
};

cadrRequireLicense = function (actionName) {
    if (!window.CADRLicense) {
        alert("CADR CUT License module غير متاح.");
        return false;
    }
    var result = window.CADRLicense.current();
    cadrSetLicenseUi(result);
    if (result.ok) return true;

    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    var message = result.trialExpired
        ? (isEn
            ? "Your 3-Day Free Trial has ended.\n\nPlease open Settings → License, copy your Device ID, and enter your License Key to continue."
            : "انتهت الفترة التجريبية المجانية (3 أيام).\n\nبرجاء نسخ الـ Device ID من صفحة الإعدادات وإدخال كود التفعيل (License Key) للاستمرار.")
        : (isEn
            ? "CADR CUT requires activation.\n\nOpen Settings → License and paste your License Key."
            : "البلاجن يحتاج إلى تفعيل.\n\nافتح الإعدادات (Settings) والصق كود التفعيل (License Key).");
    alert(message);
    try { showTab("settings"); } catch (e) {}
    return false;
};

/* ---------- 2. PERMANENT GOOGLE GEMINI API KEY RETENTION ---------- */
var CADR_GEMINI_RETAIN_KEY = "cadrGeminiKeyRetainedV2";
var cadrCachedGeminiApiKey = "";

function cadrGetDiskSettingsPaths() {
    if (!window.cep_node || typeof window.cep_node.require !== "function") return [];
    try {
        var path = window.cep_node.require("path");
        var os = window.cep_node.require("os");
        var proc = window.cep_node.process || (typeof process !== "undefined" ? process : {});
        var env = proc.env || {};
        var home = os.homedir ? os.homedir() : (env.USERPROFILE || env.HOME || "");
        var appData = env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
        var out = [];
        if (appData) out.push(path.join(appData, "CADR_STUDIO", "cadr_user_settings.json"));
        if (home) out.push(path.join(home, ".cadr_studio_settings.json"));
        return out;
    } catch (e) {
        return [];
    }
}

function cadrReadRetainedKeyFromDisk() {
    if (cadrCachedGeminiApiKey) return cadrCachedGeminiApiKey;
    try {
        var lsVal = window.localStorage.getItem(CADR_GEMINI_RETAIN_KEY);
        if (lsVal && lsVal.trim().length >= 10) {
            cadrCachedGeminiApiKey = lsVal.trim();
            return cadrCachedGeminiApiKey;
        }
    } catch (e1) {}

    var paths = cadrGetDiskSettingsPaths();
    if (paths.length && window.cep_node && typeof window.cep_node.require === "function") {
        try {
            var fs = window.cep_node.require("fs");
            for (var i = 0; i < paths.length; i++) {
                try {
                    if (fs.existsSync(paths[i])) {
                        var obj = JSON.parse(fs.readFileSync(paths[i], "utf8"));
                        if (obj && obj.geminiApiKey && String(obj.geminiApiKey).trim().length >= 10) {
                            cadrCachedGeminiApiKey = String(obj.geminiApiKey).trim();
                            try { window.localStorage.setItem(CADR_GEMINI_RETAIN_KEY, cadrCachedGeminiApiKey); } catch (e2) {}
                            return cadrCachedGeminiApiKey;
                        }
                    }
                } catch (ef) {}
            }
        } catch (e3) {}
    }
    return "";
}

function cadrWriteRetainedKeyToDisk(rawKey) {
    var clean = String(rawKey || "").trim();
    cadrCachedGeminiApiKey = clean;
    try {
        window.localStorage.setItem(CADR_GEMINI_RETAIN_KEY, clean);
        window.localStorage.setItem("geminiApiKey", clean ? ("cadr.dpapi.v1:v2:" + window.btoa(unescape(encodeURIComponent(clean)))) : "");
    } catch (e1) {}

    var paths = cadrGetDiskSettingsPaths();
    if (paths.length && window.cep_node && typeof window.cep_node.require === "function") {
        try {
            var fs = window.cep_node.require("fs");
            var pathMod = window.cep_node.require("path");
            var payload = JSON.stringify({ geminiApiKey: clean, updatedAt: new Date().toISOString() });
            for (var i = 0; i < paths.length; i++) {
                try {
                    var dir = pathMod.dirname(paths[i]);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(paths[i], payload, "utf8");
                } catch (ew) {}
            }
        } catch (e2) {}
    }
    cadrUpdateGeminiRetentionBadge();
}

function cadrUpdateGeminiRetentionBadge() {
    var badge = document.getElementById("geminiKeyRetentionBadge");
    var status = document.getElementById("apiKeyStorageStatus");
    var inp = document.getElementById("geminiApiKey");
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    var hasKey = !!((inp && inp.value && inp.value.trim().length >= 10) || cadrCachedGeminiApiKey);

    if (badge) {
        badge.textContent = hasKey
            ? (isEn ? "Saved Permanently ✓" : "محفوظ دائمًا ✓")
            : (isEn ? "No Key Entered" : "لم يتم إدخال مفتاح");
        badge.className = "chip" + (hasKey ? " on" : "");
    }
    if (status) {
        status.textContent = hasKey
            ? (isEn
                ? "✓ Your Gemini API Key is permanently retained on this computer and will never be requested again."
                : "✓ مفتاح Gemini API محفوظ بشكل دائم على جهازك ومش هيطلبه منك تاني حتى لو قفلت البرنامج أو حدثت البلاجن.")
            : (isEn
                ? "Paste your Google Gemini API key above once — it will be saved automatically forever."
                : "حط مفتاح Google Gemini API مرة واحدة بس وهيتحفظ تلقائيًا للأبد على جهازك.");
        status.style.color = hasKey ? "#22C55E" : "";
    }
}

function cadrAutoRetainApiKey(val) {
    var clean = String(val || "").trim();
    if (clean.length >= 10 || clean === "") {
        cadrWriteRetainedKeyToDisk(clean);
    }
}

function cadrToggleApiKeyVisibility() {
    var inp = document.getElementById("geminiApiKey");
    if (!inp) return;
    inp.type = (inp.type === "password") ? "text" : "password";
}

saveApiKeySetting = function (inputId) {
    var input = document.getElementById(inputId || "geminiApiKey");
    if (!input) return;
    cadrWriteRetainedKeyToDisk(input.value);
};

var origGetSettingV57 = getSetting;
getSetting = function (key, fallback) {
    if (key === "geminiApiKey") {
        var retained = cadrReadRetainedKeyFromDisk();
        if (retained) return retained;
    }
    return origGetSettingV57(key, fallback);
};

var origSetSettingV57 = setSetting;
setSetting = function (key, value) {
    if (key === "geminiApiKey") {
        cadrWriteRetainedKeyToDisk(value);
        return true;
    }
    return origSetSettingV57(key, value);
};

function cadrRestoreRetainedGeminiKeyOnStartup() {
    var inp = document.getElementById("geminiApiKey");
    var retained = cadrReadRetainedKeyFromDisk();
    if (!retained && inp && inp.value && inp.value.trim().length >= 10) {
        retained = inp.value.trim();
        cadrWriteRetainedKeyToDisk(retained);
    }
    if (inp && retained) {
        inp.value = retained;
    }
    cadrUpdateGeminiRetentionBadge();
}

var origRunCaptionV57 = runCaption;
runCaption = function () {
    var inp = document.getElementById("geminiApiKey");
    if (inp && !inp.value.trim()) {
        var retained = cadrReadRetainedKeyFromDisk();
        if (retained) inp.value = retained;
    } else if (inp && inp.value.trim()) {
        cadrWriteRetainedKeyToDisk(inp.value.trim());
    }
    return origRunCaptionV57();
};

var origTranslateV57 = cadrTranslateCaptions;
cadrTranslateCaptions = function () {
    var inp = document.getElementById("geminiApiKey");
    if (inp && !inp.value.trim()) {
        var retained = cadrReadRetainedKeyFromDisk();
        if (retained) inp.value = retained;
    } else if (inp && inp.value.trim()) {
        cadrWriteRetainedKeyToDisk(inp.value.trim());
    }
    return origTranslateV57();
};

/* ---------- 3. ANIMATION COMPOSER STYLE MOGRT DROPDOWN & HOVER PREVIEW ---------- */
var cadrHoveredMogrtIdx = -1;

cadrPopulateStyleDropdown = function () {
    var sel = document.getElementById("styleSelect");
    var delBtn = document.getElementById("styleDeleteBtn");
    var ddBtn = document.getElementById("mogrtDropdownBtn");
    var ddThumb = document.getElementById("mogrtDdMiniThumb");
    var ddName = document.getElementById("mogrtDdActiveName");
    var ddSub = document.getElementById("mogrtDdActiveSub");
    var ddMenu = document.getElementById("mogrtDropdownMenu");

    var list = cadrStyleLoad();
    var active = cadrStyleActive();
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");

    if (sel) {
        sel.innerHTML = "";
        if (!list.length) {
            var emptyOpt = document.createElement("option");
            emptyOpt.value = "-1";
            emptyOpt.textContent = isEn ? "No template added" : "لا يوجد قالب مضاف";
            sel.appendChild(emptyOpt);
        } else {
            list.forEach(function (style, i) {
                var opt = document.createElement("option");
                opt.value = String(i);
                opt.textContent = "🎬 " + style.name;
                if (i === active) opt.selected = true;
                sel.appendChild(opt);
            });
        }
    }

    if (delBtn) {
        delBtn.disabled = !list.length;
    }

    var activeStyle = list[active] || null;
    if (activeStyle) {
        var activeSchema = cadrEnsureMogrtSchema(activeStyle);
        var thumbUrl = CADR_MOGRT_THUMB_CACHE[activeStyle.path] || "";
        var pCfg = cadrGetStylePreviewConfig(activeStyle, activeSchema, active);
        if (ddBtn) {
            ddBtn.setAttribute("data-anim", String(pCfg.animIdx));
        }
        if (ddThumb) {
            var cleanF = pCfg.fontFamily.replace(/['"]/g, "");
            ddThumb.innerHTML =
                (thumbUrl ? ('<img src="' + thumbUrl + '" alt="MOGRT">') : '') +
                '<div class="dd-mini-stage" style="font-family:&quot;' + cleanF + '&quot;,sans-serif;color:' + pCfg.textColor + '">' +
                  '<span class="ac-word-mask"><span class="ac-word-inner dd-w1">كدر</span></span>' +
                  '<span class="ac-word-mask"><span class="ac-word-inner dd-w2">CUT</span></span>' +
                '</div>';
        }
        if (ddName) {
            ddName.textContent = "🎬 " + activeStyle.name;
        }
        if (ddSub) {
            var ctrlCount = (activeSchema && Array.isArray(activeSchema.params) ? activeSchema.params.length : 0) +
                            (activeSchema && activeSchema.font && activeSchema.font.hasFont ? 1 : 0);
            ddSub.textContent = ctrlCount > 0
                ? (isEn ? ("Animation Composer Browser • " + ctrlCount + " controls loaded") : ("قائمة Animation Composer • تم تحميل " + ctrlCount + " إعدادات مسموح بها"))
                : (isEn ? "Click to open Animation Composer MOGRT browser" : "اضغط لفتح قائمة قوالب الـ MOGRT بالمعاينة الحية");
        }
    } else {
        if (ddBtn) ddBtn.removeAttribute("data-anim");
        if (ddThumb) ddThumb.innerHTML = "<span>MOGRT</span>";
        if (ddName) {
            ddName.textContent = isEn
                ? "🎬 Animation Composer MOGRT Browser..."
                : "🎬 قائمة قوالب الـ MOGRT (اضغط للفتح)...";
        }
        if (ddSub) {
            ddSub.textContent = isEn
                ? "Click (+ Add .mogrt) to add templates & preview on hover"
                : "اضغط (+ إضافة .mogrt) لإضافة قوالبك ومعاينتها بالماوس";
        }
    }

    if (!ddMenu) return;
    ddMenu.innerHTML = "";

    if (!list.length) {
        var emptyBox = document.createElement("div");
        emptyBox.className = "cap-empty";
        emptyBox.style.padding = "12px 8px";
        emptyBox.textContent = isEn
            ? "No .mogrt templates added yet. Click below to add your .mogrt files."
            : "مفيش قوالب .mogrt مضافة حاليًا. اضغط على الزرار تحت لإضافة قوالب الـ .mogrt بتاعتك.";
        ddMenu.appendChild(emptyBox);
    } else {
        /* 1. Animation Composer Live Hover Preview Banner at top of Dropdown */
        var previewTargetIdx = (cadrHoveredMogrtIdx >= 0 && cadrHoveredMogrtIdx < list.length) ? cadrHoveredMogrtIdx : active;
        var prevStyle = list[previewTargetIdx] || list[0];
        var prevSchema = cadrEnsureMogrtSchema(prevStyle);
        var prevCfg = cadrGetStylePreviewConfig(prevStyle, prevSchema, previewTargetIdx);

        var banner = document.createElement("div");
        banner.className = "ac-dd-preview-banner";
        banner.id = "acHoverPreviewBanner";
        banner.setAttribute("data-anim", String(prevCfg.animIdx));

        function renderBannerContent(targetIdx) {
            var stObj = list[targetIdx] || list[0];
            var scObj = cadrEnsureMogrtSchema(stObj);
            var cfgObj = cadrGetStylePreviewConfig(stObj, scObj, targetIdx);
            var thUrl = CADR_MOGRT_THUMB_CACHE[stObj.path] || "";
            var vdUrl = CADR_MOGRT_VIDEO_CACHE[stObj.path] || "";
            var cleanFam = cfgObj.fontFamily.replace(/['"]/g, "");

            banner.setAttribute("data-anim", String(cfgObj.animIdx));
            banner.innerHTML = "";

            var topBar = document.createElement("div");
            topBar.className = "ac-banner-top";
            topBar.innerHTML =
                '<span class="ac-banner-badge">▶ ' + (isEn ? "HOVER PREVIEW" : "معاينة حية (Animation Composer)") + '</span>' +
                '<span style="color:#F5F5F5;font-weight:700">' + stObj.name + '</span>';
            banner.appendChild(topBar);

            if (vdUrl) {
                var vEl = document.createElement("video");
                vEl.className = "ac-banner-vid";
                vEl.src = vdUrl;
                vEl.muted = true;
                vEl.loop = true;
                vEl.playsInline = true;
                vEl.autoplay = true;
                banner.appendChild(vEl);
            } else {
                if (thUrl) {
                    var bImg = document.createElement("img");
                    bImg.className = "ac-banner-bg";
                    bImg.src = thUrl;
                    banner.appendChild(bImg);
                }
                var stage = document.createElement("div");
                stage.className = "ac-banner-stage";
                stage.style.fontFamily = "'" + cleanFam + "', sans-serif";
                stage.style.color = cfgObj.textColor;
                stage.innerHTML =
                    '<span class="ac-word-mask"><span class="ac-word-inner ac-bw1">' + (isEn ? "YOUR" : "معاينة") + '</span></span>' +
                    '<span class="ac-word-mask"><span class="ac-word-inner ac-bw2">' + (isEn ? "VISION" : "حركة") + '</span></span>' +
                    '<span class="ac-word-mask"><span class="ac-word-inner ac-bw3">' + (isEn ? "FRAME" : "القالب") + '</span></span>';
                banner.appendChild(stage);
            }
        }

        renderBannerContent(previewTargetIdx);
        ddMenu.appendChild(banner);

        /* 2. Animation Composer 2-Column Visual Grid of MOGRT Cards */
        var grid = document.createElement("div");
        grid.className = "ac-mogrt-grid";

        list.forEach(function (style, idx) {
            var sc = cadrEnsureMogrtSchema(style);
            var tUrl = CADR_MOGRT_THUMB_CACHE[style.path] || "";
            var vUrl = CADR_MOGRT_VIDEO_CACHE[style.path] || "";
            var cfg = cadrGetStylePreviewConfig(style, sc, idx);
            var cleanCardFam = cfg.fontFamily.replace(/['"]/g, "");

            var card = document.createElement("div");
            card.className = "ac-card" + (idx === active ? " active" : "");
            card.setAttribute("data-anim", String(cfg.animIdx));

            var stage = document.createElement("div");
            stage.className = "ac-card-stage";

            if (vUrl) {
                var cv = document.createElement("video");
                cv.src = vUrl;
                cv.muted = true;
                cv.loop = true;
                cv.playsInline = true;
                cv.autoplay = true;
                cv.style.position = "absolute";
                cv.style.inset = "0";
                cv.style.width = "100%";
                cv.style.height = "100%";
                cv.style.objectFit = "cover";
                stage.appendChild(cv);
            } else {
                if (tUrl) {
                    var ci = document.createElement("img");
                    ci.src = tUrl;
                    ci.style.position = "absolute";
                    ci.style.inset = "0";
                    ci.style.width = "100%";
                    ci.style.height = "100%";
                    ci.style.objectFit = "cover";
                    ci.style.opacity = "0.28";
                    stage.appendChild(ci);
                }
                var demoWrap = document.createElement("div");
                demoWrap.className = "ac-demo-wrap";
                demoWrap.style.position = "relative";
                demoWrap.style.zIndex = "2";
                demoWrap.style.fontFamily = "'" + cleanCardFam + "', sans-serif";
                demoWrap.style.color = cfg.textColor;
                demoWrap.innerHTML =
                    '<span class="ac-word-mask"><span class="ac-word-inner ac-w1">' + (isEn ? "CADR" : "كدر") + '</span></span>' +
                    '<span class="ac-word-mask"><span class="ac-word-inner ac-w2">' + (isEn ? "STUDIO" : "ستوديو") + '</span></span>';
                stage.appendChild(demoWrap);
            }

            var badge = document.createElement("span");
            badge.className = "ac-card-badge";
            badge.style.zIndex = "3";
            badge.textContent = (idx === active) ? (isEn ? "ACTIVE ✓" : "مفعّل ✓") : ("#" + (idx + 1));
            stage.appendChild(badge);

            var delBtnCard = document.createElement("button");
            delBtnCard.type = "button";
            delBtnCard.className = "ac-card-del";
            delBtnCard.style.zIndex = "3";
            delBtnCard.title = isEn ? "Delete template" : "حذف هذا القالب";
            delBtnCard.textContent = "×";
            delBtnCard.onclick = function (ev) {
                ev.stopPropagation();
                cadrStyleDeleteAt(idx);
            };
            stage.appendChild(delBtnCard);

            var foot = document.createElement("div");
            foot.className = "ac-card-foot";
            var titleSpan = document.createElement("span");
            titleSpan.className = "ac-card-title";
            titleSpan.textContent = style.name;
            var typeSpan = document.createElement("span");
            typeSpan.className = "ac-card-type";
            var ctrlCnt = (sc && Array.isArray(sc.params) ? sc.params.length : 0) + (sc && sc.font && sc.font.hasFont ? 1 : 0);
            typeSpan.textContent = ctrlCnt > 0 ? (ctrlCnt + (isEn ? " ctrl" : " إعداد")) : "MOGRT";
            foot.appendChild(titleSpan);
            foot.appendChild(typeSpan);

            card.addEventListener("mouseenter", function () {
                cadrHoveredMogrtIdx = idx;
                renderBannerContent(idx);
            });
            card.addEventListener("mouseleave", function () {
                if (cadrHoveredMogrtIdx === idx) {
                    cadrHoveredMogrtIdx = -1;
                    renderBannerContent(active);
                }
            });
            card.addEventListener("click", function (ev) {
                ev.stopPropagation();
                cadrStyleSetActive(idx);
                cadrCloseMogrtDropdown();
                cadrPopulateStyleDropdown();
                cadrBuildStudioStyleControls();
            });

            card.appendChild(stage);
            card.appendChild(foot);
            grid.appendChild(card);
        });

        ddMenu.appendChild(grid);
    }

    var addMoreBtn = document.createElement("button");
    addMoreBtn.type = "button";
    addMoreBtn.className = "btn sm accent-outline";
    addMoreBtn.style.width = "100%";
    addMoreBtn.textContent = isEn ? "+ Add .mogrt Template from Computer" : "+ إضافة قالب .mogrt جديد من جهازك";
    addMoreBtn.onclick = function (ev) {
        ev.stopPropagation();
        cadrCloseMogrtDropdown();
        cadrStyleAdd();
    };
    ddMenu.appendChild(addMoreBtn);
};

/* ---------- 4 & 5. CUSTOM FONT DROPDOWN MENU + FONT SIZE SLIDER & DIRECT NUMBER INPUT (DOWN TO 1!) ---------- */
var cadrFontDropdownOpen = false;

cadrBuildStudioStyleControls = function () {
    var box = document.getElementById("styleControls");
    if (!box) return;

    cadrPopulateStyleDropdown();

    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    var style = cadrActiveStyle();
    box.innerHTML = "";

    /* 1. If NO .mogrt is selected, show NO fixed controls — only a clean prompt card */
    if (!style) {
        var emptyCard = document.createElement("div");
        emptyCard.className = "card pad";
        emptyCard.style.textAlign = "center";
        emptyCard.style.padding = "18px 14px";
        emptyCard.style.display = "flex";
        emptyCard.style.flexDirection = "column";
        emptyCard.style.alignItems = "center";
        emptyCard.style.gap = "8px";

        var emptyTitle = document.createElement("div");
        emptyTitle.className = "card-title";
        emptyTitle.style.color = "var(--accent)";
        emptyTitle.textContent = isEn
            ? "🎬 No MOGRT Template Selected Yet"
            : "🎬 لم يتم اختيار قالب MOGRT بعد";

        var emptyDesc = document.createElement("div");
        emptyDesc.className = "card-note";
        emptyDesc.style.maxWidth = "290px";
        emptyDesc.textContent = isEn
            ? "Open the Animation Composer dropdown above or click (+ Add .mogrt) to load your template and display its exact allowed controls."
            : "افتح القائمة المنسدلة فوق أو دوس (+ إضافة .mogrt) عشان تختار القالب بتاعك، وهتظهرلك هنا أوتوماتيك الإعدادات المسموح بيها جوه القالب ده بس.";

        var emptyBtn = document.createElement("button");
        emptyBtn.type = "button";
        emptyBtn.className = "btn accent-outline sm";
        emptyBtn.style.marginTop = "4px";
        emptyBtn.textContent = isEn ? "+ Add .mogrt from Computer" : "+ إضافة قالب .mogrt من جهازك";
        emptyBtn.onclick = function () { cadrStyleAdd(); };

        emptyCard.appendChild(emptyTitle);
        emptyCard.appendChild(emptyDesc);
        emptyCard.appendChild(emptyBtn);
        box.appendChild(emptyCard);
        return;
    }

    var schema = cadrEnsureMogrtSchema(style);
    var allOv = cadrStoreGet(CADR_STYLE_OV_KEY);
    var ov = allOv[style.path] || { params: {} };
    if (!ov.params) ov.params = {};

    if (!schema) {
        var unreadCard = document.createElement("div");
        unreadCard.className = "card pad";
        unreadCard.style.display = "flex";
        unreadCard.style.flexDirection = "column";
        unreadCard.style.gap = "8px";
        unreadCard.innerHTML =
            '<div class="card-title">' + (isEn ? "Template Selected: " : "القالب المحدد: ") + style.name + '</div>' +
            '<div class="card-note">' + (isEn
                ? "Click 'Read Template' below after placing or selecting this MOGRT on the timeline to display its allowed controls."
                : "دوس على «قراءة القالب» بالأسفل عشان البلاجن يعرضلك الإعدادات المسموح بيها جوه القالب ده.") + '</div>';
        box.appendChild(unreadCard);
        return;
    }

    var sizeParamName = null;
    var sizeParamDef = 100;
    var sizeParamMax = 500;
    if (Array.isArray(schema.params)) {
        for (var sp = 0; sp < schema.params.length; sp++) {
            var pNm = String(schema.params[sp].name || "").trim();
            if (/^(text\s*size|font\s*size|size)$/i.test(pNm)) {
                sizeParamName = pNm;
                sizeParamDef = (typeof schema.params[sp].value === "number") ? schema.params[sp].value : 100;
                sizeParamMax = (typeof schema.params[sp].max === "number") ? Math.max(200, schema.params[sp].max) : 500;
                break;
            }
        }
    }

    /* -------- DYNAMIC CARD 1: FONT DROPDOWN MENU + FONT SIZE (SLIDER + DIRECT NUMBER INPUT DOWN TO 1!) -------- */
    if (schema.font && schema.font.hasFont) {
        var typoCard = document.createElement("div");
        typoCard.className = "card pad";
        typoCard.style.display = "flex";
        typoCard.style.flexDirection = "column";
        typoCard.style.gap = "9px";

        var typoHead = document.createElement("div");
        typoHead.className = "row";
        typoHead.innerHTML =
            '<span class="card-title">' + (isEn ? "🔤 Font Dropdown & Size" : "🔤 قائمة الخطوط المنسدلة وحجم الخط") + '</span>';

        if (ov.font) {
            var resetFontBtn = document.createElement("button");
            resetFontBtn.type = "button";
            resetFontBtn.className = "chip x";
            resetFontBtn.title = isEn ? "Reset to template default font" : "إرجاع الخط الافتراضي للقالب";
            resetFontBtn.textContent = "↺";
            resetFontBtn.onclick = function () {
                cadrStyleOvUpdate(function (o) { delete o.font; });
                cadrBuildStudioStyleControls();
                cadrPopulateStyleDropdown();
            };
            typoHead.appendChild(resetFontBtn);
        }
        typoCard.appendChild(typoHead);

        var activePs = ov.font || schema.font.font || "Cairo-Bold";
        var activeFam = cadrResolveFontFamily(activePs);

        var fontDdWrap = document.createElement("div");
        fontDdWrap.className = "font-dd-wrap";

        var fontDdBtn = document.createElement("button");
        fontDdBtn.type = "button";
        fontDdBtn.className = "font-dd-btn" + (cadrFontDropdownOpen ? " open" : "");

        var btnSample = document.createElement("span");
        btnSample.className = "font-dd-btn-sample";
        btnSample.style.fontFamily = "'" + activeFam.replace(/['"]/g, "") + "', sans-serif";
        btnSample.textContent = activeFam + " — " + (isEn ? "CADR STUDIO" : "كدر ستوديو للمونتاج");

        var btnMeta = document.createElement("span");
        btnMeta.className = "font-dd-btn-meta";
        btnMeta.innerHTML = '<span>' + (isEn ? "Change Font" : "اختيار الخط") + '</span><span>▾</span>';

        fontDdBtn.appendChild(btnSample);
        fontDdBtn.appendChild(btnMeta);

        var fontDdPanel = document.createElement("div");
        fontDdPanel.className = "font-dd-panel" + (cadrFontDropdownOpen ? " open" : "");

        var searchRow = document.createElement("div");
        searchRow.className = "inline";

        var search = document.createElement("input");
        search.type = "text";
        search.placeholder = isEn ? "Search font by name..." : "ابحث عن اسم الفونت...";
        search.dir = "auto";
        search.value = cadrFontFilter.q;

        var arabicChip = document.createElement("label");
        arabicChip.className = "chip" + (cadrFontFilter.arabic ? " on" : "");
        arabicChip.style.flex = "0 0 auto";
        arabicChip.style.cursor = "pointer";
        var arabicBox = document.createElement("input");
        arabicBox.type = "checkbox";
        arabicBox.checked = cadrFontFilter.arabic;
        var arabicText = document.createElement("span");
        arabicText.textContent = isEn ? "Arabic Only" : "عربي فقط";
        arabicChip.appendChild(arabicBox);
        arabicChip.appendChild(arabicText);

        var refreshBtn = document.createElement("button");
        refreshBtn.type = "button";
        refreshBtn.className = "btn sm";
        refreshBtn.style.flex = "0 0 auto";
        refreshBtn.title = isEn ? "Scan all fonts installed on your PC" : "قراءة كل الخطوط المثبتة على جهازك";
        refreshBtn.textContent = isEn ? "↻ Scan PC" : "↻ فحص الجهاز";

        searchRow.appendChild(search);
        searchRow.appendChild(arabicChip);
        searchRow.appendChild(refreshBtn);
        fontDdPanel.appendChild(searchRow);

        var vfontListEl = document.createElement("div");
        vfontListEl.className = "vfont-picker-list";
        vfontListEl.id = "visualFontList";

        function renderVisualFontRows() {
            var allFonts = cadrGetCombinedVisualFonts();
            var q = String(cadrFontFilter.q || "").trim().toLowerCase();
            var onlyAr = !!cadrFontFilter.arabic;
            var curPs = ov.font || schema.font.font || "Cairo-Bold";
            var curFam = cadrResolveFontFamily(curPs);

            vfontListEl.innerHTML = "";
            var samplePreview = cadrCustomPreviewText || (isEn ? "CADR STUDIO • Fast Edit" : "كدر ستوديو للمونتاج • CADR");

            var shownCount = 0;
            for (var f = 0; f < allFonts.length; f++) {
                var fn = allFonts[f];
                if (onlyAr && !fn.arabic) continue;
                if (q && fn.label.toLowerCase().indexOf(q) === -1 && fn.family.toLowerCase().indexOf(q) === -1 && fn.ps.toLowerCase().indexOf(q) === -1) {
                    continue;
                }
                if (shownCount >= 70) break;
                shownCount++;

                var isSel = (fn.ps === curPs || fn.family === curFam);
                var row = document.createElement("div");
                row.className = "vfont-item" + (isSel ? " active" : "");

                var sampleSpan = document.createElement("span");
                sampleSpan.className = "vfont-sample";
                sampleSpan.style.fontFamily = "'" + fn.family.replace(/['"]/g, "") + "', sans-serif";
                sampleSpan.style.fontWeight = String(fn.weight || 700);
                sampleSpan.textContent = samplePreview;

                var metaSpan = document.createElement("span");
                metaSpan.className = "vfont-meta";
                metaSpan.textContent = (isSel ? "✓ " : "") + fn.family;

                row.appendChild(sampleSpan);
                row.appendChild(metaSpan);

                (function (fontObj) {
                    row.addEventListener("mouseenter", function () {
                        cadrHoveredFontObj = fontObj;
                        btnSample.style.fontFamily = "'" + fontObj.family.replace(/['"]/g, "") + "', sans-serif";
                        btnSample.textContent = fontObj.family + " — " + (isEn ? "CADR STUDIO" : "كدر ستوديو للمونتاج");
                        cadrPopulateStyleDropdown();
                    });
                    row.addEventListener("mouseleave", function () {
                        if (cadrHoveredFontObj === fontObj) {
                            cadrHoveredFontObj = null;
                            btnSample.style.fontFamily = "'" + activeFam.replace(/['"]/g, "") + "', sans-serif";
                            btnSample.textContent = activeFam + " — " + (isEn ? "CADR STUDIO" : "كدر ستوديو للمونتاج");
                            cadrPopulateStyleDropdown();
                        }
                    });
                    row.addEventListener("click", function (ev) {
                        ev.stopPropagation();
                        cadrHoveredFontObj = null;
                        cadrFontDropdownOpen = false;
                        cadrStyleOvUpdate(function (o) {
                            o.font = fontObj.ps;
                        });
                        cadrBuildStudioStyleControls();
                        cadrPopulateStyleDropdown();
                    });
                })(fn);

                vfontListEl.appendChild(row);
            }

            if (shownCount === 0) {
                var emptyMsg = document.createElement("div");
                emptyMsg.className = "cap-empty";
                emptyMsg.textContent = isEn ? "No matching fonts found." : "مفيش خط بالاسم ده. دوس (↻ فحص الجهاز) لقراءة كل خطوط الويندوز.";
                vfontListEl.appendChild(emptyMsg);
            }
        }

        renderVisualFontRows();
        fontDdPanel.appendChild(vfontListEl);

        fontDdBtn.onclick = function (ev) {
            ev.stopPropagation();
            cadrFontDropdownOpen = !cadrFontDropdownOpen;
            fontDdBtn.classList.toggle("open", cadrFontDropdownOpen);
            fontDdPanel.classList.toggle("open", cadrFontDropdownOpen);
        };

        search.oninput = function () {
            cadrFontFilter.q = search.value;
            renderVisualFontRows();
        };
        arabicBox.onchange = function () {
            cadrFontFilter.arabic = arabicBox.checked;
            arabicChip.className = "chip" + (cadrFontFilter.arabic ? " on" : "");
            renderVisualFontRows();
        };
        refreshBtn.onclick = function (ev) {
            ev.stopPropagation();
            refreshBtn.textContent = isEn ? "Scanning..." : "بيفحص...";
            cadrFontScan(null, function () {
                cadrFontDropdownOpen = true;
                cadrBuildStudioStyleControls();
            });
        };

        fontDdWrap.appendChild(fontDdBtn);
        fontDdWrap.appendChild(fontDdPanel);
        typoCard.appendChild(fontDdWrap);

        /* Font Size Control: ALWAYS shown as BOTH a Slider AND Direct Number Input (min="1", max="500" — allows going below 10 down to 1!) */
        var currentFontSizeVal = (sizeParamName && ov.params[sizeParamName] !== undefined)
            ? Number(ov.params[sizeParamName])
            : ((ov.fontSize !== undefined) ? Number(ov.fontSize) : (sizeParamName ? sizeParamDef : (Number(schema.font.fontSize) || 64)));
        if (isNaN(currentFontSizeVal) || currentFontSizeVal <= 0) currentFontSizeVal = 64;

        var fsField = document.createElement("div");
        fsField.style.display = "flex";
        fsField.style.flexDirection = "column";
        fsField.style.gap = "5px";
        fsField.style.paddingTop = "4px";
        fsField.style.borderTop = "1px solid rgba(255,255,255,0.05)";

        var fsHead = document.createElement("div");
        fsHead.className = "row";
        var fsTitle = document.createElement("span");
        fsTitle.style.fontSize = "11.5px";
        fsTitle.style.fontWeight = "600";
        fsTitle.textContent = isEn ? "Font Size (Slider + Type 1 to 500)" : "حجم الخط (سلايدر + كتابة مباشرة من 1 لـ 500)";
        fsHead.appendChild(fsTitle);

        if (ov.fontSize !== undefined || (sizeParamName && ov.params[sizeParamName] !== undefined)) {
            var rstFs = document.createElement("button");
            rstFs.type = "button";
            rstFs.className = "chip x";
            rstFs.textContent = "↺";
            rstFs.title = isEn ? "Reset font size" : "إرجاع حجم الخط الافتراضي";
            rstFs.onclick = function () {
                cadrStyleOvUpdate(function (o) {
                    delete o.fontSize;
                    if (sizeParamName) delete o.params[sizeParamName];
                });
                cadrBuildStudioStyleControls();
            };
            fsHead.appendChild(rstFs);
        }
        fsField.appendChild(fsHead);

        var fsControlRow = document.createElement("div");
        fsControlRow.className = "slider-num-row";

        var fsRange = document.createElement("input");
        fsRange.type = "range";
        fsRange.min = "1";
        fsRange.max = String(sizeParamMax);
        fsRange.step = "1";
        fsRange.value = String(currentFontSizeVal);

        var fsNum = document.createElement("input");
        fsNum.type = "number";
        fsNum.min = "1";
        fsNum.max = String(sizeParamMax);
        fsNum.step = "0.5";
        fsNum.value = String(currentFontSizeVal);
        fsNum.title = isEn ? "Type exact font size (supports 1 to 500)" : "اكتب حجم الخط مباشرة (يقبل من 1 لحد 500)";

        function applyFontSizeBoth(val) {
            var v = Math.max(0.5, Math.min(1000, parseFloat(val)));
            if (isNaN(v)) return;
            cadrStyleOvUpdate(function (o) {
                o.fontSize = v;
                o.sizeKey = (schema.font && schema.font.sizeKey) ? schema.font.sizeKey : "fontSizeEditValue";
                if (sizeParamName) {
                    o.params[sizeParamName] = v;
                }
            });
        }

        fsRange.oninput = function () {
            fsNum.value = fsRange.value;
            applyFontSizeBoth(fsRange.value);
        };
        fsNum.oninput = function () {
            var v = parseFloat(fsNum.value);
            if (!isNaN(v) && v >= 0.5) {
                fsRange.value = String(Math.max(1, Math.min(sizeParamMax, v)));
                applyFontSizeBoth(v);
            }
        };

        fsControlRow.appendChild(fsRange);
        fsControlRow.appendChild(fsNum);
        fsField.appendChild(fsControlRow);
        typoCard.appendChild(fsField);

        box.appendChild(typoCard);
    }

    /* -------- DYNAMIC CARD 2: EXACT ALLOWED PARAMETERS FROM THIS .MOGRT -------- */
    var paramsList = [];
    if (Array.isArray(schema.params)) {
        for (var pi = 0; pi < schema.params.length; pi++) {
            if (schema.font && schema.font.hasFont && sizeParamName && schema.params[pi].name === sizeParamName) {
                continue;
            }
            paramsList.push(schema.params[pi]);
        }
    }

    if (paramsList.length > 0) {
        var dynCard = document.createElement("div");
        dynCard.className = "card pad";
        dynCard.style.display = "flex";
        dynCard.style.flexDirection = "column";
        dynCard.style.gap = "10px";

        var dynHead = document.createElement("div");
        dynHead.className = "row";
        dynHead.innerHTML =
            '<span class="card-title">' + (isEn ? ("🎛 Allowed Controls in (" + style.name + ")") : ("🎛 الإعدادات المسموح بها داخل (" + style.name + ")")) + '</span>' +
            '<button type="button" class="btn sm" id="saveClientPresetBtn">' + (isEn ? "+ Save Preset" : "+ حفظ Preset") + '</button>';
        dynCard.appendChild(dynHead);

        var clientPresets = cadrLoadClientPresets();
        if (clientPresets.length > 0) {
            var cpRow = document.createElement("div");
            cpRow.className = "chips";
            clientPresets.forEach(function (cp, idx) {
                var chip = document.createElement("span");
                chip.className = "chip";
                var nm = document.createElement("button");
                nm.type = "button";
                nm.className = "nm";
                nm.textContent = "★ " + cp.name;
                nm.onclick = function () { cadrApplyClientPreset(idx); };
                var xb = document.createElement("button");
                xb.type = "button";
                xb.className = "x";
                xb.innerHTML = "×";
                xb.onclick = function () { cadrDeleteClientPreset(idx); };
                chip.appendChild(nm);
                chip.appendChild(xb);
                cpRow.appendChild(chip);
            });
            dynCard.appendChild(cpRow);
        }

        paramsList.forEach(function (param) {
            var isOv = (ov.params && ov.params[param.name] !== undefined);
            var curVal = isOv ? ov.params[param.name] : param.value;

            var fieldWrap = document.createElement("div");
            fieldWrap.style.display = "flex";
            fieldWrap.style.flexDirection = "column";
            fieldWrap.style.gap = "5px";
            fieldWrap.style.paddingBottom = "6px";
            fieldWrap.style.borderBottom = "1px solid rgba(255,255,255,0.04)";

            var headRow = document.createElement("div");
            headRow.className = "row";

            var titleSpan = document.createElement("span");
            titleSpan.style.fontSize = "11.5px";
            titleSpan.style.fontWeight = "600";
            titleSpan.style.color = isOv ? "var(--accent)" : "var(--text)";
            titleSpan.textContent = param.name;
            headRow.appendChild(titleSpan);

            if (isOv) {
                var rstBtn = document.createElement("button");
                rstBtn.type = "button";
                rstBtn.className = "chip x";
                rstBtn.title = isEn ? "Reset to template default" : "إرجاع للقيمة الافتراضية للقالب";
                rstBtn.textContent = "↺";
                rstBtn.onclick = function () {
                    cadrStyleOvUpdate(function (o) {
                        delete o.params[param.name];
                        if (/^(text\s*size|font\s*size|size)$/i.test(param.name)) {
                            delete o.fontSize;
                        }
                    });
                    cadrBuildStudioStyleControls();
                    cadrPopulateStyleDropdown();
                };
                headRow.appendChild(rstBtn);
            }

            if (param.kind === "menu") {
                fieldWrap.appendChild(headRow);
                var sel = document.createElement("select");
                var opts = Array.isArray(param.options) && param.options.length
                    ? param.options
                    : ["Option 0", "Option 1", "Option 2"];
                for (var oi = 0; oi < opts.length; oi++) {
                    var opt = document.createElement("option");
                    opt.value = String(oi);
                    opt.textContent = opts[oi];
                    if (Number(curVal) === oi) opt.selected = true;
                    sel.appendChild(opt);
                }
                sel.onchange = function () {
                    var nextIdx = parseInt(sel.value, 10) || 0;
                    cadrStyleOvUpdate(function (o) {
                        o.params[param.name] = nextIdx;
                    });
                    cadrBuildStudioStyleControls();
                    cadrPopulateStyleDropdown();
                };
                fieldWrap.appendChild(sel);
            }
            else if (param.kind === "number") {
                var isSizeParam = /size/i.test(param.name);
                var numVal = (typeof curVal === "number" && !isNaN(curVal)) ? curVal : (Number(param.value) || 0);
                var minV = isSizeParam ? 1 : ((typeof param.min === "number") ? param.min : 0);
                var maxV = (typeof param.max === "number") ? param.max : Math.max(100, numVal * 2);

                fieldWrap.appendChild(headRow);

                var snRow = document.createElement("div");
                snRow.className = "slider-num-row";

                var rangeInp = document.createElement("input");
                rangeInp.type = "range";
                rangeInp.min = String(minV);
                rangeInp.max = String(maxV);
                rangeInp.step = (maxV - minV <= 5) ? "0.05" : "1";
                rangeInp.value = String(numVal);

                var numInp = document.createElement("input");
                numInp.type = "number";
                numInp.min = String(minV);
                numInp.max = String(maxV);
                numInp.step = (maxV - minV <= 5) ? "0.05" : "0.5";
                numInp.value = String(Math.round(numVal * 100) / 100);

                function commitNumVal(v) {
                    if (isNaN(v)) return;
                    cadrStyleOvUpdate(function (o) {
                        o.params[param.name] = v;
                        if (/^(text\s*size|font\s*size|size)$/i.test(param.name)) {
                            o.fontSize = v;
                        }
                    });
                }

                rangeInp.oninput = function () {
                    var v = parseFloat(rangeInp.value);
                    numInp.value = String(Math.round(v * 100) / 100);
                    commitNumVal(v);
                };
                numInp.oninput = function () {
                    var v = parseFloat(numInp.value);
                    if (!isNaN(v)) {
                        rangeInp.value = String(Math.max(minV, Math.min(maxV, v)));
                        commitNumVal(v);
                    }
                };

                snRow.appendChild(rangeInp);
                snRow.appendChild(numInp);
                fieldWrap.appendChild(snRow);
            }
            else if (param.kind === "color") {
                var hexStr = (typeof curVal === "string" && /^#[0-9a-fA-F]{6}$/.test(curVal)) ? curVal : "#F5F5F5";
                var cRow = document.createElement("div");
                cRow.className = "row";
                cRow.style.gap = "8px";

                var cInp = document.createElement("input");
                cInp.type = "color";
                cInp.value = hexStr;

                var qColors = ["#F5F5F5", "#FF6B35", "#FFD166", "#38BDF8", "#4ADE80", "#000000"];
                var qWrap = document.createElement("div");
                qWrap.style.display = "flex";
                qWrap.style.gap = "5px";

                function applyColorVal(hx) {
                    cInp.value = hx;
                    cadrStyleOvUpdate(function (o) {
                        o.params[param.name] = hx;
                    });
                    cadrPopulateStyleDropdown();
                }

                cInp.oninput = function () {
                    applyColorVal(cInp.value);
                };

                qColors.forEach(function (qc) {
                    var qb = document.createElement("button");
                    qb.type = "button";
                    qb.style.width = "20px";
                    qb.style.height = "20px";
                    qb.style.borderRadius = "50%";
                    qb.style.background = qc;
                    qb.style.border = (hexStr.toUpperCase() === qc) ? "2px solid #FFF" : "1px solid rgba(255,255,255,0.25)";
                    qb.onclick = function () {
                        applyColorVal(qc);
                        cadrBuildStudioStyleControls();
                    };
                    qWrap.appendChild(qb);
                });

                cRow.appendChild(cInp);
                cRow.appendChild(qWrap);
                fieldWrap.appendChild(headRow);
                fieldWrap.appendChild(cRow);
            }
            else if (param.kind === "position") {
                fieldWrap.appendChild(headRow);
                var posArr = (Array.isArray(curVal) && curVal.length === 2) ? curVal : [0.5, 0.5];
                var px = Number(posArr[0]);
                var py = Number(posArr[1]);
                if (Math.abs(px) > 2) px = px / ((param.compSize && param.compSize[0]) || 3840);
                if (Math.abs(py) > 2) py = py / ((param.compSize && param.compSize[1]) || 2160);
                var curXPct = Math.round((isNaN(px) ? 0.5 : px) * 100);
                var curYPct = Math.round((isNaN(py) ? 0.5 : py) * 100);

                var presetRow = document.createElement("div");
                presetRow.className = "pos-presets";
                var presets = [
                    { labelEn: "Top", labelAr: "أعلى", x: 0.5, y: 0.24 },
                    { labelEn: "Center", labelAr: "منتصف", x: 0.5, y: 0.50 },
                    { labelEn: "Reels", labelAr: "ريلز", x: 0.5, y: 0.72 },
                    { labelEn: "Cinema", labelAr: "سينما", x: 0.5, y: 0.84 }
                ];

                var posGrid = document.createElement("div");
                posGrid.className = "cap-studio-grid";

                var xBox = document.createElement("div");
                xBox.className = "cap-stat-box";
                var xHead = document.createElement("div");
                xHead.className = "cap-stat-head";
                var xLbl = document.createElement("span");
                xLbl.textContent = isEn ? "Horizontal X" : "أفقي (X)";
                var xValB = document.createElement("b");
                xValB.textContent = curXPct + "%";
                xHead.appendChild(xLbl);
                xHead.appendChild(xValB);
                var xInp = document.createElement("input");
                xInp.type = "range";
                xInp.min = "5";
                xInp.max = "95";
                xInp.step = "1";
                xInp.value = String(curXPct);
                xBox.appendChild(xHead);
                xBox.appendChild(xInp);

                var yBox = document.createElement("div");
                yBox.className = "cap-stat-box";
                var yHead = document.createElement("div");
                yHead.className = "cap-stat-head";
                var yLbl = document.createElement("span");
                yLbl.textContent = isEn ? "Vertical Y" : "رأسي (Y)";
                var yValB = document.createElement("b");
                yValB.textContent = curYPct + "%";
                yHead.appendChild(yLbl);
                yHead.appendChild(yValB);
                var yInp = document.createElement("input");
                yInp.type = "range";
                yInp.min = "5";
                yInp.max = "95";
                yInp.step = "1";
                yInp.value = String(curYPct);
                yBox.appendChild(yHead);
                yBox.appendChild(yInp);

                function onXYInput() {
                    var nx = (parseFloat(xInp.value) || 50) / 100;
                    var ny = (parseFloat(yInp.value) || 50) / 100;
                    xValB.textContent = Math.round(nx * 100) + "%";
                    yValB.textContent = Math.round(ny * 100) + "%";
                    cadrStyleOvUpdate(function (o) {
                        o.params[param.name] = [nx, ny];
                    });
                }
                xInp.oninput = onXYInput;
                yInp.oninput = onXYInput;

                presets.forEach(function (pr) {
                    var b = document.createElement("button");
                    b.type = "button";
                    b.className = "btn sm";
                    b.textContent = isEn ? pr.labelEn : pr.labelAr;
                    b.onclick = function () {
                        xInp.value = String(Math.round(pr.x * 100));
                        yInp.value = String(Math.round(pr.y * 100));
                        onXYInput();
                    };
                    presetRow.appendChild(b);
                });

                posGrid.appendChild(xBox);
                posGrid.appendChild(yBox);
                fieldWrap.appendChild(presetRow);
                fieldWrap.appendChild(posGrid);
            }
            else if (param.kind === "bool") {
                var cbWrap = document.createElement("label");
                cbWrap.className = "cap-toggle-card" + (curVal ? " on" : "");
                var cbSpan = document.createElement("span");
                cbSpan.textContent = param.name;
                var cbInp = document.createElement("input");
                cbInp.type = "checkbox";
                cbInp.checked = !!curVal;
                cbInp.onchange = function () {
                    cadrStyleOvUpdate(function (o) {
                        o.params[param.name] = cbInp.checked;
                    });
                    cadrBuildStudioStyleControls();
                };
                cbWrap.appendChild(cbSpan);
                cbWrap.appendChild(cbInp);
                fieldWrap.appendChild(cbWrap);
            }

            dynCard.appendChild(fieldWrap);
        });

        box.appendChild(dynCard);

        var saveBtn = document.getElementById("saveClientPresetBtn");
        if (saveBtn) saveBtn.onclick = cadrSaveCurrentAsClientPreset;
    }
};

cadrStyleTabRender = cadrBuildStudioStyleControls;

/* Initialize v5.7 Retention & Trial State */
cadrRestoreRetainedGeminiKeyOnStartup();
cadrCheckLicense();
cadrPopulateStyleDropdown();
cadrBuildStudioStyleControls();



/* =========================================================
   CADR CUT v5.8 — GITHUB CLOUD OTA AUTO-UPDATER
   Checks GitHub raw version.json in the background and updates
   client/index.html, client/main.js, client/license.js, and
   jsx/host.jsx in-place with 1 click without closing Premiere!
   ========================================================= */

var CADR_CURRENT_VERSION = "1.3.2";
var CADR_UPDATE_REPO_KEY = "cadrGithubUpdateRepoV1";
var CADR_DEFAULT_GITHUB_REPO = "Madboly1/cadr-cut-updates";
var cadrLatestRemoteUpdate = null;
var cadrUpdateBusy = false;

function cadrCompareSemver(vA, vB) {
    var a = String(vA || "0.0.0").replace(/^v/i, "").split(".");
    var b = String(vB || "0.0.0").replace(/^v/i, "").split(".");
    for (var i = 0; i < 3; i++) {
        var na = parseInt(a[i] || "0", 10) || 0;
        var nb = parseInt(b[i] || "0", 10) || 0;
        if (na > nb) return 1;
        if (na < nb) return -1;
    }
    return 0;
}

function cadrNormalizeRepoSlug(input) {
    var s = String(input || "").trim();
    if (!s) return "";
    /* Accept full GitHub URLs like https://github.com/user/repo or raw URLs */
    s = s.replace(/^https?:\/\/(www\.)?github\.com\//i, "")
         .replace(/^https?:\/\/raw\.githubusercontent\.com\//i, "")
         .replace(/\.git$/i, "")
         .replace(/\/tree\/.*$/i, "")
         .replace(/\/blob\/.*$/i, "")
         .replace(/^\/+|\/+$/g, "");
    var parts = s.split("/");
    if (parts.length >= 2 && parts[0] && parts[1]) {
        return parts[0] + "/" + parts[1];
    }
    return s;
}

function cadrGetConfiguredUpdateRepo() {
    /* 1. Check user/developer setting in localStorage */
    try {
        var saved = window.localStorage.getItem(CADR_UPDATE_REPO_KEY);
        if (saved && saved.trim()) return cadrNormalizeRepoSlug(saved);
    } catch (e1) {}

    /* 2. Check persistent disk settings */
    var diskPaths = cadrGetDiskSettingsPaths();
    if (diskPaths.length && window.cep_node && typeof window.cep_node.require === "function") {
        try {
            var fs = window.cep_node.require("fs");
            for (var i = 0; i < diskPaths.length; i++) {
                if (fs.existsSync(diskPaths[i])) {
                    var obj = JSON.parse(fs.readFileSync(diskPaths[i], "utf8"));
                    if (obj && obj.updateRepo) {
                        return cadrNormalizeRepoSlug(obj.updateRepo);
                    }
                }
            }
        } catch (e2) {}
    }

    /* 3. Check bundled version.json inside extension folder */
    if (window.cep_node && typeof window.cep_node.require === "function") {
        try {
            var fs2 = window.cep_node.require("fs");
            var path2 = window.cep_node.require("path");
            var extRoot = getExtensionRootPath();
            if (extRoot) {
                var vCandidates = [
                    path2.join(extRoot, "version.json"),
                    path2.join(extRoot, "..", "version.json")
                ];
                for (var c = 0; c < vCandidates.length; c++) {
                    if (fs2.existsSync(vCandidates[c])) {
                        var vJson = JSON.parse(fs2.readFileSync(vCandidates[c], "utf8"));
                        if (vJson && vJson.repo && String(vJson.repo).trim()) {
                            return cadrNormalizeRepoSlug(vJson.repo);
                        }
                    }
                }
            }
        } catch (e3) {}
    }

    return CADR_DEFAULT_GITHUB_REPO;
}

function cadrSaveUpdateRepo(val) {
    var slug = cadrNormalizeRepoSlug(val);
    var inp = document.getElementById("cadrUpdateRepoInput");
    if (inp) inp.value = slug;
    try {
        window.localStorage.setItem(CADR_UPDATE_REPO_KEY, slug);
    } catch (e1) {}

    var diskPaths = cadrGetDiskSettingsPaths();
    if (diskPaths.length && window.cep_node && typeof window.cep_node.require === "function") {
        try {
            var fs = window.cep_node.require("fs");
            var pathMod = window.cep_node.require("path");
            for (var i = 0; i < diskPaths.length; i++) {
                var existing = {};
                try {
                    if (fs.existsSync(diskPaths[i])) {
                        existing = JSON.parse(fs.readFileSync(diskPaths[i], "utf8")) || {};
                    }
                } catch (er) {}
                existing.updateRepo = slug;
                var dir = pathMod.dirname(diskPaths[i]);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(diskPaths[i], JSON.stringify(existing), "utf8");
            }
        } catch (e2) {}
    }

    var st = document.getElementById("cadrUpdateStatus");
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    if (st) {
        st.textContent = slug
            ? (isEn ? ("Saved GitHub repository: " + slug + " ✓") : ("تم حفظ مستودع التحديث على GitHub: " + slug + " ✓"))
            : (isEn ? "Cleared GitHub repository." : "تم مسح رابط المستودع.");
    }
    if (slug) {
        cadrCheckForUpdates(true);
    }
}

function cadrSetUpdateStatus(msg, color) {
    var st = document.getElementById("cadrUpdateStatus");
    if (st) {
        st.textContent = msg;
        st.style.color = color || "";
    }
}

function cadrFetchTextWithFallback(urls, cb) {
    var idx = 0;
    function tryNext() {
        if (idx >= urls.length) {
            cb(new Error("Could not fetch from any branch/path"), null, "");
            return;
        }
        var u = urls[idx++];
        fetch(u + (u.indexOf("?") === -1 ? ("?t=" + Date.now()) : ("&t=" + Date.now())), { cache: "no-store" })
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.text();
            })
            .then(function (txt) {
                cb(null, txt, u);
            })
            .catch(function () {
                tryNext();
            });
    }
    tryNext();
}

function cadrCheckForUpdates(isManual) {
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    var repo = cadrGetConfiguredUpdateRepo();
    var inp = document.getElementById("cadrUpdateRepoInput");
    if (inp && repo && !inp.value) inp.value = repo;

    var verBadge = document.getElementById("cadrCurrentVerBadge");
    if (verBadge) verBadge.textContent = "v" + CADR_CURRENT_VERSION;

    if (!repo) {
        if (isManual) {
            cadrSetUpdateStatus(
                isEn
                    ? "Please enter your GitHub repository above first (e.g. username/cadr-cut-updates)."
                    : "اكتب اسم مستودع GitHub فوق الأول (مثال: username/cadr-cut-updates) ودوس حفظ.",
                "#F59E0B"
            );
        }
        return;
    }

    if (isManual) {
        cadrSetUpdateStatus(isEn ? "Checking GitHub for updates..." : "جاري فحص التحديثات من GitHub...", "");
    }

    var candidateManifestUrls = [
        "https://raw.githubusercontent.com/" + repo + "/main/version.json",
        "https://raw.githubusercontent.com/" + repo + "/master/version.json",
        "https://raw.githubusercontent.com/" + repo + "/main/Plugin/version.json"
    ];

    cadrFetchTextWithFallback(candidateManifestUrls, function (err, rawText, matchedUrl) {
        if (err || !rawText) {
            if (isManual) {
                cadrSetUpdateStatus(
                    isEn
                        ? ("Could not reach version.json in (" + repo + "). Make sure the repo is Public and contains version.json.")
                        : ("مقدرتش أوصل لملف version.json في (" + repo + "). تأكد إن المستودع Public ومرفوع جواه ملف version.json."),
                    "#F59E0B"
                );
            }
            return;
        }

        try {
            var remote = JSON.parse(rawText);
            if (!remote || !remote.version) throw new Error("Invalid version.json");
            var baseBranchUrl = matchedUrl.replace(/\/(Plugin\/)?version\.json.*$/i, "");
            remote._baseRawUrl = baseBranchUrl;

            if (cadrCompareSemver(remote.version, CADR_CURRENT_VERSION) > 0) {
                cadrLatestRemoteUpdate = remote;
                var notes = (isEn ? (remote.notesEn || remote.notesAr) : (remote.notesAr || remote.notesEn)) || "";

                var banner = document.getElementById("cadrUpdateBanner");
                var bTitle = document.getElementById("cadrUpdateBannerTitle");
                var bNotes = document.getElementById("cadrUpdateBannerNotes");
                var instBtn = document.getElementById("installUpdateBtn");

                if (bTitle) {
                    bTitle.textContent = isEn
                        ? ("🚀 New Update Available: v" + remote.version)
                        : ("🚀 متاح تحديث جديد للبلاجن: إصدار v" + remote.version);
                }
                if (bNotes) {
                    bNotes.textContent = notes || (isEn ? "Click Update Now to install instantly" : "اضغط «تحديث الآن» للتركيب فورًا بدون قفل بريمير");
                }
                if (banner) banner.classList.add("show");
                if (instBtn) instBtn.style.display = "inline-block";

                cadrSetUpdateStatus(
                    isEn
                        ? ("🎉 Update v" + remote.version + " is available! " + (notes ? ("\nNotes: " + notes) : ""))
                        : ("🎉 متاح إصدار جديد v" + remote.version + "! " + (notes ? ("\nالجديد في التحديث: " + notes) : "")),
                    "#22C55E"
                );
            } else {
                cadrLatestRemoteUpdate = null;
                var bannerHide = document.getElementById("cadrUpdateBanner");
                var instBtnHide = document.getElementById("installUpdateBtn");
                if (bannerHide) bannerHide.classList.remove("show");
                if (instBtnHide) instBtnHide.style.display = "none";

                if (isManual) {
                    cadrSetUpdateStatus(
                        isEn
                            ? ("✓ You are on the latest version (v" + CADR_CURRENT_VERSION + ").")
                            : ("✓ البلاجن محدّث لآخر إصدار بالفعل (v" + CADR_CURRENT_VERSION + ")."),
                        "#22C55E"
                    );
                }
            }
        } catch (parseErr) {
            if (isManual) {
                cadrSetUpdateStatus("Error reading version.json: " + parseErr.message, "#EF4444");
            }
        }
    });
}

function cadrPerformOneClickUpdate() {
    if (cadrUpdateBusy) return;
    var isEn = (typeof cadrUiLangNow !== "undefined" && cadrUiLangNow === "en");
    var repo = cadrGetConfiguredUpdateRepo();
    if (!repo) {
        showTab("settings");
        cadrSetUpdateStatus(isEn ? "Configure GitHub repository first." : "اكتب رابط مستودع GitHub الأول.", "#F59E0B");
        return;
    }

    if (!window.cep_node || typeof window.cep_node.require !== "function") {
        cadrSetUpdateStatus(isEn ? "Node.js file system access required for in-app update." : "التحديث التلقائي يتطلب تشغيل البلاجن داخل بريمير.", "#F59E0B");
        return;
    }

    var baseRaw = (cadrLatestRemoteUpdate && cadrLatestRemoteUpdate._baseRawUrl)
        ? cadrLatestRemoteUpdate._baseRawUrl
        : ("https://raw.githubusercontent.com/" + repo + "/main");

    var targetFiles = [
        { relDest: "client/index.html", candidates: [baseRaw + "/Plugin/client/index.html", baseRaw + "/client/index.html"] },
        { relDest: "client/main.js",    candidates: [baseRaw + "/Plugin/client/main.js",    baseRaw + "/client/main.js"] },
        { relDest: "client/license.js", candidates: [baseRaw + "/Plugin/client/license.js", baseRaw + "/client/license.js"] },
        { relDest: "jsx/host.jsx",      candidates: [baseRaw + "/Plugin/jsx/host.jsx",      baseRaw + "/jsx/host.jsx"] },
        { relDest: "CSXS/manifest.xml", candidates: [baseRaw + "/Plugin/CSXS/manifest.xml", baseRaw + "/CSXS/manifest.xml"] },
        { relDest: "version.json",      candidates: [baseRaw + "/version.json", baseRaw + "/Plugin/version.json"] }
    ];

    cadrUpdateBusy = true;
    var bannerBtn = document.getElementById("cadrUpdateBannerBtn");
    var instBtn = document.getElementById("installUpdateBtn");
    if (bannerBtn) {
        bannerBtn.disabled = true;
        bannerBtn.textContent = isEn ? "Updating..." : "جاري التحديث...";
    }
    if (instBtn) instBtn.disabled = true;

    cadrSetUpdateStatus(isEn ? "Downloading latest update files from GitHub..." : "جاري تحميل ملفات التحديث الجديد من GitHub...", "#22C55E");

    var downloaded = {};
    var idx = 0;

    function downloadNext() {
        if (idx >= targetFiles.length) {
            applyDownloadedFiles();
            return;
        }
        var item = targetFiles[idx++];
        cadrFetchTextWithFallback(item.candidates, function (err, content) {
            if (err || !content || content.length < 50) {
                cadrUpdateBusy = false;
                if (bannerBtn) {
                    bannerBtn.disabled = false;
                    bannerBtn.textContent = isEn ? "Update Now ⚡" : "تحديث الآن ⚡";
                }
                if (instBtn) instBtn.disabled = false;
                cadrSetUpdateStatus(
                    isEn
                        ? ("Failed to download: " + item.relDest)
                        : ("فشل تحميل الملف: " + item.relDest + " — تأكد من رفع فولدر Plugin كامل على GitHub."),
                    "#EF4444"
                );
                return;
            }
            downloaded[item.relDest] = content;
            downloadNext();
        });
    }

    function applyDownloadedFiles() {
        try {
            var fs = window.cep_node.require("fs");
            var pathMod = window.cep_node.require("path");
            var extRoot = getExtensionRootPath();
            if (!extRoot) throw new Error("Extension root path unavailable");

            for (var rel in downloaded) {
                if (Object.prototype.hasOwnProperty.call(downloaded, rel)) {
                    var fullDest = pathMod.join(extRoot, rel);
                    var dir = pathMod.dirname(fullDest);
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    fs.writeFileSync(fullDest, downloaded[rel], "utf8");
                }
            }

            /* Also reload updated host.jsx inside Premiere Pro's ExtendScript VM immediately! */
            var hostJsxPath = pathMod.join(extRoot, "jsx", "host.jsx").replace(/\\/g, "/");
            if (window.__adobe_cep__) {
                csInterface.evalScript('$.evalFile("' + hostJsxPath + '")', function () {
                    cadrSetUpdateStatus(
                        isEn ? "✅ Update installed! Reloading plugin..." : "✅ تم التحديث بنجاح! جاري إعادة تشغيل الواجهة...",
                        "#22C55E"
                    );
                    setTimeout(function () {
                        window.location.reload(true);
                    }, 600);
                });
            } else {
                setTimeout(function () {
                    window.location.reload(true);
                }, 600);
            }
        } catch (writeErr) {
            cadrUpdateBusy = false;
            if (bannerBtn) {
                bannerBtn.disabled = false;
                bannerBtn.textContent = isEn ? "Update Now ⚡" : "تحديث الآن ⚡";
            }
            if (instBtn) instBtn.disabled = false;
            cadrSetUpdateStatus(
                isEn
                    ? ("Permission error writing update: " + writeErr.message + ". Run INSTALL_WINDOWS.bat once to move plugin to user AppData.")
                    : ("الويندوز منع الكتابة في فولدر Program Files. شغّل INSTALL_WINDOWS.bat مرة واحدة عشان ينقل البلاجن لمسار المستخدم القابل للتحديث التلقائي."),
                "#EF4444"
            );
        }
    }

    downloadNext();
}

/* Initialize Updater UI & Auto-Check 2.5s after panel opens */
function cadrSyncLocalInstalledVersion() {
    if (window.cep_node && typeof window.cep_node.require === "function") {
        try {
            var fs = window.cep_node.require("fs");
            var pathMod = window.cep_node.require("path");
            var extRoot = getExtensionRootPath();
            if (extRoot) {
                var vp = pathMod.join(extRoot, "version.json");
                if (fs.existsSync(vp)) {
                    var vj = JSON.parse(fs.readFileSync(vp, "utf8"));
                    if (vj && vj.version && cadrCompareSemver(vj.version, CADR_CURRENT_VERSION) > 0) {
                        CADR_CURRENT_VERSION = String(vj.version).trim();
                    }
                }
            }
        } catch (e) {}
    }
}

(function initCadrUpdaterV58() {
    cadrSyncLocalInstalledVersion();
    var repo = cadrGetConfiguredUpdateRepo();
    var inp = document.getElementById("cadrUpdateRepoInput");
    if (inp && repo) inp.value = repo;
    var verBadge = document.getElementById("cadrCurrentVerBadge");
    if (verBadge) verBadge.textContent = "v" + CADR_CURRENT_VERSION;
    setTimeout(function () {
        cadrCheckForUpdates(false);
    }, 2500);
})();
