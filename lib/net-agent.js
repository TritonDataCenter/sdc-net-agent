/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * net-agent.js
 */

var fs = require('fs');
var path = require('path');
var async = require('async');
var backoff = require('backoff');

var cp = require('child_process');
var spawn = cp.spawn;
var exec = cp.exec;
var VM = require('/usr/vm/node_modules/VM');
var NAPI = require('./napi-client');

// We want to watch when VMs have reached a specifc newstate. At the moment
// we only care if a VM has been stopped or is running
var watchEvents = {
    uninitialized: true,
    running: true
};

var _versionCache = null;
function getNetAgentVersion() {
    if (_versionCache === null) {
        _versionCache = require('../package.json').version;
    }
    return _versionCache;
}

function NetAgent(options) {
    this.options = options;
    this.log = options.log;
    this.sample = null;
    this.lastFullSample = null;
    this.uuid = options.uuid;
    this.version = getNetAgentVersion();

    var userAgent = 'net-agent/' + this.version +
        ' (' + 'node/' + process.versions.node + ')' +
        ' server/' + this.uuid;

    this.napiClient = new NAPI({
        url: options.url,
        log: options.log,
        userAgent: userAgent
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
    var opts = { uuid: this.uuid };
    var fn = this.sendFullSample.bind(this, opts);
    this.retryUpdate(fn, opts, function (err) {
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
NetAgent.prototype.sendFullSample = function (opts, callback) {
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
                return callback(asyncErr);
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
 * Updates each of the VM NICs
 *
 * - options.cachedVm: what net-agent currently knows about the VM
 * - options.vm: what net-agent has loaded from vmadm
 *
 * When options.vm is undefined, it means that the VM has been destroyed because
 * options.vm gets populated from the vmadm lookup results. We always store the
 * last VM object known to net-agent as options.cachedVm
 *
 * When options.cachedVm is undefined, then this is the first time we see that
 * VM (or our net-agent has just started)
 */
NetAgent.prototype._updateVmNics = function (options, callback) {
    var log = this.log;
    var allNics = [];

    if (options.vm) {
        options.vm.nics.forEach(function (nic) {
            // When VM is failed just mark all NICs are destroyed
            if (options.vm.state === 'failed') {
                nic.destroyed = true;
            }
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
        log.info('VM %s has no NICs to update', options.uuid);
        callback();
        return;
    }

    var vm = options.vm || options.cachedVm;

    this.napiClient.updateNics(vm, allNics, callback);
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

            aLog.error(err, 'retry error for %s', options.uuid);
            aLog[level]({
                ip: host,
                attempt: number,
                delay: delay
            }, 'retry attempt for %s', options.uuid);
        }

        return (_log);
    }

    var retry = backoff.call(fn, function (err) {
        retry.removeAllListeners('backoff');

        var attempts = retry.getResults().length;

        if (err) {
            log.error({ uuid: options.uuid },
                'Could not retry operation after %d attempts', attempts);
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
