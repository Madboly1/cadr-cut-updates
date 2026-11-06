/* =========================================================
   ES3 EXTENDSCRIPT POLYFILLS (JSON.stringify / JSON.parse)
   Adobe Premiere Pro's ExtendScript engine is ES3 and does NOT
   provide a built-in global JSON object by default.
   ========================================================= */
if (typeof JSON === "undefined") {
    JSON = {};
}
(function () {
    function escStr(s) {
        var str = String(s);
        var out = '"';
        for (var i = 0; i < str.length; i++) {
            var c = str.charAt(i);
            var code = str.charCodeAt(i);
            if (c === '"') out += '\\"';
            else if (c === '\\') out += '\\\\';
            else if (c === '\b') out += '\\b';
            else if (c === '\f') out += '\\f';
            else if (c === '\n') out += '\\n';
            else if (c === '\r') out += '\\r';
            else if (c === '\t') out += '\\t';
            else if (code < 0x20) {
                var hex = code.toString(16);
                while (hex.length < 4) hex = "0" + hex;
                out += "\\u" + hex;
            } else {
                out += c;
            }
        }
        return out + '"';
    }

    if (typeof JSON.stringify !== "function") {
        JSON.stringify = function (val) {
            if (val === null || val === undefined) return "null";
            var t = typeof val;
            if (t === "number") return isFinite(val) ? String(val) : "null";
            if (t === "boolean") return val ? "true" : "false";
            if (t === "string") return escStr(val);
            if (t === "object") {
                if (val instanceof Array || Object.prototype.toString.call(val) === "[object Array]") {
                    var arrParts = [];
                    for (var i = 0; i < val.length; i++) {
                        var el = JSON.stringify(val[i]);
                        arrParts.push(el === undefined ? "null" : el);
                    }
                    return "[" + arrParts.join(",") + "]";
                }
                var objParts = [];
                for (var k in val) {
                    if (Object.prototype.hasOwnProperty.call(val, k)) {
                        var v = val[k];
                        if (v !== undefined && typeof v !== "function") {
                            objParts.push(escStr(k) + ":" + JSON.stringify(v));
                        }
                    }
                }
                return "{" + objParts.join(",") + "}";
            }
            return "null";
        };
    }

    if (typeof JSON.parse !== "function") {
        JSON.parse = function (text) {
            var s = String(text || "").replace(/^\s+|\s+$/g, "");
            if (!s) throw new Error("Empty JSON string");
            return eval("(" + s + ")");
        };
    }

    if (typeof Array.isArray !== "function") {
        Array.isArray = function (arg) {
            return Object.prototype.toString.call(arg) === "[object Array]";
        };
    }

    if (typeof String.prototype.trim !== "function") {
        String.prototype.trim = function () {
            return this.replace(/^\s+|\s+$/g, "");
        };
    }
})();

/* =========================================================
   CADR - HOST
   Auto Cut (Silence Removal)
   ========================================================= */


/* =========================================================
   SELECTED CLIPS (multi-clip aware) — v2.1 (nest + link aware)

   What changed vs. the old version:
     1) LINK GROUPS: a selected clip is grouped with everything it is
        really linked to in Premiere (clip.getLinkedItems()). One group
        = ONE analysis + ONE set of cuts, no matter how many tracks it
        spans.
     2) NESTED SEQUENCES: a nest has no media path, so it used to be
        skipped silently. Now we open the nested sequence and read the
        voice clip(s) inside it, mapped back to the outer timeline.
     3) CUT TARGET: if the group contains a video clip, the cut is sent
        to that video track, so video + its linked audio are cut
        together. If the group is audio-only, it is cut on that audio
        track as before.

   trackIndex convention used by main.js (unchanged):
     video track 0,1,2...  => 0,1,2...
     audio track 0,1,2...  => -1,-2,-3...
   ========================================================= */



function cadrSafeActiveSequence() {
    try {
        if (typeof app === "undefined" || !app || !app.project) return null;
        if (!app.project.sequences || app.project.sequences.numSequences <= 0) return null;
        return app.project.activeSequence || null;
    } catch (e) {
        return null;
    }
}

var cadrQeAlreadyEnabled = false;
function cadrEnsureQE() {
    if (!cadrQeAlreadyEnabled) {
        try {
            app.enableQE();
            cadrQeAlreadyEnabled = true;
        } catch (e) {}
    }
}

function cadrClipNodeId(clip) {
    try {
        return String(clip.nodeId);
    } catch (e) {
        return "";
    }
}

function cadrSameClip(a, b) {
    var ia = cadrClipNodeId(a);
    var ib = cadrClipNodeId(b);

    if (ia && ib && ia !== "undefined" && ib !== "undefined") {
        return ia === ib;
    }

    return (
        Math.abs(a.start.seconds - b.start.seconds) < 0.001 &&
        Math.abs(a.end.seconds - b.end.seconds) < 0.001 &&
        a.name === b.name
    );
}

/* Where does this clip live? -> {kind:"video"|"audio", track:n, clip:c} */
function cadrLocateClip(sequence, target) {

    for (var t = 0; t < sequence.videoTracks.numTracks; t++) {
        var vt = sequence.videoTracks[t];
        for (var c = 0; c < vt.clips.numItems; c++) {
            if (cadrSameClip(vt.clips[c], target)) {
                return { kind: "video", track: t, clip: vt.clips[c] };
            }
        }
    }

    for (var a = 0; a < sequence.audioTracks.numTracks; a++) {
        var at = sequence.audioTracks[a];
        for (var k = 0; k < at.clips.numItems; k++) {
            if (cadrSameClip(at.clips[k], target)) {
                return { kind: "audio", track: a, clip: at.clips[k] };
            }
        }
    }

    return null;
}

/* Real Premiere links (empty list if the API is not available). */
function cadrLinkedLocations(sequence, clip) {

    var result = [];
    var items = null;

    try {
        items = clip.getLinkedItems();
    } catch (e) {
        return result;
    }

    if (!items) {
        return result;
    }

    for (var i = 0; i < items.numItems; i++) {

        var loc = cadrLocateClip(sequence, items[i]);

        if (loc && !cadrSameClip(loc.clip, clip)) {
            result.push(loc);
        }
    }

    return result;
}

function cadrSourceKey(clip) {

    try {

        var pi = clip.projectItem;

        if (!pi) {
            return "";
        }

        var p = "";

        try {
            p = pi.getMediaPath();
        } catch (e0) {}

        if (p) {
            return "F:" + normalizePath(p);
        }

        return "S:" + String(pi.nodeId);

    } catch (e) {
        return "";
    }
}

function cadrIsNestedClip(clip) {
    try {
        var pi = clip.projectItem;
        return !!(pi && typeof pi.isSequence === "function" && pi.isSequence());
    } catch (e) {
        return false;
    }
}

function cadrFindSequenceOfProjectItem(pi) {

    var seqs = app.project.sequences;
    var id = "";

    try {
        id = String(pi.nodeId);
    } catch (e0) {}

    if (id) {
        for (var i = 0; i < seqs.numSequences; i++) {
            try {
                if (
                    seqs[i].projectItem &&
                    String(seqs[i].projectItem.nodeId) === id
                ) {
                    return seqs[i];
                }
            } catch (e1) {}
        }
    }

    /* Last resort: match by name. */
    for (var j = 0; j < seqs.numSequences; j++) {
        if (seqs[j].name === pi.name) {
            return seqs[j];
        }
    }

    return null;
}

/*
 * Turn ONE timeline clip into analysis entries (real media files that
 * ffmpeg can read), all expressed in OUTER timeline seconds.
 *
 *  - normal clip -> one entry
 *  - nested seq  -> the clips of the FIRST non-muted audio track inside
 *                   the nest that overlap the visible part of the nest
 *                   (usually A1 = the voice). Works recursively.
 *
 * Note: clip speed changes are not accounted for (same as before).
 */
function cadrResolveAnalysisSources(clip, depth) {

    var out = [];
    var clipStart = clip.start.seconds;
    var clipDur = clip.end.seconds - clipStart;

    if (clipDur <= 0) {
        return out;
    }

    var path = "";

    try {
        path = clip.projectItem ? clip.projectItem.getMediaPath() : "";
    } catch (e0) {}

    if (path) {
        out.push({
            path: path,
            sourceIn: clip.inPoint.seconds,
            duration: clipDur,
            timelineStart: clipStart,
            name: clip.name
        });
        return out;
    }

    if (depth > 3 || !cadrIsNestedClip(clip)) {
        return out;
    }

    var inner = cadrFindSequenceOfProjectItem(clip.projectItem);

    if (!inner) {
        return out;
    }

    /* The part of the inner sequence that is visible in the outer clip. */
    var winStart = clip.inPoint.seconds;
    var winEnd = winStart + clipDur;

    for (var a = 0; a < inner.audioTracks.numTracks; a++) {

        var track = inner.audioTracks[a];
        var muted = false;

        try {
            muted = track.isMuted();
        } catch (eM) {}

        if (muted) {
            continue;
        }

        var gotAny = false;

        for (var c = 0; c < track.clips.numItems; c++) {

            var ic = track.clips[c];
            var disabled = false;

            try {
                disabled = ic.disabled;
            } catch (eD) {}

            if (disabled) {
                continue;
            }

            if (
                Math.min(ic.end.seconds, winEnd) -
                Math.max(ic.start.seconds, winStart) <= 0.01
            ) {
                continue;
            }

            var sub = cadrResolveAnalysisSources(ic, depth + 1);

            for (var s = 0; s < sub.length; s++) {

                var e = sub[s];
                var from = Math.max(e.timelineStart, winStart);
                var to = Math.min(e.timelineStart + e.duration, winEnd);

                if (to - from <= 0.01) {
                    continue;
                }

                out.push({
                    path: e.path,
                    sourceIn: e.sourceIn + (from - e.timelineStart),
                    duration: to - from,
                    timelineStart: clipStart + (from - winStart),
                    name: clip.name + " > " + e.name
                });

                gotAny = true;
            }
        }

        /* Use the first audio track that actually has speech sources. */
        if (gotAny) {
            break;
        }
    }

    return out;
}

function getSelectedClipsAnalysisData() {

    try {

        var sequence = cadrSafeActiveSequence();

        if (!sequence) {
            return "NO_SEQUENCE";
        }

        /* ---- 1) collect selected clips (video first, then audio) ---- */

        var selected = [];

        for (var t = 0; t < sequence.videoTracks.numTracks; t++) {
            var vTrack = sequence.videoTracks[t];
            for (var c = 0; c < vTrack.clips.numItems; c++) {
                var vClip = vTrack.clips[c];
                if (vClip.isSelected()) {
                    selected.push({ kind: "video", track: t, clip: vClip });
                }
            }
        }

        for (var a = 0; a < sequence.audioTracks.numTracks; a++) {
            var aTrack = sequence.audioTracks[a];
            for (var ac = 0; ac < aTrack.clips.numItems; ac++) {
                var aClip = aTrack.clips[ac];
                if (aClip.isSelected()) {
                    selected.push({ kind: "audio", track: a, clip: aClip });
                }
            }
        }

        if (selected.length === 0) {
            return "NO_CLIP_SELECTED";
        }

        /* ---- 2) build link groups ---- */

        var consumed = [];   /* locations already part of a group */
        var groups = [];

        var isConsumed = function (loc) {
            for (var i = 0; i < consumed.length; i++) {
                if (cadrSameClip(consumed[i].clip, loc.clip)) {
                    return true;
                }
            }
            return false;
        };

        var sameFootage = function (x, y) {
            /* Fallback when getLinkedItems is unavailable: same source,
               same position, same length = the video clip's own audio. */
            return (
                cadrSourceKey(x) !== "" &&
                cadrSourceKey(x) === cadrSourceKey(y) &&
                Math.abs(x.start.seconds - y.start.seconds) <= 0.05 &&
                Math.abs((x.end.seconds - x.start.seconds) -
                         (y.end.seconds - y.start.seconds)) <= 0.05 &&
                Math.abs(x.inPoint.seconds - y.inPoint.seconds) <= 0.05
            );
        };

        for (var i = 0; i < selected.length; i++) {

            var loc = selected[i];

            if (isConsumed(loc)) {
                continue;
            }

            var members = [loc].concat(cadrLinkedLocations(sequence, loc.clip));

            /* Heuristic fallback for an audio clip whose video is selected. */
            if (loc.kind === "audio" && members.length === 1) {
                var twin = null;
                for (var j = 0; j < selected.length; j++) {
                    if (
                        selected[j].kind === "video" &&
                        sameFootage(selected[j].clip, loc.clip)
                    ) {
                        twin = selected[j];
                        break;
                    }
                }
                if (twin) {
                    /* already represented by the video's group */
                    consumed.push(loc);
                    continue;
                }
            }

            for (var m = 0; m < members.length; m++) {
                consumed.push(members[m]);
            }

            groups.push(members);
        }

        /* ---- 3) one analysis source + one cut target per group ---- */

        var clips = [];
        var unresolved = [];

        for (var g = 0; g < groups.length; g++) {

            var group = groups[g];

            /* Cut target: the lowest video track in the group, else audio. */
            var target = null;

            for (var gm = 0; gm < group.length; gm++) {
                if (
                    group[gm].kind === "video" &&
                    (target === null || group[gm].track < target.track)
                ) {
                    target = group[gm];
                }
            }

            if (target === null) {
                target = group[0];
            }

            var encodedTrack =
                target.kind === "video" ? target.track : -(target.track + 1);

            /* Analysis source: prefer an audio member (that is what we
               are listening for), then the video member. */
            var order = [];

            for (var o1 = 0; o1 < group.length; o1++) {
                if (group[o1].kind === "audio") { order.push(group[o1]); }
            }
            for (var o2 = 0; o2 < group.length; o2++) {
                if (group[o2].kind === "video") { order.push(group[o2]); }
            }

            var entries = [];

            for (var oi = 0; oi < order.length && entries.length === 0; oi++) {
                entries = cadrResolveAnalysisSources(order[oi].clip, 0);
            }

            if (entries.length === 0) {
                unresolved.push(group[0].clip.name);
                continue;
            }

            for (var en = 0; en < entries.length; en++) {
                clips.push({
                    path: entries[en].path,
                    sourceIn: entries[en].sourceIn,
                    duration: entries[en].duration,
                    timelineStart: entries[en].timelineStart,
                    trackIndex: encodedTrack,
                    name: entries[en].name,
                    mediaType: target.kind
                });
            }
        }

        if (clips.length === 0) {
            return (
                "NO_SOURCE: مش لاقي ملف صوت أحلله للكليبات المحددة (" +
                unresolved.join(", ") +
                "). لو ده Nest تأكد إن جواه كليب صوت مش Muted."
            );
        }

        clips.sort(function (x, y) {
            return x.timelineStart - y.timelineStart;
        });

        return JSON.stringify(clips);

    } catch (e) {
        return "HOST_ERROR:" + e.toString();
    }
}


/* =========================================================
   DEBUG / INFO
   ========================================================= */

function getSelectionSummary() {
    try {
        var sequence = cadrSafeActiveSequence();
        if (!sequence) {
            return "مفيش Sequence مفتوح";
        }

/* Safe track scan for Premiere Pro 2020-2027+ stability */

        /* Lightweight fallback without traversing project bins or media paths */
        var count = 0;
        for (var t = 0; t < sequence.videoTracks.numTracks; t++) {
            var vt = sequence.videoTracks[t];
            for (var c = 0; c < vt.clips.numItems; c++) {
                if (vt.clips[c].isSelected()) count++;
            }
        }
        if (count === 0) {
            for (var a = 0; a < sequence.audioTracks.numTracks; a++) {
                var at = sequence.audioTracks[a];
                for (var ac = 0; ac < at.clips.numItems; ac++) {
                    if (at.clips[ac].isSelected()) count++;
                }
            }
        }
        if (count === 0) {
            return "مفيش كليب متحدد";
        }
        return "متحدد: " + count + " كليب";
    } catch (e) {
        return "مفيش كليب متحدد";
    }
}


/* =========================================================
   PLAYHEAD
   ========================================================= */

function movePlayhead(seconds) {

    var sequence = cadrSafeActiveSequence();

    if (!sequence) {
        throw new Error("مفيش Sequence مفتوح");
    }

    var time = new Time();

    time.seconds = seconds;

    sequence.setPlayerPosition(time.ticks);
}


/* =========================================================
   RAZOR (via QE)

   Auto Cut can now work with:
     - Video clips
     - Audio-only / Voice Over clips

   QE exposes separate video/audio tracks, so we use the
   corresponding track based on the encoded track index.
   ========================================================= */

function razorVideoAtPlayhead(trackIndex, qeSequence) {

    var qeTrack = qeSequence.getVideoTrackAt(trackIndex);

    if (!qeTrack) {
        throw new Error("Video Track مش موجود: " + trackIndex);
    }

    if (typeof qeTrack.razor !== "function") {
        throw new Error("Razor الفيديو غير متاح");
    }

    var timecode = qeSequence.CTI.timecode;

    if (!timecode) {
        throw new Error("مش قادر أجيب Timecode");
    }

    qeTrack.razor(timecode, true, true);

    return timecode;
}


function razorAudioAtPlayhead(audioTrackIndex, qeSequence) {

    if (typeof qeSequence.getAudioTrackAt !== "function") {
        throw new Error("Audio Track API غير متاح في نسخة Premiere الحالية");
    }

    var qeTrack = qeSequence.getAudioTrackAt(audioTrackIndex);

    if (!qeTrack) {
        throw new Error("Audio Track مش موجود: " + audioTrackIndex);
    }

    if (typeof qeTrack.razor !== "function") {
        throw new Error("Razor الصوت غير متاح");
    }

    var timecode = qeSequence.CTI.timecode;

    if (!timecode) {
        throw new Error("مش قادر أجيب Timecode");
    }

    qeTrack.razor(timecode, true, true);

    return timecode;
}


/* =========================================================
   FIND CLIP IN A TIME RANGE
   ========================================================= */

function findVideoClipInRange(track, startSeconds, endSeconds) {

    var tolerance = 0.18;

    for (var i = 0; i < track.clips.numItems; i++) {

        var clip = track.clips[i];

        var clipStart = clip.start.seconds;
        var clipEnd = clip.end.seconds;

        if (
            Math.abs(clipStart - startSeconds) <= tolerance &&
            Math.abs(clipEnd - endSeconds) <= tolerance
        ) {
            return clip;
        }
    }

    var bestClip = null;
    var bestOverlap = 0;

    for (var j = 0; j < track.clips.numItems; j++) {

        var candidate = track.clips[j];

        var overlapStart = Math.max(candidate.start.seconds, startSeconds);
        var overlapEnd = Math.min(candidate.end.seconds, endSeconds);
        var overlap = overlapEnd - overlapStart;

        if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestClip = candidate;
        }
    }

    return bestClip;
}


function findAudioClipInSpecificTrack(sequence, audioTrackIndex, startSeconds, endSeconds) {

    var tolerance = 0.18;

    if (audioTrackIndex < 0 || audioTrackIndex >= sequence.audioTracks.numTracks) {
        return null;
    }

    var track = sequence.audioTracks[audioTrackIndex];

    /* First try exact range. */
    for (var i = 0; i < track.clips.numItems; i++) {

        var clip = track.clips[i];

        var clipStart = clip.start.seconds;
        var clipEnd = clip.end.seconds;

        if (
            Math.abs(clipStart - startSeconds) <= tolerance &&
            Math.abs(clipEnd - endSeconds) <= tolerance
        ) {
            return clip;
        }
    }

    /* Then use the clip with the largest overlap. */
    var bestClip = null;
    var bestOverlap = 0;

    for (var j = 0; j < track.clips.numItems; j++) {

        var candidate = track.clips[j];

        var overlapStart = Math.max(candidate.start.seconds, startSeconds);
        var overlapEnd = Math.min(candidate.end.seconds, endSeconds);
        var overlap = overlapEnd - overlapStart;

        if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestClip = candidate;
        }
    }

    return bestClip;
}


function findAudioClipInRange(sequence, startSeconds, endSeconds) {

    var tolerance = 0.18;

    for (var a = 0; a < sequence.audioTracks.numTracks; a++) {

        var track = sequence.audioTracks[a];

        for (var i = 0; i < track.clips.numItems; i++) {

            var clip = track.clips[i];

            var clipStart = clip.start.seconds;
            var clipEnd = clip.end.seconds;

            if (
                Math.abs(clipStart - startSeconds) <= tolerance &&
                Math.abs(clipEnd - endSeconds) <= tolerance
            ) {
                return clip;
            }
        }
    }

    var bestClip = null;
    var bestOverlap = 0;

    for (var b = 0; b < sequence.audioTracks.numTracks; b++) {

        var audioTrack = sequence.audioTracks[b];

        for (var k = 0; k < audioTrack.clips.numItems; k++) {

            var candidate = audioTrack.clips[k];

            var overlapStart = Math.max(candidate.start.seconds, startSeconds);
            var overlapEnd = Math.min(candidate.end.seconds, endSeconds);
            var overlap = overlapEnd - overlapStart;

            if (overlap > bestOverlap) {
                bestOverlap = overlap;
                bestClip = candidate;
            }
        }
    }

    return bestClip;
}


/* =========================================================
   AUTO CUT - MULTI CLIP

   dataString format (one entry per silence region, across
   ALL selected clips):

       trackIndex|absoluteStart|absoluteEnd;trackIndex|start|end;...

   Times are already absolute timeline seconds (the panel
   side converts each clip's relative silence times using
   that clip's own timelineStart before sending them here).

   We always process cuts from RIGHT to LEFT (latest start
   time first). That way, ripple-deleting a cut never shifts
   the timeline position of a cut we haven't processed yet.
   ========================================================= */

function performSingleCut(dataString) {
    return performSingleCutInternal(dataString);
}


/* =========================================================
   ONE CUT PER CALL (on purpose)

   الـ panel بيبعت قصة واحدة في كل نداء ويستنى شوية قبل اللي
   بعدها. لو نفذنا كل القصات جوه نداء واحد (loop جوه
   ExtendScript) بريمير بيفريز عشان QE API بيتنادى مرات كتير
   ورا بعض. فمفيش performMultipleCuts هنا.
   ========================================================= */

/*
 * After deleting [start, end] on an audio track:
 *   "CLOSED" - a clip now starts at `start` (the gap closed)
 *   "GAP"    - the next clip still starts at `end` (gap left open)
 *   "NONE"   - nothing after the cut on this track, so no gap to close
 */
function cadrAudioGapState(sequence, audioTrackIndex, start, end) {

    var track = sequence.audioTracks[audioTrackIndex];

    if (!track) {
        return "NONE";
    }

    var tol = cadrFrameSeconds(sequence) * 0.75;
    var atStart = false;
    var atEnd = false;

    for (var i = 0; i < track.clips.numItems; i++) {

        var clipStart = track.clips[i].start.seconds;

        if (Math.abs(clipStart - start) <= tol) {
            atStart = true;
        }

        if (Math.abs(clipStart - end) <= tol) {
            atEnd = true;
        }
    }

    if (atStart) {
        return "CLOSED";
    }

    return atEnd ? "GAP" : "NONE";
}


/* Delete the empty space that starts at `start` on a QE track. */
function cadrQeRippleDeleteGap(qeTrack, start) {

    var count = cadrQeNumItems(qeTrack);
    var tol = 0.05;

    for (var i = 0; i < count; i++) {

        var item = qeTrack.getItemAt(i);

        if (!item) {
            continue;
        }

        var itemType = "";

        try {
            itemType = String(item.type).toLowerCase();
        } catch (e1) {}

        if (itemType.indexOf("empty") === -1) {
            continue;
        }

        var itemStart = cadrQeItemStart(item);

        if (itemStart === null || Math.abs(itemStart - start) > tol) {
            continue;
        }

        try {
            item.remove(true, true);
            return true;
        } catch (e2) {}

        try {
            item.remove(true, false);
            return true;
        } catch (e3) {}

        return false;
    }

    return false;
}


function performSingleCutInternal(dataString) {

    try {

        var sequence = cadrSafeActiveSequence();

        if (!sequence) {
            return "NO_SEQUENCE";
        }

        var parts = dataString.split("|");

        if (parts.length !== 3) {
            return "BAD_DATA";
        }

        var encodedTrackIndex = parseInt(parts[0], 10);
        var start = parseFloat(parts[1]);
        var end = parseFloat(parts[2]);

        if (
            isNaN(encodedTrackIndex) ||
            isNaN(start) ||
            isNaN(end) ||
            end <= start
        ) {
            return "BAD_DATA";
        }

        /*
         * Positive / zero index = Video Track.
         * Negative index = Audio Track:
         *   -1 => A1
         *   -2 => A2
         *   -3 => A3
         */
        var isAudioCut = encodedTrackIndex < 0;
        var videoTrackIndex = encodedTrackIndex;
        var audioTrackIndex = -encodedTrackIndex - 1;

        cadrEnsureQE();

        var qeSequence = qe.project.getActiveSequence();

        if (!qeSequence) {
            return "QE_FAIL";
        }

        /* Razor at start. */
        movePlayhead(start);

        if (isAudioCut) {
            razorAudioAtPlayhead(audioTrackIndex, qeSequence);
        } else {
            razorVideoAtPlayhead(videoTrackIndex, qeSequence);
        }

        /* Razor at end. */
        movePlayhead(end);

        if (isAudioCut) {
            razorAudioAtPlayhead(audioTrackIndex, qeSequence);
        } else {
            razorVideoAtPlayhead(videoTrackIndex, qeSequence);
        }

        if (isAudioCut) {

            var audioTrack = sequence.audioTracks[audioTrackIndex];

            if (!audioTrack) {
                return "OK_NO_MATCH";
            }

            var middleAudioOnly = findAudioClipInSpecificTrack(
                sequence,
                audioTrackIndex,
                start,
                end
            );

            if (!middleAudioOnly) {
                return "OK_NO_MATCH";
            }

            /*
             * Audio-only clip (e.g. a voice-over). Same ripple delete the
             * video path uses (remove(true, true)); the narrower
             * remove(true, false) left the gap open in Premiere.
             */
            var removedStart = middleAudioOnly.start.seconds;
            var removedEnd = middleAudioOnly.end.seconds;

            middleAudioOnly.remove(true, true);

            var gapState = cadrAudioGapState(
                sequence,
                audioTrackIndex,
                removedStart,
                removedEnd
            );

            /* Ripple did not close the gap: try to delete the empty gap
               itself through QE, then check again. */
            if (gapState === "GAP") {

                try {
                    cadrQeRippleDeleteGap(
                        qeSequence.getAudioTrackAt(audioTrackIndex),
                        removedStart
                    );
                } catch (gapError) {}

                gapState = cadrAudioGapState(
                    sequence,
                    audioTrackIndex,
                    removedStart,
                    removedEnd
                );
            }

            return gapState === "GAP" ? "OK_GAP_REMAINS" : "OK";
        }

        /* -----------------------------
           Existing video behavior
           ----------------------------- */

        var videoTrack = sequence.videoTracks[videoTrackIndex];

        if (!videoTrack) {
            return "OK_NO_MATCH";
        }

        var middleVideo = findVideoClipInRange(
            videoTrack,
            start,
            end
        );

        if (!middleVideo) {
            return "OK_NO_MATCH";
        }

        var actualStart = middleVideo.start.seconds;
        var actualEnd = middleVideo.end.seconds;

        /*
         * Remove the audio that is REALLY linked to this video piece
         * (works for nests too). Only if Premiere reports no link do we
         * fall back to the old "any audio in this time range" guess.
         */
        var linkedAudio = [];
        var linkedLocs = cadrLinkedLocations(sequence, middleVideo);

        for (var li = 0; li < linkedLocs.length; li++) {
            if (linkedLocs[li].kind === "audio") {
                linkedAudio.push(linkedLocs[li].clip);
            }
        }

        if (linkedAudio.length === 0) {
            var guessAudio = findAudioClipInRange(
                sequence,
                actualStart,
                actualEnd
            );

            if (guessAudio) {
                linkedAudio.push(guessAudio);
            }
        }

        for (var la = 0; la < linkedAudio.length; la++) {
            linkedAudio[la].remove(false, true);
        }

        middleVideo.remove(true, true);

        return "OK";

    } catch (e) {
        return "HOST_ERROR:" + e.toString();
    }
}


/* =========================================================
   SILENCE PREVIEW — MARKERS

   بياخد نفس فورمات القصات (trackIndex|start|end;...) بس بدل
   ما يقص، بيحط Marker أحمر على السيكوينس مكان كل منطقة
   سكوت، عشان تشوفها بعينك على التايم لاين وتتأكد قبل ما
   تنفذ AUTO CUT فعليًا. بيمسح أي ماركرز "CADR Silence"
   قديمة قبل ما يحط الجداد، عشان ما تتكرمش.
   ========================================================= */

function clearSilenceMarkers() {

    var sequence = cadrSafeActiveSequence();

    if (!sequence) {
        return;
    }

    var markers = sequence.markers;
    var toDelete = [];
    var m = markers.getFirstMarker();

    while (m) {
        if (m.name === "CADR Silence") {
            toDelete.push(m);
        }
        m = markers.getNextMarker(m);
    }

    for (var i = 0; i < toDelete.length; i++) {
        markers.deleteMarker(toDelete[i]);
    }
}


/*
 * Silence preview markers are placed ONE PER CALL by the panel
 * (createSilenceMarker), the same way cuts are sent, and the panel then asks
 * for the real count (cadrCountSilenceMarkers) so a missing marker is
 * reported instead of silently ignored.
 */
function cadrCountSilenceMarkersIn(sequence) {

    var count = 0;
    var m = sequence.markers.getFirstMarker();

    while (m) {

        if (m.name === "CADR Silence") {
            count++;
        }

        m = sequence.markers.getNextMarker(m);
    }

    return count;
}


function cadrCountSilenceMarkers() {

    try {

        var sequence = cadrSafeActiveSequence();

        return sequence ? String(cadrCountSilenceMarkersIn(sequence)) : "0";

    } catch (e) {
        return "HOST_ERROR:" + e.toString();
    }
}


function cadrClearSilenceMarkers() {

    try {

        var sequence = cadrSafeActiveSequence();

        if (!sequence) {
            return "0";
        }

        var before = cadrCountSilenceMarkersIn(sequence);

        /* deleting while walking the list can skip items, so repeat */
        for (var pass = 0; pass < 6; pass++) {

            if (cadrCountSilenceMarkersIn(sequence) === 0) {
                break;
            }

            clearSilenceMarkers();
        }

        return String(before - cadrCountSilenceMarkersIn(sequence));

    } catch (e) {
        return "HOST_ERROR:" + e.toString();
    }
}


/* dataString: "trackIndex|start|end" (same format as a cut). */
function createSilenceMarker(dataString) {

    try {

        var sequence = cadrSafeActiveSequence();

        if (!sequence) {
            return "NO_SEQUENCE";
        }

        var parts = String(dataString).split("|");

        var start = parseFloat(parts[parts.length - 2]);
        var end = parseFloat(parts[parts.length - 1]);

        if (isNaN(start) || isNaN(end) || end <= start) {
            return "ERR:bad range " + dataString;
        }

        var marker = sequence.markers.createMarker(start);

        if (!marker) {
            return "ERR:createMarker returned nothing";
        }

        var notes = [];

        try {
            marker.name = "CADR Silence";
        } catch (e1) {
            notes.push("name:" + e1.toString());
        }

        try {
            marker.comments =
                "سكوت: " + start.toFixed(2) + "s → " + end.toFixed(2) + "s";
        } catch (e2) {
            notes.push("comments:" + e2.toString());
        }

        try {
            var endTime = new Time();
            endTime.seconds = end;
            marker.end = endTime;
        } catch (e3) {
            notes.push("end:" + e3.toString());
        }

        try {
            marker.setColorByIndex(0);
        } catch (e4) {
            /* some versions do not support colours */
        }

        return notes.length ? "OK_WITH_NOTES:" + notes.join(",") : "OK";

    } catch (e) {
        return "ERR:" + e.toString();
    }
}


/* =========================================================
   CADR - HOST
   Auto Caption (Import SRT as Caption Track)
   ========================================================= */


function normalizePath(path) {

    if (!path) {
        return "";
    }

    return String(path).replace(/\\/g, "/").toLowerCase();
}


function findProjectItemByMediaPath(item, targetPath) {

    if (!item) {
        return null;
    }

    try {

        var currentPath = item.getMediaPath();

        if (currentPath && normalizePath(currentPath) === normalizePath(targetPath)) {
            return item;
        }

    } catch (e) {
        // بعض أنواع ProjectItem ممكن ما يكونش عندها Media Path
    }

    try {

        if (item.children && item.children.numItems > 0) {

            for (var i = 0; i < item.children.numItems; i++) {

                var found = findProjectItemByMediaPath(item.children[i], targetPath);

                if (found) {
                    return found;
                }
            }
        }

    } catch (e2) {
        // تجاهل أي عنصر مش قابل للـ recursion
    }

    return null;
}


function findProjectItemByName(item, targetName) {

    if (!item) {
        return null;
    }

    try {

        if (item.name && String(item.name).toLowerCase() === String(targetName).toLowerCase()) {
            return item;
        }

    } catch (e) {
        // تجاهل
    }

    try {

        if (item.children && item.children.numItems > 0) {

            for (var i = 0; i < item.children.numItems; i++) {

                var found = findProjectItemByName(item.children[i], targetName);

                if (found) {
                    return found;
                }
            }
        }

    } catch (e2) {
        // تجاهل
    }

    return null;
}


/* =========================================================
   استيراد ملف SRT وعمل Caption Track منه في السيكوينس
   ========================================================= */

function importSRTFile(srtPath) {

    try {

        if (!srtPath) {
            return "NO_SRT_PATH";
        }

        var srtFile = new File(srtPath);

        if (!srtFile.exists) {
            return "SRT_NOT_FOUND:\n" + srtPath;
        }

        var sequence = cadrSafeActiveSequence();

        if (!sequence) {
            return "NO_ACTIVE_SEQUENCE";
        }

        var imported = app.project.importFiles(
            [srtFile.fsName],
            true,
            app.project.rootItem,
            false
        );

        if (!imported) {
            return "IMPORT_FAILED";
        }

        var importedItem = findProjectItemByMediaPath(app.project.rootItem, srtFile.fsName);

        if (!importedItem) {
            importedItem = findProjectItemByName(app.project.rootItem, srtFile.name);
        }

        if (!importedItem) {
            return "SRT_IMPORTED_BUT_ITEM_NOT_FOUND";
        }

        if (typeof sequence.createCaptionTrack !== "function") {
            return "CREATE_CAPTION_TRACK_UNAVAILABLE";
        }

        // بريمير مش بيدّينا API نظيف نشوف بيه لو فيه Caption Track
        // موجود بالفعل من مرة قبل كده، فبنحاول ننشئ واحد جديد؛ لو
        // فشل (سواء رجع false أو رمى استثناء) الأغلب إن السبب هو
        // وجود Caption Track قديم بيتعارض مع الجديد
        var created;

        try {
            created = sequence.createCaptionTrack(
                importedItem,
                0,
                Sequence.CAPTION_FORMAT_SUBTITLE
            );
        } catch (createError) {
            return "CREATE_CAPTION_TRACK_CONFLICT:" + createError.toString();
        }

        if (created === false) {
            return "CREATE_CAPTION_TRACK_CONFLICT:";
        }

        return "CAPTION_TRACK_CREATED";

    } catch (e) {
        return "HOST_ERROR:" + e.toString();
    }
}


/* =========================================================
   BACKUP & UNDO (sequence level)

   Premiere's Ctrl+Z reverts ONE razor/delete at a time, so a
   cut with 200 silences would need 200 undos. Instead, before
   every cut we clone the sequence. "Undo" swaps the clone back
   in. Nothing is ever deleted: the cut version stays in the
   project, renamed "<name> (CUT)".
   ========================================================= */

function cadrPad2(n) {
    return (n < 10 ? "0" : "") + n;
}


function cadrFindSequenceById(id) {

    var seqs = app.project.sequences;

    for (var i = 0; i < seqs.numSequences; i++) {

        if (String(seqs[i].sequenceID) === String(id)) {
            return seqs[i];
        }
    }

    return null;
}


function cadrGetBackupBin() {

    var root = app.project.rootItem;

    for (var i = 0; i < root.children.numItems; i++) {

        var child = root.children[i];

        if (
            child &&
            child.type === ProjectItemType.BIN &&
            child.name === "CADR Backups"
        ) {
            return child;
        }
    }

    return root.createBin("CADR Backups");
}


function cadrActiveSequenceId() {

    try {

        var seq = cadrSafeActiveSequence();

        return seq ? String(seq.sequenceID) : "";

    } catch (e) {
        return "";
    }
}


function cadrActivateSequence(sequenceId) {

    try {

        app.project.openSequence(sequenceId);

        return "OK";

    } catch (e) {
        return "HOST_ERROR:" + e.toString();
    }
}


function cadrCreateBackup() {

    try {

        var seq = cadrSafeActiveSequence();

        if (!seq) {
            return "NO_SEQUENCE";
        }

        if (typeof seq.clone !== "function") {
            return "CLONE_UNAVAILABLE";
        }

        var originalId = String(seq.sequenceID);
        var originalName = String(seq.name);

        var before = {};

        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            before[String(app.project.sequences[i].sequenceID)] = true;
        }

        /* clone() may return the new sequence or just true, so we
           don't trust its return value: we look for the new ID. */
        seq.clone();

        var backup = null;

        for (var j = 0; j < app.project.sequences.numSequences; j++) {

            var candidate = app.project.sequences[j];

            if (!before[String(candidate.sequenceID)]) {
                backup = candidate;
                break;
            }
        }

        if (!backup) {
            return "BACKUP_NOT_FOUND";
        }

        var backupId = String(backup.sequenceID);

        var now = new Date();

        try {
            backup.name =
                "CADR Backup - " + originalName + " - " +
                cadrPad2(now.getHours()) + "." + cadrPad2(now.getMinutes());
        } catch (renameError) {
            /* name stays "<name> Copy" — still fine */
        }

/* Keep backup sequence in root to prevent Premiere Pro 2026 bin-move crash during clone */

        /* clone() can leave the copy as the active sequence. */
        app.project.openSequence(originalId);

        return JSON.stringify({
            originalId: originalId,
            originalName: originalName,
            backupId: backupId
        });

    } catch (e) {
        return "HOST_ERROR:" + e.toString();
    }
}


function cadrBackupExists(backupId) {

    try {
        return cadrFindSequenceById(backupId) ? "1" : "0";
    } catch (e) {
        return "0";
    }
}


function cadrRestoreBackup(originalId, backupId, originalName) {

    try {

        var backup = cadrFindSequenceById(backupId);

        if (!backup) {
            return "BACKUP_MISSING";
        }

        var current = cadrFindSequenceById(originalId);

        /* Rename the cut version first so two sequences never
           share the same name. */
        if (current) {
            try {
                current.name = originalName + " (CUT)";
            } catch (e1) {}
        }

        try {
            backup.name = originalName;
        } catch (e2) {}

        try {
            backup.projectItem.moveBin(app.project.rootItem);
        } catch (e3) {}

        app.project.openSequence(backupId);

        return "RESTORED";

    } catch (e) {
        return "HOST_ERROR:" + e.toString();
    }
}


/* =========================================================
   GO TO TIME (used by the ▶ button in the filler-word list)
   ========================================================= */

function cadrGoTo(seconds) {

    try {

        movePlayhead(seconds);

        return "OK";

    } catch (e) {
        return "HOST_ERROR:" + e.toString();
    }
}


/* =========================================================
   SMOOTH CUTS (Cross Dissolve / Constant Power)

   Step 1: cadrListCutJunctions() finds the places where a silence
           was cut: two clips of the SAME file, back to back on the
           timeline, with a jump in the source between them.
   Step 2: cadrAddSmoothAt() adds the transitions at one junction.
           The panel calls it once per junction (same one-call-at-a-
           time pattern as the cuts, to keep Premiere responsive).

   A transition does not change the timeline length (it uses the
   spare media on both sides of the cut), so junction times found
   in step 1 stay valid while step 2 runs.
   ========================================================= */

var CADR_TICKS_PER_SECOND = 254016000000;


function cadrFrameSeconds(seq) {

    var ticks = Number(seq.timebase);

    if (!ticks || isNaN(ticks)) {
        return 1 / 25;
    }

    return ticks / CADR_TICKS_PER_SECOND;
}


function cadrCollectTrackClips(track) {

    var list = [];

    for (var i = 0; i < track.clips.numItems; i++) {

        var c = track.clips[i];

        var mediaPath = "";

        try {
            mediaPath = c.projectItem ? c.projectItem.getMediaPath() : "";
        } catch (e) {}

        list.push({
            start: c.start.seconds,
            end: c.end.seconds,
            inPoint: c.inPoint.seconds,
            outPoint: c.outPoint.seconds,
            path: mediaPath ? normalizePath(mediaPath) : ""
        });
    }

    list.sort(function (x, y) {
        return x.start - y.start;
    });

    return list;
}


function cadrListCutJunctions(winStart, winEnd, frames) {

    try {

        var seq = cadrSafeActiveSequence();

        if (!seq) {
            return "NO_SEQUENCE";
        }

        var frameSec = cadrFrameSeconds(seq);
        var tol = frameSec * 0.75;
        var minGap = (Number(frames) * frameSec) / 2;

        var times = [];

        /* function expressions (not declarations) on purpose:
           ExtendScript is ES3, which does not allow function
           declarations inside a try block. */
        var addTime = function (t) {

            for (var k = 0; k < times.length; k++) {
                if (Math.abs(times[k] - t) <= tol) {
                    return;
                }
            }

            times.push(t);
        };

        var scan = function (tracks) {

            for (var t = 0; t < tracks.numTracks; t++) {

                var clips = cadrCollectTrackClips(tracks[t]);

                for (var i = 0; i + 1 < clips.length; i++) {

                    var a = clips[i];
                    var b = clips[i + 1];

                    if (!a.path || a.path !== b.path) {
                        continue;
                    }

                    if (Math.abs(a.end - b.start) > tol) {
                        continue;
                    }

                    /* jump in the source = something was cut out here */
                    if (b.inPoint - a.outPoint < minGap) {
                        continue;
                    }

                    if (b.start < winStart || b.start > winEnd) {
                        continue;
                    }

                    addTime(b.start);
                }
            }
        };

        scan(seq.videoTracks);
        scan(seq.audioTracks);

        times.sort(function (x, y) {
            return x - y;
        });

        return JSON.stringify(times);

    } catch (e) {
        return "HOST_ERROR:" + e.toString();
    }
}


function cadrQeNumItems(qeTrack) {

    return (typeof qeTrack.numItems === "function")
        ? qeTrack.numItems()
        : qeTrack.numItems;
}


function cadrQeItemStart(item) {

    try {
        if (item.start && typeof item.start.secs !== "undefined") {
            return Number(item.start.secs);
        }
    } catch (e1) {}

    try {
        if (item.start && typeof item.start.ticks !== "undefined") {
            return Number(item.start.ticks) / CADR_TICKS_PER_SECOND;
        }
    } catch (e2) {}

    return null;
}


function cadrQeIsTransition(item) {

    try {
        return String(item.type).toLowerCase().indexOf("transition") !== -1;
    } catch (e) {
        return false;
    }
}


/* Adds one transition at time t on one QE track.
   Returns "ADDED", "EXISTS", or an error text. */
function cadrQeAddAt(qeTrack, t, tol, transition, duration) {

    var count = cadrQeNumItems(qeTrack);
    var index = -1;

    for (var i = 0; i < count; i++) {

        var item = qeTrack.getItemAt(i);

        if (!item || cadrQeIsTransition(item)) {
            continue;
        }

        var start = cadrQeItemStart(item);

        if (start !== null && Math.abs(start - t) <= tol) {
            index = i;
            break;
        }
    }

    if (index < 0) {
        return "QE_ITEM_NOT_FOUND";
    }

    /* a transition already sits right before this clip */
    if (index > 0 && cadrQeIsTransition(qeTrack.getItemAt(index - 1))) {
        return "EXISTS";
    }

    var before = cadrQeNumItems(qeTrack);
    var lastError = "";

    try {
        qeTrack.getItemAt(index).addTransition(transition, true, duration);
    } catch (e1) {
        lastError = e1.toString();
    }

    if (cadrQeNumItems(qeTrack) > before) {
        return "ADDED";
    }

    /* second try: end of the clip before the cut */
    if (index > 0) {

        try {
            qeTrack.getItemAt(index - 1).addTransition(transition, false, duration);
        } catch (e2) {
            lastError = e2.toString();
        }

        if (cadrQeNumItems(qeTrack) > before) {
            return "ADDED";
        }
    }

    return "NOT_ADDED" + (lastError ? ":" + lastError : "");
}


function cadrHasJunctionAt(track, t, tol) {

    var clips = cadrCollectTrackClips(track);

    for (var i = 0; i + 1 < clips.length; i++) {

        if (
            Math.abs(clips[i + 1].start - t) <= tol &&
            Math.abs(clips[i].end - t) <= tol
        ) {
            return true;
        }
    }

    return false;
}


/* doVideo / doAudio are "1" or "0".
   Returns "OK;V=<added>;A=<added>" or "ERR;...". */
function cadrAddSmoothAt(seconds, frames, doVideo, doAudio) {

    try {

        cadrEnsureQE();

        var qeSeq = qe.project.getActiveSequence();
        var seq = cadrSafeActiveSequence();

        if (!qeSeq || !seq) {
            return "NO_SEQUENCE";
        }

        var frameSec = cadrFrameSeconds(seq);
        var tol = frameSec * 0.75;
        var n = Math.max(1, Math.min(12, Math.round(Number(frames))));
        var duration = "00:00:00:" + cadrPad2(n);

        var videoAdded = 0;
        var audioAdded = 0;
        var errors = [];

        if (doVideo === "1") {

            var videoTransition =
                qe.project.getVideoTransitionByName("Cross Dissolve");

            if (!videoTransition) {
                errors.push("TRANSITION_NOT_FOUND:Cross Dissolve");
            } else {

                for (var v = 0; v < seq.videoTracks.numTracks; v++) {

                    if (!cadrHasJunctionAt(seq.videoTracks[v], seconds, tol)) {
                        continue;
                    }

                    var vr = cadrQeAddAt(
                        qeSeq.getVideoTrackAt(v),
                        seconds,
                        tol,
                        videoTransition,
                        duration
                    );

                    if (vr === "ADDED") {
                        videoAdded++;
                    } else if (vr !== "EXISTS") {
                        errors.push("V" + (v + 1) + ":" + vr);
                    }
                }
            }
        }

        if (doAudio === "1") {

            var audioTransition =
                qe.project.getAudioTransitionByName("Constant Power");

            if (!audioTransition) {
                errors.push("TRANSITION_NOT_FOUND:Constant Power");
            } else {

                for (var a = 0; a < seq.audioTracks.numTracks; a++) {

                    if (!cadrHasJunctionAt(seq.audioTracks[a], seconds, tol)) {
                        continue;
                    }

                    var ar = cadrQeAddAt(
                        qeSeq.getAudioTrackAt(a),
                        seconds,
                        tol,
                        audioTransition,
                        duration
                    );

                    if (ar === "ADDED") {
                        audioAdded++;
                    } else if (ar !== "EXISTS") {
                        errors.push("A" + (a + 1) + ":" + ar);
                    }
                }
            }
        }

        return (errors.length ? "ERR" : "OK") +
            ";V=" + videoAdded +
            ";A=" + audioAdded +
            (errors.length ? ";" + errors.join(" | ") : "");

    } catch (e) {
        return "ERR;HOST_ERROR:" + e.toString();
    }
}


/* =========================================================
   DIAGNOSTICS
   Dumps what Premiere really reports about the active sequence
   (tracks, locks, clips, and the QE view of the audio tracks), so a
   problem like "the gap is not closed" can be understood from facts.
   ========================================================= */

function cadrDiagFmt(n) {

    return (Math.round(Number(n) * 1000) / 1000).toString();
}


function cadrDiagTrackLines(tracks, label, out) {

    for (var t = 0; t < tracks.numTracks; t++) {

        var track = tracks[t];
        var locked = "?";

        try {
            locked = (typeof track.isLocked === "function")
                ? String(track.isLocked())
                : "n/a";
        } catch (e1) {}

        out.push(label + (t + 1) + "  locked=" + locked +
            "  clips=" + track.clips.numItems);

        var shown = Math.min(track.clips.numItems, 25);

        for (var i = 0; i < shown; i++) {

            var c = track.clips[i];

            out.push("   [" + i + "] " +
                cadrDiagFmt(c.start.seconds) + " -> " +
                cadrDiagFmt(c.end.seconds) +
                "  in=" + cadrDiagFmt(c.inPoint.seconds) +
                "  " + String(c.name).substring(0, 28));
        }

        if (track.clips.numItems > shown) {
            out.push("   ... (" + (track.clips.numItems - shown) + " more)");
        }
    }
}


/* Names of the methods an object offers (Premiere's own list, not a guess). */
function cadrDiagMethods(obj) {

    var names = [];

    try {

        var m = obj.reflect.methods;

        for (var i = 0; i < m.length; i++) {
            names.push(m[i].name);
        }

    } catch (e1) {}

    if (!names.length) {

        try {

            for (var key in obj) {

                if (typeof obj[key] === "function") {
                    names.push(key);
                }
            }

        } catch (e2) {}
    }

    return names.length ? names.join(", ") : "(none found)";
}


function cadrDiagnose() {

    var out = [];

    try {

        var seq = cadrSafeActiveSequence();

        if (!seq) {
            return "NO_SEQUENCE";
        }

        out.push("CADR diagnostics");
        out.push("sequence: " + seq.name);
        out.push("frame seconds: " + cadrDiagFmt(cadrFrameSeconds(seq)));
        out.push("clone(): " + (typeof seq.clone));
        out.push("app version: " + app.version);
        out.push("");

        cadrDiagTrackLines(seq.videoTracks, "V", out);
        cadrDiagTrackLines(seq.audioTracks, "A", out);

        out.push("");
        out.push("--- QE view of audio tracks ---");

        try {

            cadrEnsureQE();

            var qeSeq = qe.project.getActiveSequence();

            for (var a = 0; a < seq.audioTracks.numTracks; a++) {

                var qeTrack = qeSeq.getAudioTrackAt(a);
                var count = cadrQeNumItems(qeTrack);

                out.push("QE A" + (a + 1) + "  items=" + count);

                var shown = Math.min(count, 30);

                for (var i = 0; i < shown; i++) {

                    var item = qeTrack.getItemAt(i);

                    var line = "   [" + i + "] ";

                    try { line += "type=" + String(item.type); } catch (e2) { line += "type=?"; }

                    try {
                        line += "  start.secs=" + String(item.start.secs);
                    } catch (e3) {
                        line += "  start.secs=?";
                    }

                    try {
                        line += "  start.ticks=" + String(item.start.ticks);
                    } catch (e4) {}

                    try { line += "  name=" + String(item.name).substring(0, 20); } catch (e5) {}

                    line += "  remove=" + (typeof item.remove);

                    out.push(line);
                }
            }

        } catch (qeError) {
            out.push("QE error: " + qeError.toString());
        }

        out.push("");
        out.push("--- Motion of the first video clip ---");

        try {

            var firstClip = null;

            for (var vt = 0; vt < seq.videoTracks.numTracks && !firstClip; vt++) {

                if (seq.videoTracks[vt].clips.numItems > 0) {
                    firstClip = seq.videoTracks[vt].clips[0];
                }
            }

            if (!firstClip) {
                out.push("(no video clips)");
            } else {

                for (var ci = 0; ci < firstClip.components.numItems; ci++) {

                    var comp = firstClip.components[ci];
                    var compLine = "[" + ci + "] " + String(comp.displayName);

                    try { compLine += "  match=" + String(comp.matchName); } catch (e6) {}

                    out.push(compLine);

                    if (compLine.indexOf("Motion") !== -1) {

                        for (var pi = 0; pi < comp.properties.numItems && pi < 8; pi++) {

                            var prop = comp.properties[pi];
                            var propLine = "     (" + pi + ") " + String(prop.displayName);

                            try { propLine += " = " + String(prop.getValue()); } catch (e7) {}
                            try { propLine += "  keyframes=" + String(prop.isTimeVarying()); } catch (e8) {}

                            out.push(propLine);
                        }
                    }
                }
            }

        } catch (motionError) {
            out.push("motion error: " + motionError.toString());
        }

        out.push("");
        out.push("--- sequence markers ---");

        try {

            out.push("numMarkers: " + seq.markers.numMarkers +
                "   CADR Silence: " + cadrCountSilenceMarkersIn(seq));

            var mk = seq.markers.getFirstMarker();
            var shownMarkers = 0;

            while (mk && shownMarkers < 12) {

                out.push("   " + String(mk.name) + "  " +
                    cadrDiagFmt(mk.start.seconds) + " -> " +
                    cadrDiagFmt(mk.end.seconds));

                mk = seq.markers.getNextMarker(mk);
                shownMarkers++;
            }

        } catch (markerError) {
            out.push("markers error: " + markerError.toString());
        }

        out.push("");
        out.push("--- methods Premiere offers ---");

        try {

            out.push("sequence: " + cadrDiagMethods(seq));

            if (seq.audioTracks.numTracks > 0) {

                var domTrack = seq.audioTracks[0];

                out.push("track: " + cadrDiagMethods(domTrack));

                if (domTrack.clips.numItems > 0) {
                    out.push("trackItem: " + cadrDiagMethods(domTrack.clips[0]));
                }
            }

        } catch (domError) {
            out.push("methods error (DOM): " + domError.toString());
        }

        try {

            cadrEnsureQE();

            var qeSeq2 = qe.project.getActiveSequence();

            out.push("QE sequence: " + cadrDiagMethods(qeSeq2));

            var qeTrack2 = qeSeq2.getAudioTrackAt(0);

            out.push("QE track: " + cadrDiagMethods(qeTrack2));

            if (cadrQeNumItems(qeTrack2) > 0) {
                out.push("QE item: " + cadrDiagMethods(qeTrack2.getItemAt(0)));
            }

        } catch (qeError2) {
            out.push("methods error (QE): " + qeError2.toString());
        }

        return out.join("\n");

    } catch (e) {
        return "HOST_ERROR:" + e.toString() + "\n" + out.join("\n");
    }
}


/* =========================================================
   AUTO ZOOM

   After the silences are cut, every second "shot" of a track gets a
   slightly bigger Scale (Motion effect), so the jump cuts look like
   deliberate punch-ins. A "shot" starts at every cut (two clips of the
   same source, back to back, with a jump in the source).

   Zoomed shots are always set RELATIVE to the first shot of the run
   (base * zoom%), never multiplied again, so running it twice does not
   keep growing the zoom.
   ========================================================= */

function cadrZoomClipKey(clip, path) {

    if (path) {
        return path;
    }

    /* nested sequences have no media path: fall back to their name */
    try {
        return "name:" + String(clip.name);
    } catch (e) {
        return "";
    }
}


function cadrFindMotionParams(clip) {

    var comps = clip.components;

    for (var i = 0; i < comps.numItems; i++) {

        var comp = comps[i];
        var isMotion = false;

        try {
            isMotion = (String(comp.matchName) === "AE.ADBE Motion");
        } catch (e1) {}

        if (!isMotion) {

            try {
                isMotion = (String(comp.displayName) === "Motion");
            } catch (e2) {}
        }

        if (isMotion) {

            /* Motion order: 0 Position, 1 Scale, 2 Scale Width,
               3 Uniform Scale, 4 Rotation, 5 Anchor Point */
            return {
                scale: comp.properties[1],
                uniform: comp.properties.numItems > 3 ? comp.properties[3] : null
            };
        }
    }

    return null;
}


/* returns {value} or {skip: "reason"} */
function cadrReadClipScale(clip) {

    var params = cadrFindMotionParams(clip);

    if (!params || !params.scale) {
        return { skip: "no Motion" };
    }

    try {

        if (params.scale.isTimeVarying()) {
            return { skip: "scale has keyframes" };
        }

    } catch (e1) {}

    try {

        if (params.uniform && params.uniform.getValue() === false) {
            return { skip: "non-uniform scale" };
        }

    } catch (e2) {}

    var value = params.scale.getValue();

    if (typeof value !== "number" || isNaN(value)) {
        return { skip: "unreadable scale" };
    }

    return { value: value, params: params };
}


function cadrAutoZoomTrack(trackIndex, zoomPercent, winStart, winEnd) {

    try {

        var seq = cadrSafeActiveSequence();

        if (!seq) {
            return "ERR;NO_SEQUENCE";
        }

        var track = seq.videoTracks[Number(trackIndex)];

        if (!track) {
            return "ERR;NO_TRACK " + trackIndex;
        }

        var frameSec = cadrFrameSeconds(seq);
        var tol = frameSec * 0.75;
        var minGap = frameSec * 0.5;
        var factor = Number(zoomPercent) / 100;

        if (isNaN(factor) || factor < 1.01 || factor > 2) {
            return "ERR;bad zoom " + zoomPercent;
        }

        var items = [];

        for (var i = 0; i < track.clips.numItems; i++) {

            var c = track.clips[i];
            var path = "";

            try {
                path = c.projectItem ? normalizePath(c.projectItem.getMediaPath()) : "";
            } catch (e0) {}

            items.push({
                clip: c,
                start: c.start.seconds,
                end: c.end.seconds,
                inPoint: c.inPoint.seconds,
                outPoint: c.outPoint.seconds,
                key: cadrZoomClipKey(c, path),
                shot: 0
            });
        }

        items.sort(function (x, y) {
            return x.start - y.start;
        });

        var runs = [];
        var current = null;
        var shot = 0;

        for (var k = 0; k < items.length; k++) {

            var it = items[k];
            var prev = k > 0 ? items[k - 1] : null;

            if (
                current && prev && it.key && it.key === prev.key &&
                Math.abs(prev.end - it.start) <= tol
            ) {

                if (it.inPoint - prev.outPoint >= minGap) {
                    shot++;
                }

                it.shot = shot;
                current.push(it);

            } else {

                shot = 0;
                it.shot = 0;
                current = [it];
                runs.push(current);
            }
        }

        var zoomed = 0;
        var shotsZoomed = 0;
        var skipped = 0;
        var notes = [];

        for (var r = 0; r < runs.length; r++) {

            var run = runs[r];

            if (run[run.length - 1].shot < 1) {
                continue;
            }

            var inWindow = false;

            for (var w = 0; w < run.length; w++) {

                if (run[w].start >= winStart - 0.001 && run[w].start <= winEnd + 0.001) {
                    inWindow = true;
                    break;
                }
            }

            if (!inWindow) {
                continue;
            }

            var base = cadrReadClipScale(run[0].clip);

            if (base.skip) {

                skipped++;
                notes.push("run " + (r + 1) + ": " + base.skip);
                continue;
            }

            var lastZoomShot = -1;

            for (var z = 0; z < run.length; z++) {

                if (run[z].shot % 2 !== 1) {
                    continue;
                }

                var current2 = cadrReadClipScale(run[z].clip);

                if (current2.skip) {

                    skipped++;

                    if (notes.length < 4) {
                        notes.push(current2.skip);
                    }

                    continue;
                }

                try {

                    current2.params.scale.setValue(
                        Math.round(base.value * factor * 100) / 100,
                        true
                    );

                    zoomed++;

                    if (run[z].shot !== lastZoomShot) {
                        lastZoomShot = run[z].shot;
                        shotsZoomed++;
                    }

                } catch (setError) {

                    skipped++;

                    if (notes.length < 4) {
                        notes.push("setValue: " + setError.toString());
                    }
                }
            }
        }

        return (notes.length ? "ERR" : "OK") +
            ";zoomed=" + zoomed +
            ";shots=" + shotsZoomed +
            ";skipped=" + skipped +
            (notes.length ? ";" + notes.join(" | ") : "");

    } catch (e) {
        return "ERR;HOST_ERROR:" + e.toString();
    }
}


/* =========================================================
   CAPTION STYLE PROBES
   Two read-mostly experiments that show what Premiere lets a script do
   with caption styling, before we build the feature on a guess:
     cadrProbeCaptions()      - looks at caption tracks (changes nothing)
     cadrProbeMogrt(path)     - places ONE Motion Graphics template at the
                                playhead and tries to change its text
   ========================================================= */

function cadrProbeShort(value) {

    var text;

    try {
        text = String(value);
    } catch (e) {
        text = "(not printable)";
    }

    text = text.replace(/[\r\n]+/g, " ");

    return text.length > 140 ? text.substring(0, 140) + "..." : text;
}


function cadrProbeComponent(comp, out, indent) {

    var count = 0;

    try {
        count = comp.properties.numItems;
    } catch (e1) {
        out.push(indent + "(no properties)");
        return;
    }

    for (var i = 0; i < count && i < 40; i++) {

        var prop = comp.properties[i];
        var line = indent + "(" + i + ") " + cadrProbeShort(prop.displayName);

        try {

            var value = prop.getValue();

            line += "  [" + (typeof value) + "] " + cadrProbeShort(value);

        } catch (e2) {
            line += "  getValue failed";
        }

        try { line += "  keyframes=" + String(prop.isTimeVarying()); } catch (e3) {}

        out.push(line);
    }
}


function cadrProbeCaptions() {

    var out = [];

    try {

        var seq = cadrSafeActiveSequence();

        if (!seq) {
            return "NO_SEQUENCE";
        }

        out.push("CADR caption probe");
        out.push("app version: " + app.version);
        out.push("sequence: " + seq.name);
        out.push("");
        out.push("createCaptionTrack: " + (typeof seq.createCaptionTrack));
        out.push("importMGT: " + (typeof seq.importMGT));
        out.push("importMGTFromLibrary: " + (typeof seq.importMGTFromLibrary));
        out.push("captionTracks: " + (typeof seq.captionTracks));

        if (seq.captionTracks) {

            var n = seq.captionTracks.numTracks;

            out.push("caption tracks: " + n);

            for (var t = 0; t < n && t < 4; t++) {

                var track = seq.captionTracks[t];

                out.push("");
                out.push("caption track " + (t + 1) + ": clips=" + track.clips.numItems);
                out.push("  track methods: " + cadrDiagMethods(track));

                if (track.clips.numItems > 0) {

                    var clip = track.clips[0];

                    out.push("  first item: " +
                        cadrDiagFmt(clip.start.seconds) + " -> " +
                        cadrDiagFmt(clip.end.seconds) +
                        "  name=" + cadrProbeShort(clip.name));
                    out.push("  item methods: " + cadrDiagMethods(clip));

                    try {

                        out.push("  components: " + clip.components.numItems);

                        for (var c = 0; c < clip.components.numItems && c < 6; c++) {

                            out.push("   component [" + c + "] " +
                                cadrProbeShort(clip.components[c].displayName));

                            cadrProbeComponent(clip.components[c], out, "      ");
                        }

                    } catch (compError) {
                        out.push("  components error: " + compError.toString());
                    }
                }
            }
        }

        try {

            cadrEnsureQE();

            var qeSeq = qe.project.getActiveSequence();

            out.push("");
            out.push("QE sequence has caption methods: " +
                (cadrDiagMethods(qeSeq).match(/[A-Za-z]*[Cc]aption[A-Za-z]*/g) || ["none"]).join(", "));

        } catch (qeError) {
            out.push("QE error: " + qeError.toString());
        }

        return out.join("\n");

    } catch (e) {
        return "HOST_ERROR:" + e.toString() + "\n" + out.join("\n");
    }
}


function cadrProbeMogrt(mogrtPath) {

    var out = [];

    try {

        var seq = cadrSafeActiveSequence();

        if (!seq) {
            return "NO_SEQUENCE";
        }

        out.push("CADR MOGRT probe");
        out.push("file: " + mogrtPath);

        if (typeof seq.importMGT !== "function") {
            return out.join("\n") + "\nimportMGT is not available in this Premiere version.";
        }

        var position = seq.getPlayerPosition();
        var startSeconds = position.seconds;

        /* the top video track, or a new one above it if that spot is busy */
        var videoIndex = Math.max(0, seq.videoTracks.numTracks - 1);
        var busy = false;
        var topTrack = seq.videoTracks[videoIndex];

        if (topTrack) {

            for (var i = 0; i < topTrack.clips.numItems; i++) {

                var existing = topTrack.clips[i];

                if (existing.end.seconds > startSeconds && existing.start.seconds < startSeconds + 5) {
                    busy = true;
                }
            }
        }

        if (busy) {
            videoIndex = seq.videoTracks.numTracks;
        }

        out.push("playhead: " + cadrDiagFmt(startSeconds) + "s   video track index: " + videoIndex +
            (busy ? " (new track above)" : ""));

        var item = seq.importMGT(mogrtPath, position.ticks, videoIndex, 0);

        if (!item) {
            return out.join("\n") + "\nimportMGT returned nothing (file path wrong, or Premiere refused it).";
        }

        out.push("placed: " + cadrDiagFmt(item.start.seconds) + " -> " + cadrDiagFmt(item.end.seconds) +
            "  name=" + cadrProbeShort(item.name));

        try { out.push("isMGT: " + String(item.isMGT())); } catch (e1) {}

        var comp = null;

        try {
            comp = item.getMGTComponent();
        } catch (e2) {
            out.push("getMGTComponent error: " + e2.toString());
        }

        if (!comp) {
            out.push("no MGT component (the file may not be a Motion Graphics template).");
            return out.join("\n");
        }

        out.push("MGT component: " + cadrProbeShort(comp.displayName));
        out.push("parameters:");
        cadrProbeComponent(comp, out, "   ");

        /* try to change the first parameter that looks like text */
        var target = -1;

        for (var p = 0; p < comp.properties.numItems && target < 0; p++) {

            try {

                if (/text/i.test(String(comp.properties[p].displayName))) {
                    target = p;
                }

            } catch (e3) {}
        }

        if (target < 0) {
            out.push("");
            out.push("no parameter with 'text' in its name; trying parameter 0");
            target = 0;
        }

        var param = comp.properties[target];
        var before = param.getValue();

        out.push("");
        out.push("text test on parameter (" + target + ") " + cadrProbeShort(param.displayName));
        out.push("   before: [" + (typeof before) + "] " + cadrProbeShort(before));

        try {

            param.setValue("CADR TEST", true);

            out.push("   setValue('CADR TEST'): ok -> now: " + cadrProbeShort(param.getValue()));

        } catch (e4) {
            out.push("   setValue('CADR TEST') failed: " + e4.toString());
        }

        /* newer Premiere versions keep the text inside a JSON string */
        try {

            var parsed = JSON.parse(String(before));

            if (parsed && typeof parsed === "object") {

                parsed.textEditValue = "CADR JSON TEST";
                param.setValue(JSON.stringify(parsed), true);

                out.push("   JSON textEditValue: ok -> now: " + cadrProbeShort(param.getValue()));
            }

        } catch (e5) {
            out.push("   JSON variant: " + (String(before).charAt(0) === "{" ? "failed: " + e5.toString() : "not used (value is not JSON)"));
        }

        out.push("");
        out.push("The template is still on the timeline: delete it, or press Ctrl+Z.");

        return out.join("\n");

    } catch (e) {
        return "HOST_ERROR:" + e.toString() + "\n" + out.join("\n");
    }
}


/* =========================================================
   STYLED CAPTIONS (MOGRT) — ROCK-SOLID PREMIERE EXTENDSCRIPT ENGINE
   ========================================================= */

function cadrCaptionTrackIndex() {
    try {
        var seq = cadrSafeActiveSequence();
        if (!seq) {
            return "NO_SEQUENCE";
        }
        return String(seq.videoTracks.numTracks);
    } catch (e) {
        return "HOST_ERROR:" + e.toString();
    }
}

function cadrFindMgtTextParam(comp) {
    var fallback = -1;
    for (var i = 0; i < comp.properties.numItems; i++) {
        var prop = comp.properties[i];
        var value;
        try {
            value = prop.getValue();
        } catch (e1) {
            continue;
        }
        if (
            typeof value === "string" &&
            value.charAt(0) === "{" &&
            value.indexOf("textEditValue") !== -1
        ) {
            return i;
        }
        if (
            fallback < 0 &&
            typeof value === "string" &&
            /text/i.test(String(prop.displayName))
        ) {
            fallback = i;
        }
    }
    return fallback;
}

function cadrSetMgtText(comp, text, ov) {
    var index = cadrFindMgtTextParam(comp);
    if (index < 0) {
        return "NO_TEXT_PARAM";
    }

    var param = comp.properties[index];
    var wantsFont = !!(ov && ov.font);
    var wantsSize = !!(ov && ov.fontSize);

    if (text === null && !wantsFont && !wantsSize) {
        return "json";
    }

    try {
        var rawVal = String(param.getValue());
        var parsed = JSON.parse(rawVal);

        if (parsed && typeof parsed === "object") {
            if (text !== null) {
                parsed.textEditValue = String(text);
                if (Object.prototype.toString.call(parsed.fontTextRunLength) === "[object Array]") {
                    parsed.fontTextRunLength = [String(text).length];
                }
            }

            if (wantsFont) {
                var fontIsArray =
                    Object.prototype.toString.call(parsed.fontEditValue) === "[object Array]";
                parsed.fontEditValue = fontIsArray ? [String(ov.font)] : String(ov.font);
            }

            if (wantsSize) {
                var szNum = Number(ov.fontSize);
                if (parsed.fontSizeEditValue !== undefined) {
                    var szIsArray =
                        Object.prototype.toString.call(parsed.fontSizeEditValue) === "[object Array]";
                    parsed.fontSizeEditValue = szIsArray ? [szNum] : szNum;
                }
                if (ov.sizeKey && parsed[String(ov.sizeKey)] !== undefined) {
                    var kIsArray =
                        Object.prototype.toString.call(parsed[String(ov.sizeKey)]) === "[object Array]";
                    parsed[String(ov.sizeKey)] = kIsArray ? [szNum] : szNum;
                }
            }

            param.setValue(JSON.stringify(parsed), true);

            if (text === null) {
                return "json";
            }

            var back = JSON.parse(String(param.getValue()));
            if (back && back.textEditValue === text) {
                return "json";
            }
        }
    } catch (e1) {}

    if (text === null) {
        return "json";
    }

    try {
        param.setValue(String(text), true);
        return "plain";
    } catch (e2) {
        return "SET_FAILED:" + e2.toString();
    }
}

function cadrFindMgtParamByName(comp, name) {
    var targetLower = String(name || "").toLowerCase();
    for (var i = 0; i < comp.properties.numItems; i++) {
        try {
            var dName = String(comp.properties[i].displayName);
            if (dName === String(name) || dName.toLowerCase() === targetLower) {
                return comp.properties[i];
            }
        } catch (e) {}
    }
    return null;
}

function cadrApplyParamOverrides(comp, ov, notes) {
    if (!ov) return;
    var params = {};
    if (ov.params) {
        for (var k in ov.params) {
            if (Object.prototype.hasOwnProperty.call(ov.params, k)) {
                params[k] = ov.params[k];
            }
        }
    }
    /* Sync ov.fontSize with "Text Size" or "Size" slider property if present in the MOGRT */
    if (ov.fontSize !== undefined && params["Text Size"] === undefined) {
        params["Text Size"] = Number(ov.fontSize);
    }

    for (var name in params) {
        if (!Object.prototype.hasOwnProperty.call(params, name)) continue;
        var prop = cadrFindMgtParamByName(comp, name);
        if (!prop) {
            continue;
        }

        var value = params[name];

        try {
            if (typeof value === "string" && value.charAt(0) === "#" && value.length === 7) {
                var r = parseInt(value.substr(1, 2), 16);
                var g = parseInt(value.substr(3, 2), 16);
                var b = parseInt(value.substr(5, 2), 16);
                prop.setColorValue(255, r, g, b, true);
            } else if (/position/i.test(name) && value && value.length === 2) {
                var rx = Number(value[0]);
                var ry = Number(value[1]);
                var curPos = null;
                try { curPos = prop.getValue(); } catch (ep) {}
                /* If Premiere reports pixel coordinates (> 2) on this property, scale to pixel space;
                   if Premiere reports normalized [0..1] (standard in PPRO), pass normalized [rx, ry]! */
                if (
                    curPos &&
                    curPos.length === 2 &&
                    (Math.abs(Number(curPos[0])) > 2 || Math.abs(Number(curPos[1])) > 2) &&
                    rx >= 0 && rx <= 1.5 && ry >= 0 && ry <= 1.5
                ) {
                    var cw = (ov.compSize && ov.compSize.length === 2 && Number(ov.compSize[0]) > 0) ? Number(ov.compSize[0]) : 3840;
                    var ch = (ov.compSize && ov.compSize.length === 2 && Number(ov.compSize[1]) > 0) ? Number(ov.compSize[1]) : 2160;
                    prop.setValue([Math.round(rx * cw), Math.round(ry * ch)], true);
                } else {
                    prop.setValue([rx, ry], true);
                }
            } else if (typeof value === "number") {
                prop.setValue(Number(value), true);
            } else {
                prop.setValue(value, true);
            }
        } catch (e) {
            notes.push("SET_FAILED:" + name);
        }
    }
}

function cadrPlaceStyledCaption(encoded) {
    try {
        var d = JSON.parse(decodeURIComponent(String(encoded)));
        var seq = cadrSafeActiveSequence();
        if (!seq) {
            return "NO_SEQUENCE";
        }
        if (typeof seq.importMGT !== "function") {
            return "ERR:IMPORTMGT_UNAVAILABLE";
        }

        /* Normalize path for Windows/macOS so importMGT never fails on mixed slashes */
        var rawPath = String(d.path || "");
        try {
            var fObj = new File(rawPath);
            if (fObj.exists) {
                rawPath = fObj.fsName;
            }
        } catch (ef) {}

        var startTime = new Time();
        startTime.seconds = Number(d.start);

        var item = seq.importMGT(
            rawPath,
            startTime.ticks,
            Number(d.track),
            0
        );

        if (!item) {
            return "ERR:importMGT failed for path: " + rawPath;
        }

        var notes = [];
        try {
            var endTime = new Time();
            endTime.seconds = Number(d.end);
            item.end = endTime;
        } catch (e1) {
            notes.push("END_FAILED");
        }

        var comp = null;
        try {
            comp = item.getMGTComponent();
        } catch (e2) {}

        if (!comp) {
            return "ERR:NO_MGT_COMPONENT";
        }

        var mode = cadrSetMgtText(comp, String(d.text), d.ov || null);
        if (mode !== "json" && mode !== "plain") {
            return "ERR:" + mode;
        }

        if (d.ov) {
            cadrApplyParamOverrides(comp, d.ov, notes);
        }

        return notes.length ? "OK;" + notes.join(",") : "OK";
    } catch (e) {
        return "ERR:" + e.toString();
    }
}

function cadrFindMgtTrackIndex(preferredTrack) {
    try {
        var seq = cadrSafeActiveSequence();
        if (!seq) return "NO_SEQUENCE";
        var pref = Number(preferredTrack);
        if (!isNaN(pref) && pref >= 0 && pref < seq.videoTracks.numTracks) {
            var trPref = seq.videoTracks[pref];
            for (var p = 0; p < trPref.clips.numItems; p++) {
                if (cadrIsMgtClip(trPref.clips[p])) {
                    return String(pref);
                }
            }
        }
        for (var t = seq.videoTracks.numTracks - 1; t >= 0; t--) {
            var tr = seq.videoTracks[t];
            for (var c = 0; c < tr.clips.numItems; c++) {
                if (cadrIsMgtClip(tr.clips[c])) {
                    return String(t);
                }
            }
        }
        return "NO_MGT_TRACK";
    } catch (e) {
        return "ERR:" + e.toString();
    }
}

function cadrRemoveStyledCaptions(trackIndex) {
    try {
        var seq = cadrSafeActiveSequence();
        if (!seq) return "NO_SEQUENCE";
        var resolvedIdx = cadrFindMgtTrackIndex(trackIndex);
        if (resolvedIdx === "NO_MGT_TRACK" || resolvedIdx.indexOf("ERR:") === 0) {
            return "OK;0";
        }
        var track = seq.videoTracks[Number(resolvedIdx)];
        if (!track) return "NO_TRACK";

        var removed = 0;
        for (var i = track.clips.numItems - 1; i >= 0; i--) {
            var clip = track.clips[i];
            if (cadrIsMgtClip(clip)) {
                clip.remove(false, false);
                removed++;
            }
        }
        return "OK;" + removed + ";" + resolvedIdx;
    } catch (e) {
        return "ERR:" + e.toString();
    }
}

function cadrIsMgtClip(clip) {
    try {
        return !!clip.isMGT();
    } catch (e) {
        return false;
    }
}

function cadrFindMgtClipToRead(trackIndex) {
    var seq = cadrSafeActiveSequence();
    if (!seq) return null;

    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var tr = seq.videoTracks[t];
        for (var c = 0; c < tr.clips.numItems; c++) {
            var clip = tr.clips[c];
            var selected = false;
            try { selected = clip.isSelected(); } catch (e1) {}
            if (selected && cadrIsMgtClip(clip)) {
                return clip;
            }
        }
    }

    var track = seq.videoTracks[Number(trackIndex)];
    if (track) {
        for (var k = 0; k < track.clips.numItems; k++) {
            if (cadrIsMgtClip(track.clips[k])) {
                return track.clips[k];
            }
        }
    }

    /* Also check all tracks from top to bottom if trackIndex wasn't found */
    for (var vt = seq.videoTracks.numTracks - 1; vt >= 0; vt--) {
        var vtr = seq.videoTracks[vt];
        for (var vc = 0; vc < vtr.clips.numItems; vc++) {
            if (cadrIsMgtClip(vtr.clips[vc])) {
                return vtr.clips[vc];
            }
        }
    }

    return null;
}

function cadrColorHexOf(prop) {
    try {
        var c = prop.getColorValue();
        if (!c || c.length < 4) return "";
        var r = Number(c[1]);
        var g = Number(c[2]);
        var b = Number(c[3]);
        var scale = Math.max(r, g, b) <= 1 ? 255 : 1;
        var hex = function (n) {
            var v = Math.max(0, Math.min(255, Math.round(n * scale)));
            return (v < 16 ? "0" : "") + v.toString(16);
        };
        return "#" + hex(r) + hex(g) + hex(b);
    } catch (e) {
        return "";
    }
}

function cadrReadStyleParams(trackIndex) {
    try {
        var clip = cadrFindMgtClipToRead(trackIndex);
        if (!clip) return "NO_MGT_CLIP";
        var comp = clip.getMGTComponent();
        if (!comp) return "NO_MGT_COMPONENT";

        var result = { clip: String(clip.name), font: null, params: [] };
        var textIndex = cadrFindMgtTextParam(comp);

        for (var i = 0; i < comp.properties.numItems; i++) {
            var prop = comp.properties[i];
            var name = String(prop.displayName);
            if (!name || /^@/.test(name)) continue;
            var value;
            try {
                value = prop.getValue();
            } catch (e1) {
                continue;
            }

            if (i === textIndex) {
                try {
                    var parsed = JSON.parse(String(value));
                    var sizeKey = "";
                    for (var key in parsed) {
                        if (/^fontSize.*EditValue$/i.test(key) || key === "fontSizeEditValue") {
                            sizeKey = key;
                        }
                    }
                    var fontValue = parsed.fontEditValue;
                    if (Object.prototype.toString.call(fontValue) === "[object Array]") {
                        fontValue = fontValue.length ? fontValue[0] : "";
                    }
                    var fsVal = sizeKey ? parsed[sizeKey] : null;
                    if (Object.prototype.toString.call(fsVal) === "[object Array]") {
                        fsVal = fsVal.length ? fsVal[0] : null;
                    }
                    result.font = {
                        paramName: name,
                        font: fontValue ? String(fontValue) : "",
                        hasFont: parsed.fontEditValue !== undefined,
                        sizeKey: sizeKey || "fontSizeEditValue",
                        fontSize: fsVal !== null ? Number(fsVal) : 100
                    };
                } catch (e2) {}
                continue;
            }

            var kind = "other";
            var current = null;

            if (/colou?r/i.test(name)) {
                kind = "color";
                current = cadrColorHexOf(prop) || "#F5F5F5";
            } else if (/position/i.test(name) && typeof value === "object" && value !== null) {
                kind = "position";
                try {
                    var px = Number(value[0]);
                    var py = Number(value[1]);
                    if (Math.abs(px) > 2 || Math.abs(py) > 2) {
                        px = Math.round((px / 3840) * 100) / 100;
                        py = Math.round((py / 2160) * 100) / 100;
                    }
                    current = [px, py];
                } catch (e3) {
                    kind = "other";
                }
            } else if (typeof value === "boolean") {
                kind = "bool";
                current = value;
            } else if (typeof value === "number") {
                kind = "number";
                current = value;
            }

            if (kind !== "other") {
                result.params.push({ name: name, kind: kind, value: current });
            }
        }

        return JSON.stringify(result);
    } catch (e) {
        return "ERR:" + e.toString();
    }
}

function cadrCountTrackClips(trackIndex) {
    try {
        var seq = cadrSafeActiveSequence();
        if (!seq) return "NO_SEQUENCE";
        var track = seq.videoTracks[Number(trackIndex)];
        return track ? String(track.clips.numItems) : "NO_TRACK";
    } catch (e) {
        return "ERR:" + e.toString();
    }
}

function cadrApplyStyleAt(trackIndex, clipIndex, encoded) {
    try {
        var ov = JSON.parse(decodeURIComponent(String(encoded)));
        var seq = cadrSafeActiveSequence();
        if (!seq) return "NO_SEQUENCE";

        var track = seq.videoTracks[Number(trackIndex)];
        if (!track) return "NO_TRACK";

        var clip = track.clips[Number(clipIndex)];
        if (!clip || !cadrIsMgtClip(clip)) {
            return "SKIP";
        }

        var comp = clip.getMGTComponent();
        if (!comp) return "ERR:NO_MGT_COMPONENT";

        var notes = [];
        var mode = cadrSetMgtText(comp, null, ov);
        if (mode !== "json") {
            notes.push(mode);
        }

        cadrApplyParamOverrides(comp, ov, notes);

        return notes.length ? "OK;" + notes.join(",") : "OK";
    } catch (e) {
        return "ERR:" + e.toString();
    }
}

function cadrApplyStyleToSelectedClips(encoded) {
    try {
        var seq = cadrSafeActiveSequence();
        if (!seq) return "NO_SEQUENCE";
        var ov = JSON.parse(decodeURIComponent(String(encoded)));
        var count = 0;
        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var tr = seq.videoTracks[t];
            for (var c = 0; c < tr.clips.numItems; c++) {
                var clip = tr.clips[c];
                var isSel = false;
                try { isSel = clip.isSelected(); } catch (es) {}
                if (isSel && cadrIsMgtClip(clip)) {
                    var comp = clip.getMGTComponent();
                    if (comp) {
                        var notes = [];
                        cadrSetMgtText(comp, null, ov);
                        cadrApplyParamOverrides(comp, ov, notes);
                        count++;
                    }
                }
            }
        }
        if (count === 0) return "NO_SELECTED_MGT";
        return "OK_SELECTED;" + count;
    } catch (e) {
        return "ERR:" + e.toString();
    }
}


function cadrPickMogrtFiles() {
    try {
        var picked = File.openDialog("Select MOGRT Template(s)", "*.mogrt", true);
        if (!picked) return "CANCEL";
        var out = [];
        if (picked instanceof Array) {
            for (var i = 0; i < picked.length; i++) {
                if (picked[i]) out.push(String(picked[i].fsName).replace(/\\/g, "/"));
            }
        } else {
            out.push(String(picked.fsName).replace(/\\/g, "/"));
        }
        return JSON.stringify(out);
    } catch (e) {
        return "ERR:" + e.toString();
    }
}
