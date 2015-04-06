/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Functions for interacting with vmadm
 */

var cp = require('child_process');
var execFile = cp.execFile;
var exec = cp.exec;
var spawn = cp.spawn;
var assert = require('assert');
var util = require('util');
var fs = require('fs');
var path = require('path');
var EventEmitter = require('events').EventEmitter;

var async = require('async');

var VMADM = '/usr/sbin/vmadm';



function isLocal(vms, vm) {
    for (var v in vms) {
        if (vms[v].uuid == vm.uuid) {
            return vms[v];
        }
    }

    return null;
}


function listVMs(filter, fields, callback) {
    if (!callback) {
        callback = fields;
        fields = undefined;
    }

    var args = ['lookup', '-j'];
    for (var k in filter) {
        args.push(k + '=' + filter[k]);
    }
    if (fields) {
        args.push('-o', fields.join(','));
    }

    return execFile(VMADM, args, {maxBuffer: 32 * 1024 * 1024},
        function (err, stdout, stderr) {

        if (err) {
            err.stdout = stdout;
            err.stderr = stderr;
            return callback(err);
        }

        var vms;

        try {
            vms = JSON.parse(stdout);
        } catch (jsonErr) {
            jsonErr.stdout = stdout;
            return callback(jsonErr);
        }

        return callback(null, vms);
    });
}


// These are the events being watched by the zoneevent watcher. When zones
// don't switch to these zone_states we ignore them
var watchEvents = {
    uninitialized: true,
    running: true
};

var STATE_WATCHER_TIMEOUT = 30000;

/*
 * The EventWatcher will emit these events:
 *
 * - zone_state: The zone_state of a VM has changed
 * - zone_xml: The XML file modified timestamp of a zone has changed
 * - destroyed: A VM has been destroyed
 * - state: The state of a VM has changed
 */
function EventWatcher(options) {
    this.log = options.log;

    EventEmitter.call(this);

    // Array of uuids that the watcher knows about
    this.vms = [];
    // Hash of vm states used by the state watcher
    this.vmStates = {};

    // Watches changes on /etc/zones
    this.lastCfgEvent = null;
    this.cfgWatcher = null;

    // Watches changes on zoneevent
    this.zoneeventWatcher = null;
}

util.inherits(EventWatcher, EventEmitter);


EventWatcher.prototype.start = function () {
    this.startZoneConfigWatcher();
    this.startZoneWatcher();
    this.startStateWatcher();
};


/*
 * Accepts an object with a uuid:vmobj format. The vmobj format only needs to
 * to have the state and zone_state as keys
 */
EventWatcher.prototype.updateState = function (objs) {
    var self = this;

    Object.keys(objs).forEach(function (uuid) {
        self.vmStates[uuid] = {
            state: objs[uuid].state,
            zone_state: objs[uuid].zone_state
        };
    });
};


EventWatcher.prototype.getState = function (uuid) {
    return this.vmStates[uuid];
};


EventWatcher.prototype.removeState = function (uuid) {
    delete this.vmStates[uuid];
};


/*
 * State watcher will fix incorrect states due to improper behavior of our
 * other two watchers. All these watchers are not reliable for many reasons
 * and this entire code base will be replaced with vminfod in the near future.
 * By having a state watcher that fix states every X seconds we can guarantee
 * that VMs have an incorrect state for at most X seconds.
 */
EventWatcher.prototype.startStateWatcher = function () {
    var self = this;
    var log = this.log;

    function onLookup(err, vmobjs) {
        if (err) {
            log.error(err, 'Unable to run stateWatcher lookup');
            setTimeout(lookup, STATE_WATCHER_TIMEOUT);
            return;
        }

        vmobjs.forEach(function (vm) {
            // Only use inventory vms
            if (vm.do_not_inventory) {
                return;
            }

            // Don't emit when states stay the same
            var current = self.getState(vm.uuid);
            if (current && current.state === vm.state &&
                current.zone_state === vm.zone_state) {
                return;
            }

            self.emit('state', vm.uuid, vm.state, vm.zone_state);

            var newState = {};
            newState[vm.uuid] = {
                state: vm.state,
                zone_state: vm.zone_state
            };
            self.updateState(newState);
        });

        setTimeout(lookup, STATE_WATCHER_TIMEOUT);
    }

    var lookup = listVMs.bind(null,
        {}, ['uuid', 'state', 'zone_state', 'do_not_inventory'], onLookup);

    lookup();
};


EventWatcher.prototype.startZoneWatcher = function () {
    var log = this.log;
    var self = this;

    var watcher = this.zoneeventWatcher = spawn(
        '/usr/vm/sbin/zoneevent',
        [],
        {'customFds': [-1, -1, -1]});

    log.info('zoneevent running with pid ' + watcher.pid);

    function onData(data) {
        log.trace('zone event: ', data.toString());

        // There can be more than one event in a single data event
        var events = data.toString().split('\n');
        events.forEach(processEvent);
    }

    function processEvent(event) {
        if (event === '') {
            return;
        }

        event = JSON.parse(event);

        // Only updateSample when it is an event we're watching
        if (watchEvents[event.newstate]) {
            self.emit('zone_state', event.zonename, event.newstate);
        }
    }

    watcher.stdout.on('data', onData);
    watcher.stdin.end();
    watcher.on('exit', function (code) {
        log.warn('zoneevent watcher exited.');
        watcher = null;
    });
};


EventWatcher.prototype.startZoneConfigWatcher = function () {
    var log = this.log;
    var self = this;

    this.cfgWatcher = fs.watch('/etc/zones', function (evt, file) {
        // When we get here something changed in /etc/zones and if that happens
        // it means that something has changed about one of the zones and in
        // turn it means that we need to recheck.
        log.trace('fs.watch event on /etc/zones');

        self.checkZoneConfigChanges();
    });

    log.info('started fs.watch() for /etc/zones');
};


EventWatcher.prototype.checkZoneConfigChanges = function () {
    var log = this.log;
    var self  = this;

    /*JSSTYLED*/
    var XML_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.xml$/;
    var changed = [];
    var newVms = [];

    fs.readdir('/etc/zones', onReaddir);

    function onReaddir(err, files) {
        if (err) {
            log.error(err, 'Could not read /etc/zones');
            self.emit(err);
            return;
        }

        async.forEachSeries(files, eachFile, asyncCallback);
    }

    function eachFile(file, next) {
        var matches = XML_FILE_RE.exec(file);
        if (matches === null) {
            next();
            return;
        }

        var uuid = matches[1];
        var p = path.join('/etc/zones', file);

        fs.stat(p, function (statErr, stats) {
            if (statErr && statErr.code && statErr.code === 'ENOENT') {
                log.warn('%s file no longer present, ignoring error', p);
                return next();
            } else if (statErr) {
                return next(statErr);
            }

            // Only push to newVms array when fs.stat confirms that the file is
            // there. This avoids a race condition on destroy/reprovision
            newVms.push(uuid);

            var mtime = stats.mtime.getTime() / 1000;
            if (self.lastCfgEvent !== null && self.lastCfgEvent < mtime) {
                changed.push(uuid);
            }
            return next();
        });
    }

    function asyncCallback(asyncErr) {
        if (asyncErr) {
            log.error(asyncErr, 'Could not read file stats');
            self.emit(asyncErr);
            return;
        }

        // Check if any of the existing VMs is no longer in the server. In
        // this case we just send the full sample so VMAPI can check which
        // VMs have been destroyed
        var destroyed = [];
        for (var i = 0; i < self.vms.length; i++) {
            if (newVms.indexOf(self.vms[i]) === -1) {
                log.info('VM %s no longer in /etc/zones', self.vms[i]);
                destroyed.push(self.vms[i]);
            }
        }
        self.vms = newVms;

        // Emit an event for each VM that appears to be destroyed
        destroyed.forEach(function (uuid) {
            checkDestroyed(uuid, function (err, isDestroyed) {
                if (err) {
                    log.error(err, 'Error checking %s for destroyed', uuid);
                    self.emit(err);
                } else if (isDestroyed) {
                    self.emit('destroyed', uuid);
                }
            });
        });

        // Emit an event for each VM for which zone XML has changed
        changed.forEach(function (uuid) {
            self.emit('zone_xml', uuid);
        });

        // Update this timestamp so next time we check if files have changed
        // since the last time
        self.lastCfgEvent = (new Date()).getTime() / 1000;
    }
};


/*
 * Double-checks if a VM is actually destroyed
 */
function checkDestroyed(uuid, callback) {
    var cmd = '/usr/sbin/zoneadm list -pc | grep ' + uuid + ' || true';
    exec(cmd, [], function (exitStatus, stdout, stderr) {
        if (exitStatus) {
            return callback(new Error(stderr.toString()));
        }

        var destroyed = (stdout.toString().trim() === '');
        return callback(null, destroyed);
    });
}


function createEventWatcher(options) {
    assert.ok(options.log, 'EventWatcher options.log');

    return new EventWatcher(options);
}


module.exports = {
    isLocal: isLocal,
    list: listVMs,
    createEventWatcher: createEventWatcher
};
