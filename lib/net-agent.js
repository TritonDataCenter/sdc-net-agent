/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

/*
 * Net-Agent and NAPI
 * ==================
 *
 * VM Change Events
 * ----------------
 *
 * Net-agent's job is to inform NAPI of any changes to any NICs that result
 * from VM-related events. For instance, if a VM gets destroyed (either by
 * VMAPI or an operator tool like vmadm or zoneadm) net-agent is responsible
 * for telling NAPI that the NIC that used to belong to that VM should be
 * destroyed.
 *
 * Net-agent responds to 4 kinds of changes to a VM:
 *
 *  - The VM's zone_state has changed
 *  - The VM's zone configurations XML file has changed
 *  - The VM's state has changed
 *  - The VM has been destroyed
 *
 * Whenever a change is detected, net-agent walks its internal list of VM
 * objects (which also contains the NIC info) and pushes the NIC objects to
 * NAPI, forcing NAPI to overwrite the current NIC object with the same MAC
 * address.
 *
 * Orphaned NICs
 * -------------
 *
 * One cannot assume that net-agent is continuously reacting to every single
 * event on a compute node (CN). For example net-agent may be disabled by an
 * operator, may go down due to an error, or may not receive an event (it
 * happens). To handle these situations, when net-agent starts up it scans
 * every NIC on the CN[1], and tells NAPI to delete any NIC if it does not have
 * a corresponding VM (that is not destroyed). This is only done once on
 * startup because such a scan can be very expensive.
 *
 * [1]: Currently we scan every NIC in the DC, since NAPI doesn't allow us to
 * filter NICs by compute node. But as soon as it does, we will switch to that
 * (see NAPI-360).  This means that we have to ignore NICs that have a
 * `cn_uuid` different from the agent's.
 *
 * Net-Agent and Compute Nodes
 * ===========================
 *
 * The previous section described the interaction between a single net-agent
 * service and a single NAPI service. However, we always have more than one
 * net-agent. In fact we have one net-agent per CN. All of these net-agents
 * react only to VM events on their respective CNs. However, they are modifying
 * global NIC objects, and they all connect to a single NAPI service (this may
 * change in the future). It is important to keep this mind. We don't want all
 * of our net-agents to start battering NAPI with requests at the same time.
 * For the change-event-related requests this is not a problem. However, for
 * the orphaned-nic-related requests, this could be catastrophic. This is why
 * we insert a random delay before the searchNics request that is no greater
 * than 10 minutes.
 *
 * Net-Agent and VMs
 * =================
 *
 * Net-Agent loads all of VMs that are located on the same CN as it is, by
 * executing `vmadm lookup`, and storing the VM objects in memory. This set of
 * VM objects is known as the sample.
 *
 * Net-Agent listens for VM events by executing a child `zoneevent` command,
 * and processing the JSON that it produces on stdout. `zoneevent` emits output
 * whenever a property of the zone has changed. Note that it does not report
 * higher-level VM properties (that are used by vmadm and vmapi).
 *
 * As Net-Agent receives these change events, it updates the changed properties
 * of the VM objects in the sample. However, it is possible that one of the
 * change-events does not make it to net-agent. In order to mitigate the drift
 * between net-agent's picture of reality, and reality itself, net-agent also
 * does a full `vmadm lookup` every minute, and emits state-change events if it
 * detects a difference.
 */

var async = require('async');
var vasync = require('vasync');
var backoff = require('backoff');
var restify = require('restify');
var assert = require('assert-plus');
var endpoints = require('./endpoints');

var VM = require('./vm');
var vmadm = require('vmadm');
var NAPI = require('./napi-client');
var mod_jsprim = require('jsprim');
var common = require('./common');
var VError = require('verror');


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
    this.reapNicsTimeout = undefined;
    this.reapFinished = false;
    /* The below delays are in microseconds */
    this.reapNicsLongDelay = 60 * 60 * 1000;
    var min_timeout = 2 * 60 * 1000;
    var max_timeout = 10 * 60 * 1000;
    this.reapNicsStartupDelay = Math.floor(Math.random() * (max_timeout -
        min_timeout + 1)) + min_timeout;
    /* The 2 delays below are in millisconds */
    this.reapNicsInitDelay = 2000;
    this.reapNicsMaxDelay = 64000;
    this.na_server = null;
    this.na_epoch = process.hrtime();
    this.na_init_history = [];

    var userAgent = 'net-agent/' + this.version +
        ' (' + 'node/' + process.versions.node + ')' +
        ' server/' + this.uuid;

    this.napiClient = new NAPI({
        url: options.url,
        log: options.log,
        userAgent: userAgent,
        uuid: options.uuid
    });

    this.eventWatcher = VM.createEventWatcher({
        log: options.log
    });

    // Hash that gets built by doing vmadm.lookup
    this.sample = {};
    // Serial queues for sending VM updates serially
    this.queues = {};
}

NetAgent.prototype.history = function history(name) {
    var delta = mod_jsprim.hrtimeMicrosec(process.hrtime(this.na_epoch));
    this.na_init_history.push({
        h_name: name,
        h_time: delta
    });
};

/*
 * This function initializes the restify HTTP server.
 * Currently, it temporarily listens on port 5311, until we nail down a proper
 * port-allocation policy for SDC's agents.
 */
NetAgent.prototype.initializeServer = function (callback) {
    var self = this;
    self.na_server = restify.createServer({
        log: self.log,
        name: 'Net Agent',
        version: '0.0.1'
    });
    function populateReq(req, res, next) {
        req.app = self;
        next();
    }
    endpoints.registerEndpoints(self.na_server, self.log.child({
        component: 'restify'
    }), [ populateReq ]);

    self.na_server.listen(5311, callback);
};


NetAgent.prototype.start = function (callback) {
    var self = this;
    var log = this.log;

    this.history('InitializingServer');
    this.initializeServer(function (err) {
        if (err) {
            callback(new VError(err, 'could not initialize server'));
            return;
        }
        self.history('InitializingEventWatcher');
        self.initializeEventWatcher();
        self.history('InitializedEventWatcher');

        // Wrap our initial full sample in a retry-backoff
        var opts = { uuid: self.uuid };
        var fn = self.sendFullSample.bind(self, opts);
        self.retryUpdate(fn, opts, function onRetry(err2) {
            if (err2) {
                log.error(err2, 'Failed retry-backoff ' +
                    'for initial sendFullSample');
                return;
            }

            log.info('Initial NICs state was successfully sent. Good to go');
            callback();
        });
    });
};

/*
 * Called on startup. Function asks NAPI for all allocated NICs.  It uses this
 * list to detect leaked NICs by querying for NICs that are allocated,
 * unreserved, belong to type 'zone', and not assigned to any existing VM. It
 * emits a leaked_nic event, which net-agent responds to by destroying the NIC.
 */
NetAgent.prototype.reapNics = function () {
    var self = this;

    assert.object(this.napiClient, 'this.napiClient');
    assert.object(this.napiClient.log);
    var log = this.napiClient.log;
    var napiClient = this.napiClient;
    var cn_uuid = this.uuid;
    /*
     * We get the list of NICs on this CN from NAPI.
     */
    function search_nics_cb(err, nics) {
        /*
         * We can get an error for the following reasons:
         *
         *      -we provided an invalid parameter to the endpoint
         *      -the /search/nics endpoint does not exist
         *
         * The former would be indicative of a bug in SDC, specifically
         * net-agent (as we should always be passing valid params). The latter
         * would be indicative of an outdated version of NAPI. If either of
         * these things happen, we don't initiate any kind of reap. If NAPI
         * gets upgraded, this will be detected after a very long backoff.
         */
        if (err) {
            if (err.body.code === 'InvalidParameters') {
                log.error('Invalid params passed to /search/nics');
                self.history('SkippedReapNics');
            } else if (err.body.code === 'ResourceNotFound') {
                log.info('Old version of NAPI does not support /search/nics');
                self.history('BackedOffReapNics');
                setTimeout(self.reapNics.bind(self), self.reapNicsLongDelay);
            }
            return;
        }
        if (self.sample.length > 0) {
            self.sample.forEach(function backfill_walk_sample(vm) {
                if (vm.nics.length === 0) {
                    return;
                }
                var nicsToUpdate = [];
                vm.nics.forEach(function vm_nics(vmnic) {
                    var found = nics.filter(function find_mac(nic) {
                        return (vmnic.mac === nic.mac);
                    });
                    if (found.length === 0) {
                        vmnic.cn_uuid = vm.server_uuid;
                        vmnic.state = 'running';
                        nicsToUpdate.push(vmnic);
                    }
                });
                self.napiClient.updateNics(vm, nicsToUpdate, function
                    upnics_cb(err2, res) {

                    if (err2) {
                        log.error('updateNics failed during backfill.');
                    }
                });
            });
        }
        var leaked_nics = nics.filter(function scan_nics(nic) {
            if (nic.belongs_to_type !== 'zone') {
                return (false);
            }
            if (self.sample[nic.belongs_to_uuid]) {
                return (false);
            }
            return (true);
        });

        self.history('StartedReapNics');
        function reap_nic(nic, cb) {
            /*
             * Currently, the implementation of deleteNic only looks at the
             * UUID of the VM. If we are in this function, we know that the
             * VM itself no longer exists, which is why we don't have a
             * complete VM object. If deleteNic starts accessing other vm
             * members in the future, we will have to add them to the
             * `targ_vm` obj below.
             */
            var targ_vm = { uuid: nic.belongs_to_uuid };
            napiClient.deleteNic(targ_vm, nic,
                function handle_delete_nic(err2, res2) {

                /*
                 * If we get an error when trying to delete a NIC, the pipeline
                 * that we are running in (see below), will stop. So, retrying
                 * only the delete requests that fail is impossible. So,
                 * instead, we will want to restart the entire reap process.
                 */
                if (err2) {
                    log.error(err2, 'Error while deleting NIC');
                    self.reapNics();
                    cb(err2);
                    return;
                }
                cb(null, res2);
                return;
            });
        }

        vasync.forEachPipeline({
            'func': reap_nic,
            'inputs': leaked_nics
        }, function (err2, res) {
            if (err2) {
                log.error(err2, 'Error in vasync reap-pipeline');
            }
        });

    }
    var retry = backoff.call(napiClient.searchNics.bind(napiClient),
        { cn_uuid: cn_uuid }, search_nics_cb);
    retry.retryIf(function (err) {
        return (err.body.code !== 'InvalidParameters' &&
                err.body.code !== 'ResourceNotFound');
    });
    retry.setStrategy(new backoff.ExponentialStrategy({
        initialDelay: self.reapNicsInitDelay,
        maxDelay: self.reapNicsMaxDelay
    }));
    retry.start();
};

/*
 * Initializes the EventWatcher event listeners
 */
NetAgent.prototype.initializeEventWatcher = function () {
    var self = this;
    var log = this.log;
    var eventWatcher = this.eventWatcher;

    eventWatcher.on('state', function vm_state_event(uuid, state) {
        log.debug('state event for %s state: %s', uuid, state);
        self.pushSample({
            uuid: uuid,
            cachedVm: self.sample[uuid]
        });
    });

    eventWatcher.on('zone_state', function zone_state_event(uuid, zone_state) {
        log.debug('zone_state event for %s newstate: %s', uuid, zone_state);
        self.pushSample({
            uuid: uuid,
            cachedVm: self.sample[uuid]
        });
    });

    eventWatcher.on('zone_xml', function zone_xml_event(uuid) {
        log.debug('fs.watch event on /etc/zones for %s', uuid);
        self.pushSample({
            uuid: uuid,
            cachedVm: self.sample[uuid]
        });
    });

    eventWatcher.on('destroyed', function zone_destroyed_event(uuid) {
        var vm = self.sample[uuid];
        if (!vm) {
            log.warn('VM %s appears to have gone away but ' +
                'self.sample doesn\'t have it', uuid);
            return;
        }

        log.info('Found a destroyed VM %s', uuid);
        vm.state = 'destroyed';
        self.pushSample({
            uuid: uuid,
            cachedVm: vm
        });
    });

    eventWatcher.on('err', function zone_err_event(err) {
        log.error(err, 'eventWatcher saw en error');
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

    function startEventWatchers() {
        self.history('StartingEventWatcher');
        self.eventWatcher.updateState(self.sample);
        self.eventWatcher.lastCfgEvent = self.lastFullSample;
        self.eventWatcher.start();
        self.history('StartedEventWatcher');
    }

    function doReapNics() {
        /*
         * If we fail to sendFullSample, this function will get retried. If we
         * have already initiated a delayed reapNics() call, we don't want to
         * re-initiate it.
         */
        if (self.reapNicsTimeout === undefined) {
            self.reapNicsTimeout = setTimeout(function () {
                self.reapNics();
            }, self.reapNicsStartupDelay);
        }
    }

    this.updateSample({}, function (err, sample) {
        if (err) {
            log.error(err, 'updateSample failed, cannot sendFullSample');
            callback(err);
            return;
        } else if (Object.keys(sample).length === 0) {
            log.warn('Empty sample returned by vmadm lookup');
            startEventWatchers();
            doReapNics();
            callback();
            return;
        }

        self.setSample(sample);
        startEventWatchers();
        doReapNics();

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
        var destSample = {};
        destSample[options.uuid] = options.cachedVm;
        this.setSample(destSample);
        this.eventWatcher.removeState(options.uuid);

        self._updateVmNics(options, callback);
    } else {
        this.updateSample(options, function (err, sample) {
            if (err) {
                log.error(err, 'updateSample failed, cannot sendSample');
                callback(err);
            } else if (Object.keys(sample).length === 0) {
                log.warn('empty sample returned by vmadm lookup');
                callback();
            } else {
                self.eventWatcher.updateState(sample);
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
    common.assertStrictOptions('_updateVmNics', options, {
        uuid: 'string',
        vm: 'optionalObject',
        cachedVm: 'optionalObject'
    });
    var log = this.log;

    var allNics = [];

    assert.uuid(this.uuid, 'this.uuid');

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
    assert.object(options);
    assert.uuid(options.uuid);
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

    var retry = backoff.call(fn, function backoffCallCb(err) {
        retry.removeAllListeners('backoff');

        var attempts = retry.getNumRetries();

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

    var queue = async.queue(function qcb(opts, callback) {
        var fn = self.sendSample.bind(self, opts);
        self.retryUpdate(fn, opts, function retryUpdateCb(err) {
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
    if (!this._sampleQueue)
        this._sampleQueue = async.queue(updateSample.bind(this), 8);

    this._sampleQueue.push(options, callback);
};

function updateSample(options, callback) {
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

        vmadm.lookup(searchOpts, { log: log }, function (err, vmobjs) {
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
                log.info(lookupResults, 'Lookup query results');

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

        var attempts = retry.getNumRetries();
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
}


module.exports = NetAgent;
