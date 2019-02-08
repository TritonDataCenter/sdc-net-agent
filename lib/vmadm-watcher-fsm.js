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
var mod_mooremachine = require('mooremachine');
var mod_util = require('util');

var currentMillis = require('./utils').currentMillis;

// --- Globals

/*
 * We delay emitting the "vms-update" event by up to 5 seconds when we would
 * otherwise do it right on the heels of the previous one. This helps us avoid
 * repeatedly checking configurations while we're updating multiple VMs (e.g.,
 * after a popular network has changed).
 */
var UPDATE_DELAY = 5 * 1000;

var WATCHED_FIELDS = [
    'resolvers',
    'nics',
    'owner_uuid',
    'routes',
    'state'
];


// --- Internal helpers

/**
 * The VmadmEventsFSM is responsible for collecting and managing information
 * on VMs using `vmadm events` (vminfod).
 */
function VmadmEventsFSM(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.ok(['object', 'function']
        .indexOf(typeof (opts.vmadm)) !== -1, 'opts.vmadm');

    self.log = opts.log.child({
        component: 'vmadm-events'
    }, true);
    self.vms = {};
    self.ignore = {};
    self.emitter = null;
    self.stopWatcher = null;
    self.vmadm = opts.vmadm;

    self.lastUpdate = 0;
    self.pending = {
        vmsUpdate: false
    };

    mod_mooremachine.FSM.call(self, 'waiting');
}
mod_util.inherits(VmadmEventsFSM, mod_mooremachine.FSM);

VmadmEventsFSM.prototype.state_waiting = function (S) {
    S.on(this, 'startAsserted', function () {
        S.gotoState('init');
    });
};

/*
 * Create the `vmadm events` watcher which gets events for any VM change on the
 * system using vminfod.
 *
 * An internal object (self.vms) is maintaned by this state which contains all
 * VMs on the system (keyed by zonename).  When an event is seen for a specific
 * VM, its corresponding object in the self.vms is updated to reflect the
 * latest known state of the VM.  This object is then passed to `app.updateVMs`
 * whenever any change on the system is seen.
 */
VmadmEventsFSM.prototype.state_init = function (S) {
    var self = this;

    self.vms = {};
    assert(!self.stopWatcher, 'stopWatcher already defined');

    var opts = {
        log: self.log,
        name: 'Net Agent VmadmEventsFSM'
    };

    // Called when a new event from `vmadm events` is seen
    function handler(ev) {
        assert.object(ev, 'ev');
        assert.optionalObject(ev.vm, 'ev.vm');
        assert.string(ev.type, 'ev.type');
        assert.uuid(ev.zonename, 'ev.zonename');

        var needsUpdate = false;

        self.log.trace({ev: ev}, 'saw event from "vmadm events"');

        if (ev.vm && ev.vm.do_not_inventory) {
            self.ignore[ev.zonename] = true;
            self.log.debug('VM %s ignored - do_not_inventory set',
                ev.zonename);
        } else if (ev.vm && !ev.vm.do_not_inventory) {
            delete self.ignore[ev.zonename];
        }

        switch (ev.type) {
        case 'create':
            assert.object(ev.vm, 'ev.vm');
            assert(!self.vms.hasOwnProperty(ev.zonename), 'VM already created');

            self.vms[ev.zonename] = ev.vm;
            self.log.debug('VM %s created - setting needsUpdate', ev.zonename);
            needsUpdate = true;
            break;
        case 'modify':
            assert.object(ev.vm, 'ev.vm');
            assert.arrayOfObject(ev.changes, 'ev.changes');
            assert(self.vms.hasOwnProperty(ev.zonename), 'VM not found');

            self.vms[ev.zonename] = ev.vm;

            if (self.ignore[ev.zonename]) {
                break;
            }

            var changes = ev.changes.filter(function (change) {
                return (WATCHED_FIELDS.indexOf(change.path[0]) >= 0);
            });

            if (changes.length > 0) {
                var keys = changes.map(function (change) {
                    return change.prettyPath;
                });
                self.log.debug(
                    'VM %s fields updated (%s) - setting needsUpdate',
                    ev.zonename, keys.join(','));
                needsUpdate = true;
            }

            break;
        case 'delete':
            delete self.vms[ev.zonename];
            if (!self.ignore[ev.zonename]) {
                self.log.debug('VM %s deleted - setting needsUpdate',
                    ev.zonename);
                needsUpdate = true;
            }
            delete self.ignore[ev.zonename];
            break;
        default:
            assert.fail('unknown vmadm event type: ' + ev.type);
            break;
        }

        if (needsUpdate) {
            self._emitUpdate();
        }
    }

    /*
     * Called when `vmadm events` is ready (with full list of VMs on the
     * system)
     */
    function ready(err, obj) {
        // This can fail in the event that vminfod is down
        if (err) {
            self.log.error(err, 'vmadm events failed to ready');

            // Try again
            S.timeout(1000, function () {
                S.gotoState('init');
            });
            return;
        }

        assert.object(obj, 'obj');
        assert.func(obj.stop, 'obj.stop');
        assert.object(obj.ev, 'obj.ev');
        assert.object(obj.ev.vms, 'obj.ev.vms');

        self.vms = obj.ev.vms;
        self.stopWatcher = obj.stop;

        self._emitUpdate();

        S.gotoState('running');
    }

    self.emitter = self.vmadm.events(opts, handler, ready);

    S.on(self.emitter, 'error', function (err) {
        self.log.error(err, 'vmadm events error');
        self.emitter = null;
        S.timeout(1000, function () {
            S.gotoState('init');
        });
    });
};

VmadmEventsFSM.prototype.state_running = function (S) {
    var self = this;

    S.on(self.emitter, 'error', function (err) {
        self.log.error(err, 'vmadm events error');
        self.stopWatcher();
        self.stopWatcher = null;
        self.emitter = null;
        S.timeout(1000, function () {
            S.gotoState('init');
        });
    });

    S.on(self, 'stopAsserted', function () {
        S.gotoState('stopped');
    });

    S.on(self, 'restartAsserted', function () {
        S.gotoState('init');
    });
};

VmadmEventsFSM.prototype.state_stopped = function (S) {
    S.validTransitions([]);
};

VmadmEventsFSM.prototype.start = function () {
    var self = this;

    self.emit('startAsserted');
};

VmadmEventsFSM.prototype.stop = function () {
    var self = this;

    self.emit('stopAsserted');
};

VmadmEventsFSM.prototype.getCurrentVMs = function () {
    var self = this;

    var vms = Object.keys(self.vms).map(function (uuid) {
        return self.vms[uuid];
    }).filter(function (vm) {
        return !vm.do_not_inventory;
    });

    return vms;
};

VmadmEventsFSM.prototype._emitUpdate = function () {
    var self = this;
    var wait = 0;

    if (self.pending.vmsUpdate) {
        return;
    }

    var now = currentMillis();
    var next = self.lastUpdate + UPDATE_DELAY;
    if (next > now) {
        wait = next - now;
    }

    self.pending.vmsUpdate = true;
    setTimeout(function () {
        self.lastUpdate = currentMillis();
        self.pending.vmsUpdate = false;
        self.emit('vms-update');
    }, wait);
};


// --- Exports

function VmadmWatcherFSM(opts) {
    var self = this;

    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.app.log, 'opts.app.log');

    self.app = opts.app;
    self.log = opts.app.log.child({
        component: 'vmadm-watcher'
    }, true);
    self.vmadm = opts.vmadm;

    self.vmadmevents = new VmadmEventsFSM({
        log: self.log,
        vmadm: self.vmadm
    });

    self.pending = {
        refresh: false
    };

    mod_mooremachine.FSM.call(self, 'init');
}
mod_util.inherits(VmadmWatcherFSM, mod_mooremachine.FSM);

VmadmWatcherFSM.prototype.state_init = function (S) {
    var self = this;

    S.on(self, 'startAsserted', function () {
        S.gotoState('running');
    });
};

VmadmWatcherFSM.prototype.state_running = function (S) {
    var self = this;

    function updateVMs() {
        self.app.updateVMs(self.vmadmevents.getCurrentVMs());
    }

    S.on(self.vmadmevents, 'vms-update', updateVMs);

    S.on(self, 'refreshAsserted', updateVMs);

    self.vmadmevents.start();
};

VmadmWatcherFSM.prototype.start = function () {
    var self = this;

    self.emit('startAsserted');
};

VmadmWatcherFSM.prototype.stop = function () {
    var self = this;

    self.emit('stopAsserted');
};

VmadmWatcherFSM.prototype.refresh = function () {
    var self = this;

    if (self.pending.refresh) {
        return;
    }

    self.pending.refresh = true;
    setImmediate(function () {
        self.pending.refresh = false;
        self.emit('refreshAsserted');
    });
};

module.exports = VmadmWatcherFSM;
