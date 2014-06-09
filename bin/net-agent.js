/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * net-agent.js
 */

var bunyan = require('bunyan');
var async = require('async');
var execFile = require('child_process').execFile;
var VM = require('/usr/vm/node_modules/VM');

var logLevel = (process.env.LOG_LEVEL || 'debug');
var logger = bunyan.createLogger({ name: 'vm-agent', level: logLevel });

var NetAgent = require('../lib');

var config = { log: logger };
var sdcConfig;
var sysinfo;

process.on('uncaughtException', function (e) {
    console.error('uncaught exception:' + e.message);
    console.log(e.stack);
});

function loadConfig(callback) {
    execFile('/bin/bash', ['/lib/sdc/config.sh', '-json'],
        function _loadConfig(err, stdout, stderr) {
            if (err) {
                logger.fatal(err, 'Could not load config: ' + stderr);
                return callback(err);
            }

            try {
                sdcConfig = JSON.parse(stdout); // intentionally global
            } catch (e) {
                logger.fatal(e, 'Could not parse config: ' + e.message);
                return callback(e);
            }

            return callback(null);
        });
}

// Run the sysinfo script and return the captured stdout, stderr, and exit
// status code.
function loadSysinfo(callback) {
    execFile('/usr/bin/sysinfo', [], function (err, stdout, stderr) {
        if (err) {
            logger.fatal('Could not load sysinfo: ' + stderr.toString());
            return callback(err);
        }

        try {
            sysinfo = JSON.parse(stdout);
        } catch (e) {
            logger.fatal(e, 'Could not parse sysinfo: ' + e.message);
            return callback(e);
        }

        return callback(null);
    });
}


async.waterfall([
    loadConfig,
    loadSysinfo
], function (err) {
    if (err) {
        logger.fatal('Failed to initialize vm-agent configuration');
        process.exit(1);
    }

    if (!sysinfo.UUID) {
        logger.fatal('Could not find "UUID" in `sysinfo` output.');
        process.exit(1);
    }

    config.uuid = sysinfo.UUID;
    var napi_url = 'http://' + sdcConfig.napi_domain;
    config.url = (process.env.NAPI_URL || napi_url);

    if (!config.url) {
        logger.fatal('config.url is required');
        process.exit(1);
    }

    var vmagent = new NetAgent(config);
    vmagent.start();
});
