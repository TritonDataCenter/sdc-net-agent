/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

'use strict';

var assert = require('assert-plus');
var mod_forkexec = require('forkexec');
var mod_jsprim = require('jsprim');
var mod_mooremachine = require('mooremachine');
var mod_util = require('util');

// --- Globals

var _versionCache = null;
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

function getNetAgentVersion() {
    if (_versionCache === null) {
        _versionCache = require('../package.json').version;
    }
    return _versionCache;
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

function loadSysinfo(callback) {
    assert.func(callback, 'callback');

    mod_forkexec.forkExecWait({
        argv: [ '/usr/bin/sysinfo' ],
        includeStderr: true,
        timeout: 0
    }, function (err, info) {
        if (err) {
            callback(err);
            return;
        }

        var sysinfo;

        try {
            sysinfo = JSON.parse(info.stdout.trim());
        } catch (e) {
            callback(e);
            return;
        }

        callback(null, sysinfo);
    });
}

function loadOverlays(callback) {
    assert.func(callback, 'callback');

    mod_forkexec.forkExecWait({
        argv: [ '/usr/sbin/dladm', 'show-overlay', '-p', '-o link'],
        includeStderr: false,
        timeout: 0
    }, function done(err, info) {
        if (err) {
            callback(err);
            return;
        }

        var overlays = {};

        info.stdout.trim().forEach(function eachOverlay(ov) {
            overlays[ov] = 1;
        });

        callback(null, Object.keys(overlays));
    });
}

function loadVPCNets(overlay, callback) {
    assert.string(overlay, 'overlay');
    assert.func(callback, 'callback');

    mod_forkexec.forkExecWait({
        argv: [ '/usr/sbin/ovroute', 'router', 'get',
            '-d', overlay,
            '-o', 'id,network,network-v6,vlan,mac,rtable', '-p' ],
        includeStderr: false,
        timeout: 0
    }, function done(err, info) {
        if (err) {
            callback(err);
            return;
        }

        var nets = {};

        info.stdout.trim().forEach(function eachLine(line) {
            var items = line.split(/:/);
            var net = {
                id: items[0],
                network: items[1],
                networkv6: items[2],
                vlan: items[3],
                mac: items[4],
                rtable: items[5]
            };
            nets[items[0]] = net;
        });

        callback(null, nets);
    });
}

/*
 * This gets the list of route tables
 */
function loadVPCRouteTables(overlay, callback) {
    assert.string(overlay, 'overlay');
    assert.func(callback, 'callback');

    mod_forkexec.forkExecWait({
        argv: [ '/usr/sbin/ovroute', 'route-table', 'get',
            '-d', overlay,
            '-o', 'id', '-p' ],
        includeStderr: false,
        timeout: 0
    }, function done(err, info) {
        if (err) {
            callback(err);
            return;
        }

        var rtabs = [];

        info.stdout.trim().forEach(function eachRtab(rtab) {
            rtabs.push(rtab);
        });

        callback(null, rtabs);
    });
}

/*
 * This retrieves the entries for a given route table
 */
function loadVPCRouteTable(overlay, name, callback) {
    assert.string(overlay, 'overlay');
    assert.string(name, 'name');
    assert.func(callback, 'callback');

    mod_forkexec.forkExecWait({
        argv: [ '/usr/sbin/ovroute', 'route-table', 'get',
            '-d', overlay,
            '-o', 'id,destination,target', '-p',
            name ],
        includeStderr: false,
        timeout: 0
    }, function done(err, info) {
        if (err) {
            callback(err);
            return;
        }

        var rtab = {};

        info.stdout.trim().forEach(function eachLine(line) {
            var fields = line.split(':');

            rtab[fields[1]] = fields[2];
        });

        callback(null, rtab);
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
    getNetAgentVersion: getNetAgentVersion,
    hasChanged: hasChanged,
    loadOverlays: loadOverlays,
    loadSysinfo: loadSysinfo,
    loadVPCNets: loadVPCNets,
    loadVPCRouteTables: loadVPCRouteTables,
    loadVPCRouteTable: loadVPCRouteTable
};
