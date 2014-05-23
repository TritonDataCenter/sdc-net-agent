/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * vm-agent.js
 */

var fs = require('fs');
var path = require('path');
var async = require('async');
var backoff = require('backoff');
var format = require('util').format;

var cp = require('child_process');
var spawn = cp.spawn;
var VM = require('/usr/vm/node_modules/VM');

// We want to watch when VMs have reached a specifc newstate. At the moment
// we only care if a VM has been stopped or is running
var watchEvents = {
    uninitialized: true,
    running: true
};

var VM_PATH = '/vms/%s';

function VmAgent(options) {
    this.options = options;
    this.updateAgent = options.updateAgent;
    this.log = options.log;
    this.sample = null;
    this.lastFullSample = null;
    this.uuid = options.uuid;

    // this watcher watches whether /etc/zones has changed
    this.cfg_watcher = null;

    // this is the subprocess that watches for zone changes
    this.watcher = null;
    // Array of uuids that the server knows about. Parsed from /etc/zones
    this.vms = [];
    // Hash that gets built by doing vmadm.lookup
    this.sample = {};
}


VmAgent.prototype.start = function() {
    this.startZoneWatcher();
    this.startZoneConfigWatcher();
    this.sendSample();
};


VmAgent.prototype.setSample = function(sample) {
    var self = this;

    Object.keys(sample).forEach(function (key) {
        self.sample[key] = sample[key];
    });
};


/*
 * When no vm argument is passed then we want to do vmadm.lookup but otherwise
 * use the provided object to send it over to the UpdateAgent
 */
VmAgent.prototype.sendSample = function(uuid, vm) {
    var self = this;
    var log = this.log;

    function queueUpdate(key, path, query, payload) {
        var message = {
            method: 'put',
            path: path,
            query: query,
            payload: payload
        };

        return function() {
            self.updateAgent.queueUpdate(key, message);
        };
    }

    // Since we are not doing any lookup (vm is now gone) we also setSample here
    if (vm !== undefined) {
        var newSample = {};
        newSample[uuid] = vm;
        self.setSample(newSample);
        queueUpdate(uuid, format(VM_PATH, uuid), {}, vm)();
        return;
    }

    this.updateSample(uuid, function (err, sample) {
        if (err) {
            log.error(err, 'updateSample failed, cannot sendSample');
            return;
        }

        // Update current sample with the new uuids we just looked up
        self.setSample(sample);

        if (self.updateAgent) {
            if (uuid) {
                queueUpdate(uuid, format(VM_PATH, uuid), {}, sample[uuid])();
            } else {
                queueUpdate(
                    self.uuid,
                    '/vms',
                    { server_uuid: self.uuid },
                    { vms: sample }
                )();
            }
        }
    });
};


/*
 *
 *  Sample format that gets loaded from vmadm.lookup:
 *
 *    {
 *    '70ac24a6-962a-4711-92f6-6dc6a53ea59e':
 *    { uuid: '70ac24a6-962a-4711-92f6-6dc6a53ea59e',
 *       owner_uuid: '930896af-bf8c-48d4-885c-6573a94b1853',
 *       quota: 25,
 *       max_physical_memory: 128,
 *       zone_state: 'running',
 *       state: 'running',
 *       brand: 'joyent-minimal',
 *       cpu_cap: 100,
 *       last_modified: '2014-04-29T23:30:17.000Z' },
 *    '9181f298-a867-49c6-9f34-d57584e7047e':
 *     { uuid: '9181f298-a867-49c6-9f34-d57584e7047e',
 *       owner_uuid: '930896af-bf8c-48d4-885c-6573a94b1853',
 *       quota: 25,
 *       max_physical_memory: 1024,
 *       zone_state: 'running',
 *       state: 'running',
 *       brand: 'joyent-minimal',
 *       cpu_cap: 300,
 *       last_modified: '2014-04-29T23:36:33.000Z' } },
 *       ...
 *       ...
 *   }
 */

VmAgent.prototype.updateSample = function (uuid, callback) {
    var self = this;
    var log = this.log;

    if (typeof (uuid) === 'function') {
        callback = uuid;
        uuid = undefined;
    }

    var newSample;

    function lookup(cb) {
        // If we fail a lookup, newSample gets reset on every retry
        newSample = {};
        var searchOpts = {};
        var query;

        if (uuid) {
            searchOpts.uuid = uuid;
            query = 'uuid=' + uuid;
        } else {
            query = 'uuid=*';
        }

        log.debug('Starting updateSample ' + query);

        VM.lookup(searchOpts, { full: true }, function (err, vmobjs) {
            var vmobj;
            var running = 0;
            var notRunning = 0;
            var nonInventory = 0;

            if (err) {
                log.error(err, 'ERROR: unable update VM list');
                return cb(err);

            } else {
                for (vmobj in vmobjs) {
                    vmobj = vmobjs[vmobj];
                    if (!vmobj.do_not_inventory) {
                        newSample[vmobj.uuid] = vmobj;
                        if (vmobj.zone_state === 'running') {
                            running++;
                        } else {
                            notRunning++;
                        }
                    } else {
                        nonInventory++;
                    }
                }

                var lookupResults = {
                    running: running,
                    notRunning: notRunning,
                    nonInventory: nonInventory
                };
                log.trace(lookupResults, 'Lookup query results');

                return cb(null);
            }
        });
    }

    function logAttempt(aLog, host) {
        function _log(number, delay) {
            var level;
            if (number === 0) {
                level = 'info';
            } else if (number < 5) {
                level = 'warn';
            } else {
                level = 'error';
            }
            aLog[level]({
                ip: host,
                attempt: number,
                delay: delay
            }, 'updateSample retry attempt');
        }

        return (_log);
    }

    var retry = backoff.call(lookup, function (err) {
        retry.removeAllListeners('backoff');

        var attempts = retry.getResults().length;
        if (err) {
            log.error('Could not updateSample after %d attempts', attempts);
            return callback(err);
        }

        self.lastFullSample = (new Date()).getTime() / 1000;

        return callback(null, newSample);
    });

    var retryOpts = { initialDelay: 200, maxDelay: 2000 };
    retry.setStrategy(new backoff.ExponentialStrategy({
        initialDelay: retryOpts.initialDelay,
        maxDelay: retryOpts.maxDelay
    }));

    retry.failAfter(5);
    retry.on('backoff', logAttempt(log));
    retry.start();
};


VmAgent.prototype.startZoneWatcher = function () {
    var log = this.log;
    var self = this;
    var watcher = this.watcher = spawn(
        '/usr/vm/sbin/zoneevent',
        [],
        {'customFds': [-1, -1, -1]}
    );

    log.info('zoneevent running with pid ' + watcher.pid);
    watcher.stdout.on('data', function (data) {
        log.trace('zone event: ', data.toString());

        // There can be more than one event in a single data event
        var events = data.toString().split('\n');
        events.forEach(function (event) {
            if (event === '') return;

            event = JSON.parse(event);
            // Only updateSample when it is an event we're watching
            if (watchEvents[event.newstate]) {
                log.debug('zone event for %s newstate: %s',
                    event.zonename, event.newstate);
                self.sendSample(event.zonename);
            }
        });
    });

    watcher.stdin.end();

    watcher.on('exit', function (code) {
        log.warn('zoneevent watcher exited.');
        watcher = null;
    });
};


VmAgent.prototype.startZoneConfigWatcher = function () {
    var log = this.log;
    var self = this;

    this.cfg_watcher = fs.watch('/etc/zones', function (evt, file) {
        // When we get here something changed in /etc/zones and if that happens
        // it means that something has changed about one of the zones and in
        // turn it means that we need to recheck.
        log.debug('fs.watch event on /etc/zones');
        self.checkZoneConfigChanges();
    });

    log.info('started fs.watch() for /etc/zones');
};


VmAgent.prototype.checkZoneConfigChanges = function () {
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
            return;
        }

        async.forEachSeries(files, eachFile, asyncCallback);
    }

    function eachFile(file, next) {
        var matches = XML_FILE_RE.exec(file);
        if (matches === null) {
            return next();
        }

        var uuid = matches[1];
        var p = path.join('/etc/zones', file);

        newVms.push(uuid);

        fs.stat(p, function (statErr, stats) {
            if (statErr) {
                return next(statErr);
            }

            var mtime = stats.mtime.getTime() / 1000;
            if (self.lastFullSample < mtime) {
                changed.push(uuid);
            }
            return next();
        });
    }

    function asyncCallback(asyncErr) {
        if (asyncErr) {
            log.error(asyncErr, 'Could not read file stats');
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

        // Else at least one VM changed and at least one destroyed
        destroyed.forEach(function (uuid) {
            var vm = self.sample[uuid];
            if (!vm) {
                log.warn('VM %s appears to have gone away but ' +
                    'self.sample doesn\'t have it', uuid);
                return;
            }

            log.info('Found a destroyed VM %s', uuid);
            vm.state = 'destroyed';
            self.sendSample(uuid, vm);
        });

        // If one ore more XMLs have changed we want to updateSample for
        // either a single VM or all VMs (when 2 ore more change)
        if (changed.length === 1) {
            self.sendSample(changed[0]);
        } else if (changed.length > 1) {
            self.sendSample();
        }
    }
};

module.exports = VmAgent;
