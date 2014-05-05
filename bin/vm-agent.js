var fs = require('fs');
var path = require('path');
var async = require('async');
var sprintf = require('sprintf').sprintf;

var cp = require('child_process');
var exec = cp.exec;
var execFile = cp.execFile;
var spawn = cp.spawn;
var VM = require('/usr/vm/node_modules/VM');

var debug = !!process.env.DEBUG;

var config = {
    vmapi: 'vmapi.coal.joyent.us'
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
 *  sample format:
 *  {
 *    'zoneStatus': [
 *      [0, 'global', 'running', '/', '', 'liveimg', 'shared', '0'],
 *      [2, '91f8fb10-2c22-441e-9a98-84244b44e5e9', 'running',
 *      '/zones/91f8fb10-2c22-441e-9a98-84244b44e5e9',
 *        '91f8fb10-2c22-441e-9a98-84244b44e5e9', 'joyent', 'excl', '1'],
 *      [27, '020a127a-d79d-41eb-aa12-ffd30da81887', 'running',
 *      '/zones/020a127a-d79d-41eb-aa12-ffd30da81887',
 *        '020a127a-d79d-41eb-aa12-ffd30da81887', 'kvm', 'excl', '14']
 *    ],
 *    'zpoolStatus': [
 *      ['zones', '1370.25G', '41.35G', 'ONLINE']
 *    ],
 *    'timestamp': 1328063128.01,
 *    'meminfo': {
 *      'availrmem_bytes': 40618254336,
 *      'arcsize_bytes': 5141061712,
 *      'total_bytes': 51520827392
 *    }
 *  }
 */

// We lock the samplerLock while we're updating so that we don't do two
// lookups at the same time.
var samplerLock = false;
var updateSampleAttempts = 0;
var updateSampleAttemptsMax = 5;

VmAgent.prototype.updateSample = function (uuid) {
    var self = this;
    var newSample = {};

    if (samplerLock) {
        updateSampleAttempts++;

        if (updateSampleAttempts === updateSampleAttemptsMax) {
            console.error(
                'ERROR: Something bad happened: samplerLock was held for ' +
                updateSampleAttemptsMax + ' consecutive attempts. Exiting.');
            process.exit(1);
        }
        console.error(
            'ERROR: samplerLock is still held, skipping update. Attempt #' +
            updateSampleAttempts);
        return;
    }

    updateSampleAttempts = 0;
    samplerLock = true;

    var vms;

    // newline and timestamp when we *start* an update
    process.stdout.write('\n[' + (new Date()).toISOString() + '] ');

    async.series([
        function (cb) {
            var searchOpts = {};
            if (uuid) {
                searchOpts.uuid = uuid;
                process.stdout.write('z');
            } else {
                process.stdout.write('Z');
            }

            VM.lookup(searchOpts, { full: true }, function (err, vmobjs) {
                var vmobj;
                var hbVm;
                var running = 0;
                var newStatus;
                var notRunning = 0;
                var nonInventory = 0;

                if (err) {
                    console.log(
                        'ERROR: unable update VM list: ' + err.message);
                    return cb(new Error('unable to update VM list.'));
                } else {
                    vms = {};
                    newSample.vms = {};

                    for (vmobj in vmobjs) {
                        vmobj = vmobjs[vmobj];
                        vms[vmobj.uuid] = vmobj;
                        if (!vmobj.do_not_inventory) {
                            hbVm = {
                                uuid: vmobj.uuid,
                                owner_uuid: vmobj.owner_uuid,
                                quota: vmobj.quota,
                                max_physical_memory: vmobj.max_physical_memory,
                                zone_state: vmobj.zone_state,
                                state: vmobj.state,
                                brand: vmobj.brand,
                                cpu_cap: vmobj.cpu_cap
                            };
                            newStatus = [
                                vmobj.zoneid ? vmobj.zoneid : '-',
                                vmobj.zonename,
                                vmobj.zone_state,
                                vmobj.zonepath,
                                vmobj.uuid,
                                vmobj.brand,
                                'excl',
                                vmobj.zoneid ? vmobj.zoneid : '-'
                            ];
                            if (vmobj.hasOwnProperty('last_modified')) {
                                // this is only conditional until all platforms
                                // we might run this heartbeater on support the
                                // last_modified property.
                                hbVm.last_modified = vmobj.last_modified;
                                newStatus.push(vmobj.last_modified);
                            }
                            newSample.vms[vmobj.uuid] = hbVm;
                            if (vmobj.zone_state === 'running') {
                                running++;
                            } else {
                                notRunning++;
                            }
                        } else {
                            nonInventory++;
                        }
                    }

                    process.stdout.write('(' + running + ',' + notRunning);
                    if (nonInventory > 0) {
                        process.stdout.write(',' + nonInventory);
                    }
                    process.stdout.write(')');
                    return cb();
                }
            });
        },
        function (cb) { // timestamp
            newSample.timestamp = (new Date()).getTime() / 1000;
            cb();
        }
        ], function (err) {
            samplerLock = false;

            if (err) {
                // retry-backoff
                console.log('ERROR: ' + err.message);
                self.updateSample(uuid);
            } else {
                self.sample = newSample;
                self.lastFullSample = newSample.timestamp;
            }
        });
};


VmAgent.prototype.startZoneWatcher = function () {
    var self = this;
    var watcher = this.watcher = spawn(
        '/usr/vm/sbin/zoneevent',
        [],
        {'customFds': [-1, -1, -1]}
    );

    console.log('INFO: zoneevent running with pid ' + watcher.pid);
    watcher.stdout.on('data', function (data) {
        process.stdout.write('e');

        // There can be more than one event in a single data event
        var events = data.toString().split('\n');
        events.forEach(function (event) {
            if (event === '') return;

            event = JSON.parse(event);
            // Only updateSample when it is an event we're watching
            if (watchEvents[event.newstate]) {
                process.stdout.write('C');
                self.updateSample(event.zonename);
            }
        });
    });

    watcher.stdin.end();

    watcher.on('exit', function (code) {
        console.log('WARN: zoneevent watcher exited.');
        watcher = null;
    });
};


VmAgent.prototype.startZoneConfigWatcher = function () {
    var self = this;

    this.cfg_watcher = fs.watch('/etc/zones', function (evt, file) {
        // When we get here something changed in /etc/zones and if that happens
        // it means that something has changed about one of the zones and in
        // turn it means that we need to recheck.
        process.stdout.write('c');
        self.checkZoneConfigChanges();
    });
    console.log('INFO: start fs.watch() for /etc/zones');
};


VmAgent.prototype.checkZoneConfigChanges = function () {
    var self  = this;

    /*JSSTYLED*/
    var XML_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.xml$/;
    var changed = [];

    fs.readdir('/etc/zones', function (err, files) {
        if (err) {
            console.error('Could not read /etc/zones: ' + err.toString());
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
                console.error('Could not read file stats: ' +
                    asyncErr.toString());
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


var vmagent = new VmAgent(config);
vmagent.init(function (err) {
    if (err) {
        console.error('Error initializing vmagent: ' + err.toString());
        process.exit(1);
    }
    vmagent.start();
});

// function sendSample() {
//     if (sample) {
//         if (debug) {
//             console.log('Sending sample: ' + JSON.stringify(sample));
//         }
//         process.stdout.write('.');
//     } else {
//         if (debug) {
//             console.log('NOT Sending NULL sample');
//         }
//     }
// }

