var fs = require('fs');
var path = require('path');
var async = require('async');
var sprintf = require('sprintf').sprintf;
var restify = require('restify');
var backoff = require('backoff');
// var assert = require('assert');
var bunyan = require('bunyan');

var cp = require('child_process');
var exec = cp.exec;
var execFile = cp.execFile;
var spawn = cp.spawn;
var VM = require('/usr/vm/node_modules/VM');

var debug = !!process.env.DEBUG;

var logger = bunyan.createLogger({ name: 'vm-agent', level: 'debug' });

var config = {
    vmapi: 'vmapi.coal.joyent.us',
    log: logger
};

// We want to watch when VMs have reached a specifc newstate. At the moment
// we only care if a VM has been stopped or is running
var watchEvents = {
    uninitialized: true,
    running: true
};

if (debug) {
    console.log('debug mode');
}

process.on('uncaughtException', function (e) {
    console.error('uncaught exception:' + e.message);
    console.log(e.stack);
});

// Run the sysinfo script and return the captured stdout, stderr, and exit
// status code.
function loadSysinfo(callback) {
    execFile('/usr/bin/sysinfo', [], function (exitStatus, stdout, stderr) {
        if (exitStatus) {
            return callback(new Error(stderr), exitStatus, stdout, stderr);
        }

        return callback(
            undefined, exitStatus,
            stdout.toString().trim(), stderr.toString().trim());
    });
}

function VmAgent(options) {
    this.options = options;
    this.updater = options.updateAgent;
    this.log = options.log;
    this.sample = null;
    this.lastFullSample = null;

    // this watcher watches whether /etc/zones has changed
    this.cfg_watcher = null;

    // this is the subprocess that watches for zone changes
    this.watcher = null;
}

VmAgent.prototype.init = function(callback) {
    var self = this;

    // soon: init restify, etc here

    self.setUUID(callback);
};

VmAgent.prototype.setUUID = function(callback) {
    var self = this;

    if (debug) {
        self.serverUUID = '550e8400-e29b-41d4-a716-446655440000';
        process.nextTick(function () {
            callback();
        });
    } else {
        loadSysinfo(function (error, exitStatus, stdout, stderr) {
            if (error) {
                callback(new Error('sysinfo error: ' + stderr.toString()));
            }

            // output of sysinfo is a JSON object
            var sysinfo = JSON.parse(stdout);

            // Use the UUID param to uniquely identify this machine on AMQP.
            if (!sysinfo.UUID) {
                callback(new Error('Could not find "UUID" in `sysinfo` ' +
                    'output.'));
            }
            self.serverUUID = sysinfo.UUID;
            return callback();
        });
    }
};

VmAgent.prototype.start = function() {
    this.startZoneWatcher();
    this.startZoneConfigWatcher();
    this.updateSample();
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

// We lock the samplerLock while we're updating so that we don't do two
// lookups at the same time.
var samplerLock = false;
var updateSampleAttempts = 0;
var updateSampleAttemptsMax = 5;

VmAgent.prototype.updateSample = function (uuid) {
    var self = this;
    var log = this.log;
    var newSample = {};

    if (samplerLock) {
        updateSampleAttempts++;

        if (updateSampleAttempts === updateSampleAttemptsMax) {
            log.error(
                'ERROR: Something bad happened: samplerLock was held for ' +
                updateSampleAttemptsMax + ' consecutive attempts. Exiting.');
            process.exit(1);
        }
        log.error(
            'ERROR: samplerLock is still held, skipping update. Attempt #' +
            updateSampleAttempts);
        return;
    }

    updateSampleAttempts = 0;
    samplerLock = true;

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
        var hbVm;
        var running = 0;
        var newStatus;
        var notRunning = 0;
        var nonInventory = 0;

        // Lock only while .lookup is running
        samplerLock = false;

        if (err) {
            // retry-backoff
            log.error(err, 'ERROR: unable update VM list');
            return self.updateSample(uuid);

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

            self.sample = newSample;
            self.lastFullSample = (new Date()).getTime() / 1000;
        }
    });
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
                self.updateSample(event.zonename);
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

    fs.readdir('/etc/zones', function (err, files) {
        if (err) {
            log.error(err, 'Could not read /etc/zones');
            return;
        }

        async.forEachSeries(files, function (file, next) {
            var matches = XML_FILE_RE.exec(file);
            if (matches === null) {
                return next();
            }

            var p = path.join('/etc/zones', file);

            fs.stat(p, function (statErr, stats) {
                if (statErr) {
                    return next(statErr);
                }

                var mtime = stats.mtime.getTime() / 1000;
                if (self.lastFullSample < mtime) {
                    changed.push(matches[1]);
                }
                return next();
            });

        }, function (asyncErr) {

            if (asyncErr) {
                log.error(asyncErr, 'Could not read file stats');
                return;
            }

            // If one ore more XMLs have changed we want to updateSample for
            // either a single VM or all VMs (when 2 ore more change)
            if (changed.length > 0) {
                if (changed.length === 1) {
                    self.updateSample(changed[0]);
                } else {
                    self.updateSample();
                }
            }
        });
    });
};




// UpdateAgent


function UpdateAgent(options) {
    this.options = options;
    this.log = options.log;

    this.concurrency = options.concurrency || 50;
    this.retry = options.retry || { initialDelay: 2000, maxDelay: 64000};
    this.retryDelay = 1000;

    // When items are pushed to the queue, they are stored here so clients
    // can update the payloads of the objects while UpdateAgent is doing
    // retry-backoff cycles for them. Example scenario: corrupt VM data and
    // VMAPI is refusing to update, then VM gets fixed and retry works
    this.stash = {};

    this.client = restify.createJsonClient({ url: options.url });
    this.initializeQueue();
}


/*
 * Initializes the UpdateAgent queue
 */
UpdateAgent.prototype.initializeQueue = function () {
    var self = this;
    var log = this.log;

    var queue = this.queue = async.queue(function (uuid, callback) {
        var message = self.stash[uuid];

        // If there was an error sending this update then we need to add it to
        // the retry/backoff cycle
        self.sendUpdate(uuid, message, function (err, req, res, obj) {
            if (err) {
                setTimeout(self.retryUpdate.bind(self, uuid), self.retryDelay);
                return callback(err);
            }

            // Remove from stash
            delete self.stash[uuid];
            callback();
        });

    }, this.concurrency);

    queue.drain = function () {
        log.trace('UpdateAgent queue has been drained');
    };

    queue.saturated = function () {
        log.trace('UpdateAgent queue has been saturated');
    };
};


/*
 * Retries an update operation.
 */
UpdateAgent.prototype.retryUpdate = function (uuid) {
    var self = this;
    var log = this.log;
    var retryOpts = this.retry;

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
            }, 'UpdateAgent retry attempt for VM %s', hb.uuid);
        }

        return (_log);
    }

    // Always get the latest value from the stash
    function update(cb) {
        self.sendUpdate(uuid, self.stash[uuid], cb);
    }

    var retry = backoff.call(update, function (err) {
        retry.removeAllListeners('backoff');

        var attempts = retry.getResults().length;

        if (err) {
            log.info('Could not send update after %d attempts', attempts);
            return;
        }

        log.info('Update successfully sent after %d attempts', attempts);
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
 * Sends an update. Clients that use UpdateAgent must conform to the following
 * object format:
 *
 * {
 *   uuid: <uuid>,
 *   path: <API endpoint>,
 *   method: <HTTP method>,
 *   payload: <payload>
 * }
 */
UpdateAgent.prototype.sendUpdate = function (uuid, message, callback) {
    if (message.method !== 'post' || message.method !== 'put') {
        process.nextTick(function () {
            callback(new Error('Unsupported update method'));
        });
    }

    this.client[message.method].call(
        this.client,
        message.path,
        message.payload,
        callback
    );
};


/*
 * Queues an update message to be sent.
 */
UpdateAgent.prototype.queueUpdate = function (uuid, message) {
    var self = this;

    function onUpdateCompleted(err) {
        self.log.trace('UpdateAgent queue task completed');
    }

    // Only add to queue when there is no item in the stash. This means that
    // stash has stuff when queue is being processed or item is in a retry-
    // backoff cycle
    var exists = (this.stash[uuid] !== undefined);

    // Update stash before pusing to queue
    this.stash[uuid] = message;

    if (!exists) {
        this.queue.push(uuid, onUpdateCompleted);
    }
};



var updateAgent = new UpdateAgent(config);
config.updater = updateAgent;

var vmagent = new VmAgent(config);

vmagent.init(function (err) {
    if (err) {
        logger.error(err, 'Error initializing vmagent');
        process.exit(1);
    }
    vmagent.start();
});


