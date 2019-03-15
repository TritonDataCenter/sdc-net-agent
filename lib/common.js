/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019 Joyent, Inc.
 */

'use strict';

var assert = require('assert-plus');
var mod_jsprim = require('jsprim');
var mod_mooremachine = require('mooremachine');
var mod_util = require('util');

// --- Globals

var MAX_TIMESTAMPS = 10;


// --- Internal helpers

function prependTS(arr) {
    arr.unshift(currentMillis());

    while (arr.length > MAX_TIMESTAMPS) {
        arr.pop();
    }
}


// --- Exports


/*
 * Get monotonic time in milliseconds.
 *
 * Note that this is *not* the same as Date.now(), which returns the current
 * wall clock time in milliseconds.
 */
function currentMillis() {
    var time = process.hrtime();
    var secs2ms = time[0] * 1000;
    var ns2ms = time[1] / 1000000;

    return (secs2ms + ns2ms);
}


function formatAggrId(cn_uuid, name) {
    assert.uuid(cn_uuid, 'cn_uuid');
    assert.string(name, 'name');

    return mod_util.format('%s-%s', cn_uuid, name);
}


function hasChanged(fields, cur, old) {
    if (cur === old) {
        return false;
    }

    if (old === null) {
        return true;
    }

    return fields.some(function (field) {
        return !mod_jsprim.deepEqual(cur[field], old[field]);
    });
}


/**
 * This class encapsulates some of the common logic to net-agent's FSMs.
 */
function CommonFSM() {
    this.pending = {};
    this.last = {};

    mod_mooremachine.FSM.call(this, 'init');
}
mod_util.inherits(CommonFSM, mod_mooremachine.FSM);

/**
 * Asynchronously emit event "name". If the event was last emitted within
 * "delay" milliseconds, then we wait to emit it until we're clear of the
 * window. Multiple calls to emitDelayed() for the same event will be
 * coalesced into one emit.
 */
CommonFSM.prototype.emitDelayed = function emitDelayed(name, delay) {
    var self = this;
    var wait = 0;

    if (typeof (delay) !== 'number') {
        delay = 0;
    }

    if (self.pending[name]) {
        return;
    }

    if (self.last[name] === undefined) {
        self.last[name] = [ 0 ];
    }

    var now = currentMillis();
    var next = self.last[name][0] + delay;
    if (next > now) {
        wait = next - now;
    }

    self.pending[name] = true;
    setTimeout(function _emitDelayed() {
        self.pending[name] = false;
        prependTS(self.last[name]);
        self.emit(name);
    }, wait);
};

module.exports = {
    CommonFSM: CommonFSM,
    currentMillis: currentMillis,
    formatAggrId: formatAggrId,
    hasChanged: hasChanged
};
