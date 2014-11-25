/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * net-agent.js
 */

var path = require('path');
var fs = require('fs');
var bunyan = require('bunyan');
var async = require('async');
var execFile = require('child_process').execFile;
var VM = require('/usr/vm/node_modules/VM');

var logLevel = (process.env.LOG_LEVEL || 'debug');
var logger = bunyan.createLogger({ name: 'net-agent', level: logLevel });

var NetAgent = require('../lib');

var config = { log: logger };
var sdcConfig;
var agentConfig;
var sysinfo;

process.on('uncaughtException', function (e) {
    console.error('uncaught exception:' + e.message);
    console.log(e.stack);
});

function loadConfig(callback) {
    var configPath = '/opt/smartdc/agents/etc/net-agent.config.json';

    try {
        agentConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
        logger.error(e, 'Could not parse agent config: "%s", '
            + 'attempting to load from /lib/sdc/config.sh now', e.message);
    }

    return callback(null);
}

// If we are unable to read a config-agent managed configuration, then we
// have to rely on sdc/config.sh and turn off no_rabbit
function loadSdcConfig(callback) {
    if (agentConfig !== undefined) {
        callback();
        return;
    }

    execFile('/bin/bash', ['/lib/sdc/config.sh', '-json'],
        function _loadConfig(err, stdout, stderr) {
            if (err) {
                logger.fatal(err, 'Could not load sdc config: ' + stderr);
                return callback(err);
            }

            try {
                sdcConfig = JSON.parse(stdout);
                agentConfig = {
                    napi: { url: 'http://' + sdcConfig.napi_domain },
                    no_rabbit: false
                };
            } catch (e) {
                logger.fatal(e, 'Could not parse sdc config: ' + e.message);
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
    loadSdcConfig,
    loadSysinfo
], function (err) {
    if (err) {
        logger.fatal('Failed to initialize net-agent configuration');
        process.exit(1);
    }

    if (!sysinfo.UUID) {
        logger.fatal('Could not find "UUID" in `sysinfo` output.');
        process.exit(1);
    }

    config.uuid = sysinfo.UUID;
    config.url = agentConfig.napi.url;

    if (!config.url) {
        logger.fatal('config.url is required');
        process.exit(1);
    }

    var netagent;
    if (agentConfig.no_rabbit) {
        netagent = new NetAgent(config);
        netagent.start();
    } else {
        logger.warn('"no_rabbit" flag is not true, net-agent will now sleep');
        setInterval(function () {}, Math.POSITIVE_INFINITY);
    }
});
