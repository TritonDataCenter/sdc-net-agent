/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * net-agent.js
 */

var fs = require('fs');
var path = require('path');
var async = require('async');
var backoff = require('backoff');
var format = require('util').format;

var cp = require('child_process');
var spawn = cp.spawn;
var exec = cp.exec;
var VM = require('/usr/vm/node_modules/VM');
var NAPI = require('sdc-clients').NAPI;

// We want to watch when VMs have reached a specifc newstate. At the moment
// we only care if a VM has been stopped or is running
var watchEvents = {
    uninitialized: true,
    running: true
};

var ANTI_SPOOF_FIELDS = ['allow_dhcp_spoofing', 'allow_ip_spoofing',
    'allow_mac_spoofing', 'allow_restricted_traffic',
    'allow_unfiltered_promisc'];

var VM_PATH = '/vms/%s';

function NetAgent(options) {
    this.options = options;
    this.log = options.log;
    this.sample = null;
    this.lastFullSample = null;
    this.uuid = options.uuid;

    this.napi = new NAPI({
        url: options.url,
        log: options.log
    });

    // this watcher watches whether /etc/zones has changed
    this.cfg_watcher = null;

    // this is the subprocess that watches for zone changes
    this.watcher = null;
    // Array of uuids that the server knows about. Parsed from /etc/zones
    this.vms = [];
    // Hash that gets built by doing vmadm.lookup
    this.sample = {};
    // Serial queues for sending VM updates serially
    this.queues = {};
}


NetAgent.prototype.start = function () {
    var log = this.log;
    var self = this;

    // Wrap our initial full sample in a retry-backoff
    var fn = this.sendFullSample.bind(this);

    this.retryUpdate(fn, { uuid: this.uuid }, function (err) {
        if (err) {
            log.error(err, 'Failed retry-backoff for initial sendFullSample');
            return;
        }

        log.info('Initial NICs state was successfully sent. Good to go');

        self.startZoneWatcher();
        self.startZoneConfigWatcher();
    });
};


NetAgent.prototype.setSample = function (sample) {
    var self = this;

    Object.keys(sample).forEach(function (key) {
        self.sample[key] = sample[key];
    });
};


/*
 * On startup, sendFullSample updates all NICs for all VMs on the server. This
 * will be a blocking call before we turn on the event listeners so we allow
 * net-agent to report the full state of the server first
 */
NetAgent.prototype.sendFullSample = function (callback) {
    var self = this;
    var log = this.log;

    this.updateSample({}, function (err, sample) {
        if (err) {
            log.error(err, 'updateSample failed, cannot sendFullSample');
            callback(err);
            return;

        } else if (Object.keys(sample).length === 0) {
            log.warn('empty sample returned by vmadm lookup');
            callback();
            return;
        }

        self.setSample(sample);

        async.forEachSeries(Object.keys(sample), function (uuid, cb) {
            var options = {
                uuid: uuid,
                vm: sample[uuid]
            };

            self._updateVmNics(options, cb);
        },
        function (asyncErr) {
            if (asyncErr) {
                log.error(asyncErr, 'Could not sendFullSample');
                return callback(err);
            }
            return callback();
        });
    });
};


/*
 * sendSample accepts options.server to indicate this is a full server sample
 */
NetAgent.prototype.sendSample = function (options, callback) {
    var self = this;
    var log = this.log;

    // if vm was destroyed else vmadm lookup
    if (options.cachedVm && options.cachedVm.state === 'destroyed') {
        this.setSample({ uuid: options.cachedVm });
        this.checkDestroyed(options.uuid, function (err, destroyed) {
            if (err) {
                log.error(err, 'Error checking %s for destroyed', options.uuid);
                callback(err);

            } else if (destroyed) {
                log.info('Found a destroyed VM %s', options.uuid);
                self._updateVmNics(options, callback);

            } else {
                log.info('VM %s appeared to be destroyed but it\'s not',
                    options.uuid);
                callback();
            }
        });

    } else {
        this.updateSample(options, function (err, sample) {
            if (err) {
                log.error(err, 'updateSample failed, cannot sendSample');
                callback(err);

            } else if (Object.keys(sample).length === 0) {
                log.warn('empty sample returned by vmadm lookup');
                 callback();
            } else {
                self.setSample(sample);
                options.vm = sample[options.uuid];
                self._updateVmNics(options, callback);
            }
        });
    }
};


/*
 * Some helper functions
 */

function _simpleMerge(a, b) {
    if (!a || typeof (a) !== 'object') {
        throw new TypeError('First object is required (object)');
    }
    if (!b || typeof (b) !== 'object') {
        throw new TypeError('Second object is required (object)');
    }

    var newA = clone(a);
    var bkeys = Object.keys(b);

    bkeys.forEach(function (key) {
        newA[key] = b[key];
    });

    return newA;
}


function _clone(obj) {
    if (null === obj || 'object' != typeof (obj)) {
        return obj;
    }

    var copy = obj.constructor();

    for (var attr in obj) {
        if (obj.hasOwnProperty(attr)) {
            copy[attr] = obj[attr];
        }
    }
    return copy;
}


function _sanitizeBooleanAntiSpoof(nic) {
    function booleanFromValue(value) {
        if (value === 'false' || value === '0') {
            return false;
        } else if (value === 'true' || value === '1') {
            return true;
        } else {
            // else should be boolean
            return value;
        }
    }

    ANTI_SPOOF_FIELDS.forEach(function (field) {
        if (nic[field] !== undefined) {
            nic[field] = booleanFromValue(nic[field]);
        }
    });
}


function _nicChanged(cur, old) {
    var fields = [ 'vlan_id', 'nic_tag', 'primary', 'ip', 'netmask',
        'status' ].concat(ANTI_SPOOF_FIELDS);
    var field;
    var diff = false;

    for (var i = 0; i < fields.length; i++) {
        field = fields[i];
        if (cur[field] !== old[field]) {
            diff = true;
            break;
        }
    }

    return diff;
}


function _createNicPayload(vm, currentNic) {
    var newNic = _clone(currentNic);

    newNic.check_owner = false;
    newNic.owner_uuid = vm.owner_uuid;
    newNic.belongs_to_uuid = vm.uuid;
    newNic.belongs_to_type = 'zone';

    if (newNic.vlan_id === undefined) {
        newNic.vlan_id = 0;
    }
    newNic.vlan = newNic.vlan_id;
    _sanitizeBooleanAntiSpoof(newNic);

    return newNic;
}


/*
 * Updates each of the VM NICs
 *
 * - options.cachedVm: what net-agent currently knows about the VM
 * - options.vm: what net-agent has loaded from vmadm
 */
NetAgent.prototype._updateVmNics = function (options, callback) {
    var self = this;
    var log = this.log;
    var napi = this.napi;
    var cachedVm = options.cachedVm;
    var uuid = options.uuid;

    var allNics = [];
    // options.vm might be undefined if we didn't get anything from vmadm
    // lookup i.e. the vm is destroyed now
    if (options.vm) {
        options.vm.nics.forEach(function (nic) {
            allNics.push(nic);
        });
    }

    // First time net-agent runs its cache will be empty
    if (options.cachedVm) {
        options.cachedVm.nics.forEach(function (cachedNic) {
            // When VM is destroyed just mark all NICs are destroyed
            if (options.cachedVm.state === 'destroyed') {
                cachedNic.destroyed = true;
                allNics.push(cachedNic);
                return;
            }

            // If a cached NIC cannot be found on the sampled VM object then
            // we can assume it has been deleted from the VM
            var filtered = options.vm && options.vm.nics.filter(function (nic) {
                return nic.mac === cachedNic.mac;
            });

            if (!filtered.length) {
                cachedNic.destroyed = true;
                allNics.push(cachedNic);
            }
        });
    }

    if (!allNics.length) {
        log.info('VM %s has no NICs to update', uuid);
        return callback();
    }

    // Calls out to NAPI to verify the current NIC data. Three things can happen
    // 1. NIC was removed from the VM
    // 2. NIC doesn't exist and needs to be added
    // 3. NIC exists and has to be udpated
    // 4. NIC exists and but has not changed, no need to do anything
    async.forEachSeries(allNics, function (vmNic, cb) {
        napi.getNic(vmNic.mac, function (err, napiNic) {
            if (err) {
                if (err.name === 'ResourceNotFoundError') {
                    napiNic = undefined;
                } else {
                    return cb(err);
                }
            }

            if (vmNic.destroyed) {
                _deleteNic(vmNic, cb);
                return;
            }

            // Set the status on the NIC before calling nicChanged
            var vm = options.vm;
            vmNic.status = (vm.state === 'running' ? 'running' : 'stopped');

            if (!napiNic) {
                _addNic(vmNic, cb);
            } else if (_nicChanged(vmNic, napiNic)) {
                _updateNic(vmNic, napiNic, cb);
            } else {
                log.info('NIC (mac=%s, ip=%s, status=%s) unchanged for VM %s',
                    vmNic.mac, vmNic.ip, vmNic.status, uuid);
                cb();
            }
        });
    }, callback);

    function _addNic(vmNic, cb) {
        var newNic = _createNicPayload(options.vm, vmNic);

        napi.createNic(newNic.mac, newNic, function (err) {
            if (err) {
                log.error(err, 'Could not add NIC %s for VM %s',
                    newNic.mac, uuid);
                return cb(err);
            }

            log.info('NIC (mac=%s, ip=%s, status=%s) added for VM %s',
                newNic.mac, newNic.ip, newNic.status, uuid);
            return cb();
        });
    }

    function _updateNic(vmNic, napiNic, cb) {
        var newNic = _createNicPayload(options.vm, vmNic);

        for (var i = 0; i < ANTI_SPOOF_FIELDS.length; i++) {
            var field = ANTI_SPOOF_FIELDS[i];
            if (napiNic.hasOwnProperty(field) && !vmNic.hasOwnProperty(field)) {
                newNic[field] = false;
            }
        }

        napi.updateNic(newNic.mac, newNic, function (err) {
            if (err) {
                log.error(err, 'Could not udpate NIC %s for VM %s',
                    newNic.mac, uuid);
                return cb(err);
            }

            log.info('NIC (mac=%s, ip=%s, status=%s) updated for VM %s',
                newNic.mac, newNic.ip, newNic.status, uuid);
            return cb();
        });
    }

    function _deleteNic(vmNic, cb) {
        napi.deleteNic(vmNic.mac, function (err) {
            if (err) {
                if (err.name === 'ResourceNotFoundError') {
                    log.info('NIC (mac=%s, ip=%s) already gone for VM %s',
                        vmNic.mac, vmNic.ip, uuid);
                    return cb();
                } else {
                    log.error(err, 'Could not delete NIC %s for VM %s',
                        vmNic.mac, uuid);
                    return cb(err);
                }
            }

            log.info('NIC (mac=%s, ip=%s) deleted for VM %s',
                vmNic.mac, vmNic.ip, uuid);
            return cb();
        });
    }
};


/*
 * Initializes the serial queue for a single uuid and pushes the item to be
 * processed.
 */
NetAgent.prototype.pushSample = function (options) {
    var uuid = options.uuid || this.uuid;

    if (this.queues[uuid] === undefined) {
        this.queues[uuid] = this.createQueue(uuid);
    }

    this.queues[uuid].push(options);
};


/*
 * Retries an update operation.
 */
NetAgent.prototype.retryUpdate = function (fn, options, callback) {
    var self = this;
    var log = this.log;
    var retryOpts = { initialDelay: 2000, maxDelay: 64000 };

    function logAttempt(aLog, host) {
        function _log(number, delay, err) {
            var level;
            if (number === 0) {
                level = 'info';
            } else if (number < 5) {
                level = 'warn';
            } else {
                level = 'error';
            }

            aLog.error(err, 'sendSample retry error for %s', options.uuid);
            aLog[level]({
                ip: host,
                attempt: number,
                sendUpdate: delay
            }, 'sendSample retry attempt for %s', options.uuid);
        }

        return (_log);
    }

    var retry = backoff.call(fn, function (err) {
        retry.removeAllListeners('backoff');

        var attempts = retry.getResults().length;

        if (err) {
            log.error({ uuid: options.uuid },
                'Could not sendSample after %d attempts', attempts);
            return callback(err);
        }

        return callback();
    });

    retry.setStrategy(new backoff.ExponentialStrategy({
        initialDelay: retryOpts.initialDelay,
        maxDelay: retryOpts.maxDelay
    }));

    retry.failAfter(retryOpts.retries || Infinity);
    retry.on('backoff', logAttempt(log));

    retry.start();
};


/*
 * Initializes a serial queue for a uuid
 */
NetAgent.prototype.createQueue = function (uuid) {
    var self = this;
    var log = this.log;

    var queue = async.queue(function (opts, callback) {
        var fn = self.sendSample.bind(self, opts);
        self.retryUpdate(fn, opts, function (err) {
            if (err) {
                log.error(err, 'Error updating NICs %', uuid);
                return callback(err);
            }

            return callback();
        });
    }, 1);

    queue.drain = function () {
        log.trace('serial queue for %s has been drained', uuid);
    };

    queue.saturated = function () {
        log.trace('serial queue for % has been saturated', uuid);
    };

    return queue;
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

NetAgent.prototype.updateSample = function (options, callback) {
    var self = this;
    var log = this.log;
    var uuid = options.uuid;

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


/*
 * Calls zoneadm list -pc in order to confirm that a VM is really destroyed
 * when its zone xml has been moved/renamed
 */
NetAgent.prototype.checkDestroyed = function (uuid, callback) {
    var cmd = '/usr/sbin/zoneadm list -pc | grep ' + uuid + ' || true';
    exec(cmd, [], function (exitStatus, stdout, stderr) {
        if (exitStatus) {
            return callback(new Error(stderr.toString()));
        }

        var destroyed = (stdout.toString().trim() === '');
        return callback(null, destroyed);
    });
};


NetAgent.prototype.startZoneWatcher = function () {
    var log = this.log;
    var self = this;
    var watcher = this.watcher = spawn(
        '/usr/vm/sbin/zoneevent',
        [],
        {'customFds': [-1, -1, -1]});

    log.info('zoneevent running with pid ' + watcher.pid);
    watcher.stdout.on('data', function (data) {
        log.trace('zone event: ', data.toString());

        // There can be more than one event in a single data event
        var events = data.toString().split('\n');
        events.forEach(function (event) {
            if (event === '') {
                return;
            }

            event = JSON.parse(event);
            // Only updateSample when it is an event we're watching
            if (watchEvents[event.newstate]) {
                log.debug('zone event for %s newstate: %s',
                    event.zonename, event.newstate);
                self.pushSample({
                    uuid: event.zonename,
                    cachedVm: self.sample[event.zonename]
                });
            }
        });
    });

    watcher.stdin.end();

    watcher.on('exit', function (code) {
        log.warn('zoneevent watcher exited.');
        watcher = null;
    });
};


NetAgent.prototype.startZoneConfigWatcher = function () {
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


NetAgent.prototype.checkZoneConfigChanges = function () {
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
            next();
            return;
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

            vm.state = 'destroyed';
            self.pushSample({ uuid: uuid, cachedVm: vm });
        });

        changed.forEach(function (uuid) {
            self.pushSample({
                uuid: uuid,
                cachedVm: self.sample[uuid]
            });
        });
    }
};

module.exports = NetAgent;
