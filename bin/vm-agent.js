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

// We want to watch when VMs have reached a specifc newstate. At the moment
// we only care if a VM has been stopped or is running
var watchEvents = {
    uninitialized: true,
    running: true
};

var lastFullSample;

// The current sample is stored here and we lock the samplerLock while we're
// updating so that we don't do two lookups at the same time.
var sample = null;
var samplerLock = false;

// this watcher watches whether /etc/zones has changed
var cfg_watcher = null;

// this is the subprocess that watches for zone changes
var watcher = null;

if (debug) {
    console.log('debug mode');
}

var connection;

process.on('uncaughtException', function (e) {
    console.error('uncaught exception:' + e.message);
    console.log(e.stack);
});

function readConfig(callback) {
    // execFile('/usr/node/bin/node',
    //     [ '/opt/smartdc/agents/bin/amqp-config' ],
    //     function (error, stdout, stderr) {
    //         if (error) {
    //             return callback(new Error(stderr.toString()));
    //         }
    //         var config = {};
    //         stdout = stdout.toString().trim().split('\n');
    //         stdout.forEach(function (line) {
    //             var kv = line.split('=');
    //             config[kv[0]] = kv[1];
    //         });
    //         return callback(null, config);
    //     });
}

function onReady() {

    function setUUID(uuid, systype) {
        setupStatusInterval(uuid);
    }

    if (debug) {
        return setUUID('550e8400-e29b-41d4-a716-446655440000');
    } else {
        return loadSysinfo(function (error, exitStatus, stdout, stderr) {
            if (error) {
                throw (new Error('sysinfo error: ' + stderr.toString()));
            }

            // output of sysinfo is a JSON object
            var sysinfo = JSON.parse(stdout);

            // Use the UUID param to uniquely identify this machine on AMQP.
            if (!sysinfo.UUID) {
                throw new Error('Could not find "UUID" in `sysinfo` output.');
            }
            setUUID(sysinfo.UUID, sysinfo['System Type']);
        });
    }
}

function connect() {
    // get config
    onReady();
    startZoneWatcher();
    startZoneConfigWatcher();
    updateSample();
}

// Connect now!
connect();

function setupStatusInterval(uuid) {
    // POST /status
}


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


var updateSampleAttempts = 0;
var updateSampleAttemptsMax = 5;


function updateSample(uuid) {
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
                console.log('ERROR: ' + err.message);
                updateSample(uuid);
            } else {
                sample = newSample;
                lastFullSample = sample.timestamp;
            }
        });
}

function startZoneWatcher() {
    watcher = spawn('/usr/vm/sbin/zoneevent', [], {'customFds': [-1, -1, -1]});
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
                updateSample(event.zonename);
            }
        });
    });
    watcher.stdin.end();

    watcher.on('exit', function (code) {
        console.log('WARN: zoneevent watcher exited.');
        watcher = null;
    });
}

function startZoneConfigWatcher() {
    checkZoneConfigChanges();
    cfg_watcher = fs.watch('/etc/zones', function (evt, file) {
        // When we get here something changed in /etc/zones and if that happens
        // it means that something has changed about one of the zones and in
        // turn it means that we need to recheck.
        process.stdout.write('c');
        checkZoneConfigChanges();
    });
    console.log('INFO: start fs.watch() for /etc/zones');
}

function checkZoneConfigChanges() {
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
                if (lastFullSample < mtime) {
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
                    updateSample(changed[0]);
                } else {
                    updateSample();
                }
            }
        });
    });
}


function sendSample() {
    if (sample) {
        if (debug) {
            console.log('Sending sample: ' + JSON.stringify(sample));
        }
        process.stdout.write('.');
    } else {
        if (debug) {
            console.log('NOT Sending NULL sample');
        }
    }
}

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
