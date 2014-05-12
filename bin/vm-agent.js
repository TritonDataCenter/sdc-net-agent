/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * vm-agent.js
 */

var bunyan = require('bunyan');
var execFile = require('child_process').execFile;
var VM = require('/usr/vm/node_modules/VM');

var logLevel = (process.env.LOG_LEVEL || 'debug');
var logger = bunyan.createLogger({ name: 'vm-agent', level: logLevel });

var VmAgent = require('../lib/vm-agent');
var UpdateAgent = require('../lib/update-agent');

var config = {
    url: (process.env.VMAPI_URL || 'http://vmapi.coal.joyent.us'),
    log: logger
};

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

var updateAgent;
var VmAgent;

loadSysinfo(function (error, exitStatus, stdout, stderr) {
    if (error) {
        console.error('sysinfo error: ' + stderr.toString());
        process.exit(1);
    }

    // output of sysinfo is a JSON object
    var sysinfo = JSON.parse(stdout);

    // Use the UUID param to uniquely identify this machine on AMQP.
    if (!sysinfo.UUID) {
        console.error('Could not find "UUID" in `sysinfo` output.');
        process.exit(1);
    }

    config.uuid = sysinfo.UUID;

    var updateAgent = new UpdateAgent(config);
    config.updateAgent = updateAgent;

    var vmagent = new VmAgent(config);
    vmagent.start();
});

