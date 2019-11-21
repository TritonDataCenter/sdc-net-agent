/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

'use strict';

var assert = require('assert-plus');
var mod_child = require('child_process');
var mod_common = require('./common');
var mod_fs = require('fs');
var mod_jsprim = require('jsprim');
var mod_util = require('util');

var LineStream = require('lstream');

// --- Globals

var FIELDS = [
    'uuid',
    'owner_uuid',
    'state',
    'zone_state',
    'nics',
    'resolvers',
    'routes',
    'do_not_inventory',
    'internal_metadata'
];

var STATE_WATCHER_TIMEOUT = 5 * 60 * 1000;
var ZONEEVENT_CMD = '/usr/vm/sbin/zoneevent';

/*
 * We ensure that all `vmadm lookup` runs are separated by at least 5 seconds,
 * to help debounce successive events for a VM, and to help prevent generating
 * too much load on the system.
 */
var REFRESH_DELAY = 5 * 1000;

/*
 * These are the events being watched by the zoneevent watcher. When zones
 * don't switch to these zone_states we ignore them
 */
var WATCH_EVENTS = {
    uninitialized: true,
    running: true
};


// --- Internal helpers

/*
 * The ZoneEventFSM is responsible for tracking the zoneevent process, and
 * restarting it when needed. When the process emits events to stdout, it
 * will process it and emit an event if needed, so that WatcherFSM knows to
 * refresh its information.
 */
function ZoneEventFSM(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');

    this.log = opts.log.child({
        component: 'zoneevent'
    }, true);

    this.proc = null;
    this.stdout = null;
    this.stderr = null;

    mod_common.CommonFSM.call(this);
}
mod_util.inherits(ZoneEventFSM, mod_common.CommonFSM);

ZoneEventFSM.prototype.state_init = function (S) {
    this.proc = mod_child.spawn(ZONEEVENT_CMD, ['-i', 'net-agent'], {
        'customFds': [-1, -1, -1]
    });

    this.stdout = new LineStream();
    this.stderr = new LineStream();

    this.proc.stdout.pipe(this.stdout);
    this.proc.stderr.pipe(this.stderr);

    S.gotoState('running');
};

ZoneEventFSM.prototype.state_running = function (S) {
    var self = this;

    S.on(self, 'stopAsserted', function () {
        self.proc.kill('SIGTERM');

        S.gotoState('stopped');
    });

    S.on(self.stdout, 'readable', function () {
        var event, line;

        while ((line = self.stdout.read()) !== null) {
            line = line.toString();

            try {
                event = JSON.parse(line);
            } catch (e) {
                self.log.warn({
                    err: e,
                    line: line
                }, 'failed to parse zoneevent output');
                continue;
            }

            self.log.debug({ event: event }, 'new zone event');

            if (mod_jsprim.hasKey(WATCH_EVENTS, event.newstate)) {
                self.emit('zone_state', event.zonename, event.newstate);
            }
        }
    });

    S.on(self.stderr, 'readable', function () {
        var lines = [];
        var line;

        while ((line = self.stderr.read()) !== null) {
            lines.push(line.toString());
        }

        self.log.error({ stderr: lines.join('\n') },
            'zoneevent stderr output');
    });

    S.on(self.proc, 'exit', function (code, signal) {
        self.log.warn({
            code: code,
            signal: signal
        }, 'zoneevent exited; restarting');

        S.gotoState('init');
    });
};

ZoneEventFSM.prototype.state_stopped = function (S) {
    S.validTransitions([]);
};

ZoneEventFSM.prototype.stop = function () {
    this.emit('stopAsserted');
};


// --- Exports

/**
 * The WatcherFSM is responsible for collecting and managing information on
 * VMs, and debouncing our lookups so that we don't overload the system.
 *
 * In the future, once vminfod is available, we will want to support
 * subscribing to its updates whenever possible.
 */
function WatcherFSM(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.ok(['object', 'function']
        .indexOf(typeof (opts.vmadm)) !== -1, 'opts.vmadm');

    this.app = opts.app;
    this.log = opts.app.log.child({
        component: 'watcher'
    }, true);

    this.vmadm = opts.vmadm;
    this.zoneevent = new ZoneEventFSM({ log: opts.app.log });

    /*
     * Watch /etc/zones for updates to zone XML files. These files are modified
     * when most fields for a VM are altered.
     *
     * Note that changes _within_ the zone are not reflected here, since they
     * are not part of the VM configuration; this includes changes made with
     * route(1M), updates to /etc/resolv.conf to change nameservers, etc.
     */
    this.cfgwatcher = mod_fs.watch('/etc/zones', this.refresh.bind(this));

    mod_common.CommonFSM.call(this);
}
mod_util.inherits(WatcherFSM, mod_common.CommonFSM);

WatcherFSM.prototype.state_init = function (S) {
    S.gotoStateOn(this, 'startAsserted', 'refresh');
};

WatcherFSM.prototype.state_waiting = function (S) {
    var self = this;

    S.gotoStateOn(self, 'refreshAsserted', 'refresh');

    function scheduleRefresh() {
        self.refresh();
    }

    /*
     * Due to historical unreliable behavior of our two watchers and since they
     * don't alert on all relevant property changes (such as "routes"), we
     * periodically reload instance configurations.
     */
    S.timeout(STATE_WATCHER_TIMEOUT, scheduleRefresh);
    S.on(self.zoneevent, 'zone_state', scheduleRefresh);
};

WatcherFSM.prototype.state_refresh = function (S) {
    var self = this;

    S.on(self, 'refreshAsserted', function () {
        /*
         * If we get a refresh event during a refresh, then that means that our
         * `vmadm lookup` has taken more than 5 seconds for some reason. Rather
         * than run another lookup now and risk introducing further load on what
         * may be an already overloaded system, we'll reschedule the refresh.
         */
        self.log.warn('rescheduling VM information refresh due to ' +
            'already running "vmadm lookup"');
        self.refresh();
    });

    S.on(self.zoneevent, 'zone_state', function () {
        self.refresh();
    });

    function afterLookup(err, vms) {
        if (err) {
            self.log.error(err, 'failed to refresh VM information; retrying');
            S.gotoState('refresh');
            return;
        }

        self.app.updateVMs(vms);

        S.gotoState('waiting');
    }

    self.vmadm.lookup({}, {
        log: self.log,
        include_dni: true,
        fields: FIELDS
    }, S.callback(afterLookup));
};

WatcherFSM.prototype.start = function () {
    this.emit('startAsserted');
};

WatcherFSM.prototype.stop = function () {
    this.emit('stopAsserted');
};

WatcherFSM.prototype.refresh = function () {
    this.emitDelayed('refreshAsserted', REFRESH_DELAY);
};

module.exports = WatcherFSM;
